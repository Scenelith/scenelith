import assert from "node:assert/strict";
import { after, test } from "node:test";
import sharp from "sharp";
import { db, resetTestDatabase, closeRelationalPool } from "./postgres-test-db";
import { finalizeGenerationFromWebhook } from "../src/lib/generation-state";
import { tickGenerationWorker } from "../src/lib/generation-worker";

after(closeRelationalPool);

async function seedGeneration() {
  await resetTestDatabase();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES('usage-user','usage@example.test','Usage',?,?)").run(now, now);
  await db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('usage-space','Usage',?,?)").run(now, now);
  await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('usage-space','usage-user','owner',?)").run(now);
  await db.prepare("INSERT INTO projects(id,workspace_id,name,graph_json,created_at,updated_at) VALUES('usage-canvas','usage-space','Usage','{\"nodes\":[],\"edges\":[]}',?,?)").run(now, now);
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO generations(id,project_id,node_id,model_id,provider_task_id,prompt,media_type,status,credit_cost,created_at,updated_at)
    VALUES(?,'usage-canvas','generator','gpt-image-2-6-flare','usage-task','A portrait','image','generating',51,?,?)`).run(id, now, now);
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } }).png().toBuffer();
  return { id, outputUrl: `data:image/png;base64,${bytes.toString("base64")}` };
}

test("completed callbacks persist measured usage and duplicate deliveries preserve the first measurement", async () => {
  const fixture = await seedGeneration();
  await finalizeGenerationFromWebhook({ generationId: fixture.id, status: "success", outputUrl: fixture.outputUrl, providerCredits: 7.345 });
  await finalizeGenerationFromWebhook({ generationId: fixture.id, status: "success", outputUrl: fixture.outputUrl, providerCredits: 99 });
  const row = await db.prepare("SELECT provider_credits, output_asset_id FROM generations WHERE id = ?").get(fixture.id) as { provider_credits: string; output_asset_id: string };
  assert.equal(Number(row.provider_credits), 7.345);
  assert.ok(row.output_asset_id);
});

test("background reconciliation retries missing usage after the generated image is already saved", async t => {
  const fixture = await seedGeneration();
  for (const name of ["KIE_API_KEY", "KIE_API_KEY_FILE"] as const) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    delete process.env[name];
  }
  process.env.KIE_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("data:")) return originalFetch(url, init);
    assert.match(String(url), /recordInfo\?taskId=usage-task/);
    polls++;
    return Response.json({ code: 200, data: { taskId: "usage-task", state: "success", ...(polls > 1 ? { creditsConsumed: 4.25 } : {}) } });
  });
  await finalizeGenerationFromWebhook({ generationId: fixture.id, status: "success", outputUrl: fixture.outputUrl });
  const saved = await db.prepare("SELECT output_asset_id, provider_credits FROM generations WHERE id = ?").get(fixture.id) as { output_asset_id: string; provider_credits: null };
  assert.ok(saved.output_asset_id);
  assert.equal(saved.provider_credits, null);
  await db.prepare("UPDATE generations SET updated_at = now() - interval '1 minute' WHERE id = ?").run(fixture.id);
  await tickGenerationWorker();
  const settled = await db.prepare("SELECT output_asset_id, provider_credits FROM generations WHERE id = ?").get(fixture.id) as { output_asset_id: string; provider_credits: string };
  assert.equal(settled.output_asset_id, saved.output_asset_id);
  assert.equal(Number(settled.provider_credits), 4.25);
  assert.equal(polls, 2);
});
