import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { db, resetTestDatabase, closeRelationalPool } from "./postgres-test-db";
import { activeGenerationCount, generationCapacity } from "../src/lib/generation-capacity";
import { admitGeneration, type GenerationAdmissionInput } from "../src/lib/generation-admission";
import { usageAuthority } from "../src/modules/usage";

const now = new Date().toISOString();
const request: GenerationAdmissionInput = {
  userId: "owner", projectId: "canvas", nodeId: "new", prompt: "Portrait",
  model: { id: "nano-banana-2", mediaType: "image", providerPath: "nano-banana-2" },
  references: [], operation: "generation", aspectRatio: "1:1", resolution: "1K", duration: "5",
  generateAudio: false, hasVideoInput: false, inputVideoDurationSeconds: 0,
};
beforeEach(async () => {
  await resetTestDatabase();
  await db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES ('owner','owner@example.test','Owner',?,?)").run(now, now);
  for (const space of ["space", "other"]) {
    await db.prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(space, space, now, now);
  }
  await db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES ('space','owner','owner',?)").run(now);
  for (const [id, workspace] of [["canvas", "space"], ["second-canvas", "space"], ["foreign-canvas", "other"]]) {
    await db.prepare("INSERT INTO projects (id,workspace_id,name,graph_json,created_at,updated_at) VALUES (?,?,?,'{}',?,?)").run(id, workspace, id, now, now);
  }
  const authority = await usageAuthority();
  mock.method(authority, "summary", async () => ({ usageMode: "unmetered", profileId: "test", profileName: "Test", used: 0, limit: 0, remaining: 0, assistantEnabled: true, generationConcurrency: 2, version: 1, updatedAt: now }));
});
afterEach(() => mock.restoreAll());
after(closeRelationalPool);

async function generation(id: string, status: string, project = "canvas", workspace = "space", outputUrl: string | null = null) {
  await db.prepare("INSERT INTO generations (id,project_id,usage_workspace_id,node_id,prompt,status,output_url,created_at,updated_at) VALUES (?,?,?,?,'Portrait',?,?,?,?)").run(id, project, workspace, id, status, outputUrl, now, now);
}

test("capacity includes other canvases in the workspace but excludes terminal outputs and other workspaces", async () => {
  await generation("running", "running");
  await generation("queued", "queued", "second-canvas");
  await generation("foreign", "running", "foreign-canvas", "other");
  for (const status of ["failed", "fail", "error", "cancelled", "canceled", "completed", "complete", "succeeded", "success"]) await generation(status, status.toUpperCase());
  await generation("has-output", "running", "canvas", "space", "/finished.png");
  assert.equal(await activeGenerationCount("space"), 2);
  assert.deepEqual(await generationCapacity("owner", "canvas"), { concurrency: 2, available: 0, retryAfterMs: 3000 });
  await db.prepare("UPDATE generations SET status='completed' WHERE id='running'").run();
  assert.equal((await generationCapacity("owner", "canvas"))?.available, 1);
  assert.equal(await generationCapacity("owner", "foreign-canvas"), null);
  assert.equal(await generationCapacity("owner", "missing"), null);
});

test("capacity and locked admission agree without reserving credits for a full workspace", async () => {
  const authority = await usageAuthority();
  const reserve = mock.method(authority, "reserveGeneration", async () => true);
  await generation("one", "running");
  await generation("two", "dispatching", "second-canvas");
  for (let i = 0; i < 3; i += 1) assert.equal((await generationCapacity("owner", "canvas"))?.available, 0);
  const rejected = await admitGeneration(request);
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.code, "GENERATION_CONCURRENCY_LIMIT");
  assert.equal(reserve.mock.calls.length, 0);
  assert.equal(await activeGenerationCount("space"), 2);
});


test("capacity and admission resolve entitlements for the authenticated actor", async () => {
  const authority = await usageAuthority();
  const base = await authority.summary("space");
  const summary = mock.method(authority, "summary", async (workspaceId: string, userId?: string) => {
    assert.equal(workspaceId, "space");
    return { ...base, generationConcurrency: userId === "owner" ? 20 : 1 };
  });
  const reserve = mock.method(authority, "reserveGeneration", async () => true);
  await generation("existing", "running");
  assert.deepEqual(await generationCapacity("owner", "canvas"), { concurrency: 20, available: 19, retryAfterMs: 3000 });
  const accepted = await admitGeneration(request);
  assert.equal(accepted.ok, true);
  assert.equal(reserve.mock.calls.length, 1);
  assert.ok(summary.mock.calls.length >= 2);
  for (const call of summary.mock.calls) assert.deepEqual(call.arguments, ["space", "owner"]);
});
