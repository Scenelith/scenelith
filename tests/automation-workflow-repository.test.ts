import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DEFAULT_TIKTOK_AUTOMATION_TEMPLATE } from "../src/lib/automation-workflows/system-templates";

let db: typeof import("./postgres-test-db")["db"];
let closeRelationalPool: typeof import("./postgres-test-db")["closeRelationalPool"];
let repository: typeof import("../src/lib/automation-workflows/repository");

before(async () => {
  const testDb = await import("./postgres-test-db");
  ({ db, closeRelationalPool } = testDb);
  await testDb.resetTestDatabase();
  repository = await import("../src/lib/automation-workflows/repository");
});

after(async () => {
  await closeRelationalPool();
});

async function seedOwner() {
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, 'Owner', ?, ?)")
    .run(userId, `${userId}@example.test`, now, now);
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Workspace', ?, ?)")
    .run(workspaceId, now, now);
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run(workspaceId, userId, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, 'Canvas', '{\"nodes\":[],\"edges\":[]}', ?, ?)")
    .run(projectId, workspaceId, now, now);
  return { userId, workspaceId, projectId };
}

test("workspace receives one current system workflow", async () => {
  const owner = await seedOwner();
  const first = await repository.listAutomationWorkflows(owner.userId, owner.projectId);
  const second = await repository.listAutomationWorkflows(owner.userId, owner.projectId);
  assert.equal(first?.length, 1);
  assert.equal(second?.length, 1);
  assert.equal(first?.[0].status, "system");
  assert.equal(first?.[0].systemKey, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.key);
  assert.equal(first?.[0].name, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.name);
  assert.equal(first?.[0].description, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.description);
  const detail = await repository.getAutomationWorkflow(owner.userId, first![0].id);
  assert.equal(detail?.published?.validation.valid, true);
  assert.equal(detail?.draft, null);
});

test("system template upgrades transactionally without replacing the workflow id", async () => {
  const owner = await seedOwner();
  const [before] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const beforeDetail = await repository.getAutomationWorkflow(owner.userId, before.id);
  await db.prepare("UPDATE automation_workflows SET system_revision = 0, name = 'Stale name', description = 'Stale description' WHERE id = ?").run(before.id);
  const [after] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const afterDetail = await repository.getAutomationWorkflow(owner.userId, after.id);
  assert.equal(after.id, before.id);
  assert.equal(after.name, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.name);
  assert.equal(after.description, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.description);
  assert.notEqual(afterDetail?.published?.id, beforeDetail?.published?.id);
  const current = await db.prepare("SELECT status, COUNT(*) AS count FROM automation_workflow_versions WHERE workflow_id = ? GROUP BY status ORDER BY status")
    .all(before.id) as Array<{ status: string; count: number }>;
  assert.deepEqual(current, [{ status: "published", count: 1 }, { status: "superseded", count: 1 }]);
});

test("automation worker reconciliation upgrades persisted system workflows before trigger draining", async () => {
  const owner = await seedOwner();
  const [before] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const beforeDetail = await repository.getAutomationWorkflow(owner.userId, before.id);
  await db.prepare("UPDATE automation_workflows SET system_revision = 0 WHERE id = ?").run(before.id);
  const reconciled = await repository.reconcilePersistedSystemAutomationWorkflows();
  const stored = await db.prepare("SELECT system_revision, published_version_id FROM automation_workflows WHERE id = ?")
    .get(before.id) as { system_revision: number; published_version_id: string };
  assert.ok(reconciled >= 1);
  assert.equal(stored.system_revision, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.revision);
  assert.notEqual(stored.published_version_id, beforeDetail?.published?.id);
});

test("system metadata is reconciled without rewriting the published graph", async () => {
  const owner = await seedOwner();
  const [before] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const beforeDetail = await repository.getAutomationWorkflow(owner.userId, before.id);
  await db.prepare("UPDATE automation_workflows SET name = 'Wrong label', description = 'Wrong description' WHERE id = ?").run(before.id);
  const [after] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const afterDetail = await repository.getAutomationWorkflow(owner.userId, after.id);
  assert.equal(after.name, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.name);
  assert.equal(after.description, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.description);
  assert.equal(afterDetail?.published?.id, beforeDetail?.published?.id);
});

test("custom workflows keep immutable draft history and publish explicitly", async () => {
  const owner = await seedOwner();
  const [system] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const custom = await repository.createAutomationWorkflow({
    userId: owner.userId,
    projectId: owner.projectId,
    name: "My content system",
    sourceWorkflowId: system.id,
  });
  assert.equal(custom?.workflow.status, "draft");
  assert.equal(custom?.draft?.version, 1);
  const graph = structuredClone(custom!.draft!.graph);
  graph.nodes.find((node) => node.id === "review-series")!.name = "Strict final review";
  const saved = await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: custom!.workflow.id, baseDraftVersionId: custom!.workflow.draftVersionId, graph });
  assert.equal(saved?.draft?.version, 2);
  assert.equal(saved?.draft?.graph.nodes.find((node) => node.id === "review-series")?.name, "Strict final review");
  const versions = await db.prepare("SELECT version, status FROM automation_workflow_versions WHERE workflow_id = ? ORDER BY version")
    .all(custom!.workflow.id) as Array<{ version: number; status: string }>;
  assert.deepEqual(versions, [{ version: 1, status: "superseded" }, { version: 2, status: "draft" }]);
  const published = await repository.publishAutomationWorkflow(owner.userId, custom!.workflow.id);
  assert.equal(published?.validation.valid, true);
  assert.equal(published?.detail?.workflow.status, "published");
  assert.equal(published?.detail?.draft, null);
  assert.equal(published?.detail?.published?.version, 2);
});

test("a canvas can store and switch between multiple independently published workflows", async () => {
  const owner = await seedOwner();
  const [system] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const first = await repository.createAutomationWorkflow({
    userId: owner.userId,
    projectId: owner.projectId,
    name: "Product campaign",
    sourceWorkflowId: system.id,
  });
  const second = await repository.createAutomationWorkflow({
    userId: owner.userId,
    projectId: owner.projectId,
    name: "Creator campaign",
    sourceWorkflowId: system.id,
  });
  await repository.publishAutomationWorkflow(owner.userId, first!.workflow.id);
  await repository.publishAutomationWorkflow(owner.userId, second!.workflow.id);
  await repository.ensureSystemAutomationWorkflows(owner.workspaceId, owner.userId);
  const listed = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  assert.equal(listed.length, 3);
  assert.deepEqual(new Set(listed.map((workflow) => workflow.id)), new Set([system.id, first!.workflow.id, second!.workflow.id]));
  assert.equal(listed.find((workflow) => workflow.id === first!.workflow.id)?.status, "published");
  assert.equal(listed.find((workflow) => workflow.id === second!.workflow.id)?.status, "published");
  assert.equal(listed.find((workflow) => workflow.id === first!.workflow.id)?.name, "Product campaign");
  assert.equal(listed.find((workflow) => workflow.id === second!.workflow.id)?.name, "Creator campaign");
  const firstDetail = await repository.getAutomationWorkflow(owner.userId, first!.workflow.id);
  const secondDetail = await repository.getAutomationWorkflow(owner.userId, second!.workflow.id);
  assert.notEqual(firstDetail?.published?.id, secondDetail?.published?.id);
  const { automationRunInputFields } = await import("../src/lib/automation-workflows/validation");
  const { cancelAutomationWorkflowRun, enqueueAutomationWorkflowRun } = await import("../src/lib/automation-workflows/runs");
  const inputs = Object.fromEntries(automationRunInputFields(secondDetail!.published!.graph).map((field) => [field.key, field.value ?? (field.required ? "selected" : "")]));
  inputs["creative-settings.newOutfit"] = true;
  inputs["creative-settings.newLocation"] = true;
  const queued = await enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: second!.workflow.id, runtimeInputs: inputs });
  assert.ok("runId" in queued);
  const row = await db.prepare("SELECT workflow_id, workflow_version_id FROM automation_runs WHERE id = ?").get("runId" in queued ? queued.runId : "") as { workflow_id: string; workflow_version_id: string };
  assert.equal(row.workflow_id, second!.workflow.id);
  assert.equal(row.workflow_version_id, secondDetail!.published!.id);
  if ("runId" in queued) await cancelAutomationWorkflowRun(owner.userId, queued.runId);
});

test("invalid drafts save but cannot publish", async () => {
  const owner = await seedOwner();
  const custom = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Blank" });
  assert.equal(custom?.draft?.validation.valid, false);
  const result = await repository.publishAutomationWorkflow(owner.userId, custom!.workflow.id);
  assert.equal(result?.validation.valid, false);
  assert.equal(result?.detail?.workflow.status, "draft");
});

test("parallel saves reject the stale writer instead of silently overwriting another window", async () => {
  const owner = await seedOwner();
  const [system] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const custom = await repository.createAutomationWorkflow({
    userId: owner.userId,
    projectId: owner.projectId,
    name: "Concurrent workflow",
    sourceWorkflowId: system.id,
  });
  const firstGraph = structuredClone(custom!.draft!.graph);
  const secondGraph = structuredClone(custom!.draft!.graph);
  firstGraph.nodes.find((node) => node.id === "review-series")!.name = "Review from tab one";
  secondGraph.nodes.find((node) => node.id === "review-series")!.name = "Review from tab two";
  const saves = await Promise.allSettled([
    repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: custom!.workflow.id, baseDraftVersionId: custom!.workflow.draftVersionId, graph: firstGraph }),
    repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: custom!.workflow.id, baseDraftVersionId: custom!.workflow.draftVersionId, graph: secondGraph }),
  ]);
  assert.equal(saves.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = saves.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected" && rejected.reason instanceof repository.AutomationWorkflowDraftConflictError);
  const draftRows = await db.prepare("SELECT id FROM automation_workflow_versions WHERE workflow_id = ? AND status = 'draft'")
    .all(custom!.workflow.id) as Array<{ id: string }>;
  assert.equal(draftRows.length, 1);
  const beforePublish = await repository.getAutomationWorkflow(owner.userId, custom!.workflow.id);
  assert.equal(beforePublish?.workflow.draftVersionId, draftRows[0].id);
  const result = await repository.publishAutomationWorkflow(owner.userId, custom!.workflow.id);
  assert.equal(result?.validation.valid, true);
  const afterPublish = await repository.getAutomationWorkflow(owner.userId, custom!.workflow.id);
  assert.equal(afterPublish?.workflow.publishedVersionId, draftRows[0].id);
  assert.equal(afterPublish?.workflow.draftVersionId, null);
  const liveRows = await db.prepare("SELECT status, COUNT(*) AS count FROM automation_workflow_versions WHERE workflow_id = ? AND status IN ('draft', 'published') GROUP BY status")
    .all(custom!.workflow.id) as Array<{ status: string; count: number }>;
  assert.deepEqual(liveRows, [{ status: "published", count: 1 }]);
});

test("database pointers cannot cross workflow version boundaries", async () => {
  const owner = await seedOwner();
  const first = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "First workflow" });
  const second = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Second workflow" });
  await assert.rejects(
    db.prepare("UPDATE automation_workflows SET draft_version_id = ? WHERE id = ?").run(second!.draft!.id, first!.workflow.id),
    /foreign key/i,
  );
  const stored = await db.prepare("SELECT draft_version_id FROM automation_workflows WHERE id = ?").get(first!.workflow.id) as { draft_version_id: string };
  assert.equal(stored.draft_version_id, first!.draft!.id);
});

test("a portable JSON automation can be exported and deployed as an isolated draft", async () => {
  const owner = await seedOwner();
  const [system] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const exported = await repository.exportAutomationWorkflowPackage({ userId: owner.userId, workflowId: system.id, version: "published" });
  assert.ok(exported && !("error" in exported));
  const imported = await repository.importAutomationWorkflowPackage({ userId: owner.userId, projectId: owner.projectId, package: exported!.package });
  assert.ok(imported?.detail?.draft);
  assert.equal(imported?.detail?.workflow.status, "draft");
  assert.equal(imported?.detail?.workflow.sourcePackageDigest, exported!.package.integrity.digest);
  assert.notEqual(imported?.detail?.workflow.id, system.id);
  assert.deepEqual(imported?.detail?.draft?.graph, exported!.package.graph);
  const reexported = await repository.exportAutomationWorkflowPackage({ userId: owner.userId, workflowId: imported!.detail!.workflow.id, version: "draft" });
  assert.ok(reexported && !("error" in reexported));
  assert.equal(reexported!.package.integrity.digest, exported!.package.integrity.digest);
});

test("version rollback creates a new immutable draft with explicit lineage", async () => {
  const owner = await seedOwner();
  const [system] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const custom = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Versioned", sourceWorkflowId: system.id });
  const originalId = custom!.draft!.id;
  const graph = structuredClone(custom!.draft!.graph);
  graph.nodes.find((node) => node.id === "review-series")!.name = "New review";
  const changed = await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: custom!.workflow.id, baseDraftVersionId: originalId, graph, changeNote: "Tighten review" });
  const restored = await repository.restoreAutomationWorkflowVersion({ userId: owner.userId, workflowId: custom!.workflow.id, versionId: originalId });
  assert.ok(restored?.draft);
  assert.notEqual(restored?.draft?.id, originalId);
  assert.notEqual(restored?.draft?.id, changed?.draft?.id);
  assert.equal(restored?.draft?.graph.nodes.find((node) => node.id === "review-series")?.name, custom!.draft!.graph.nodes.find((node) => node.id === "review-series")?.name);
  const versions = await repository.listAutomationWorkflowVersions(owner.userId, custom!.workflow.id);
  assert.equal(versions?.[0].restoredFromVersionId, originalId);
  assert.equal(versions?.[0].changeNote, "Restored from version 1");
});
