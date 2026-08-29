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

test("system templates allow only explicit primary model overrides and reset to template defaults", async () => {
  const owner = await seedOwner();
  const [system] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const before = await repository.getAutomationWorkflow(owner.userId, system.id);
  const aiNode = before!.published!.graph.nodes.find((node) => node.type === "ai.structured-task")!;
  const imageNode = before!.published!.graph.nodes.find((node) => node.type === "generation.image")!;
  const originalAiModel = String(aiNode.config.modelId);
  const originalImageModel = String(imageNode.config.modelId);
  const originalPrompt = aiNode.config.userPrompt;
  const { automationRunInputFields } = await import("../src/lib/automation-workflows/validation");
  const triggerInputs = Object.fromEntries(automationRunInputFields(before!.published!.graph).flatMap((field) => {
    if (!field.required && (field.value === undefined || field.value === null || field.value === "")) return [];
    const value = field.value !== undefined ? field.value
      : field.valueType === "boolean" ? true
        : field.valueType === "number" ? field.min ?? 1
          : field.valueType === "json" ? {}
            : field.valueType === "visual-references" ? []
              : field.options?.[0]?.value ?? "selected";
    return [[field.key, value]];
  }));
  const triggerId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO automation_workflow_triggers
    (id, workflow_id, workspace_id, project_id, type, status, name, config_json, input_json, active_version_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'canvas-event', 'active', 'System model trigger', '{"event":"generation.completed","version":1}', ?, ?, ?, ?, ?)`)
    .run(triggerId, system.id, owner.workspaceId, owner.projectId, JSON.stringify(triggerInputs), before!.published!.id, owner.userId, now, now);

  const changedAi = await repository.setSystemAutomationModelOverride({
    userId: owner.userId,
    workflowId: system.id,
    nodeId: aiNode.id,
    modelId: "qwen/qwen3.8-max",
  });
  assert.equal(changedAi?.published?.graph.nodes.find((node) => node.id === aiNode.id)?.config.modelId, "qwen/qwen3.8-max");
  assert.equal(changedAi?.published?.graph.nodes.find((node) => node.id === aiNode.id)?.config.userPrompt, originalPrompt);
  assert.notEqual(changedAi?.published?.id, before?.published?.id);
  const advancedTrigger = await db.prepare("SELECT status, active_version_id FROM automation_workflow_triggers WHERE id = ?").get(triggerId) as { status: string; active_version_id: string | null };
  assert.deepEqual(advancedTrigger, { status: "active", active_version_id: changedAi!.published!.id });

  const changedImage = await repository.setSystemAutomationModelOverride({
    userId: owner.userId,
    workflowId: system.id,
    nodeId: imageNode.id,
    modelId: "nano-banana-pro",
  });
  assert.equal(changedImage?.published?.graph.nodes.find((node) => node.id === imageNode.id)?.config.modelId, "nano-banana-pro");
  assert.equal(changedImage?.published?.graph.nodes.find((node) => node.id === imageNode.id)?.config.ratio, imageNode.config.ratio);
  assert.equal(changedImage?.published?.graph.nodes.find((node) => node.id === imageNode.id)?.config.resolution, imageNode.config.resolution);
  await assert.rejects(
    repository.setSystemAutomationModelOverride({ userId: owner.userId, workflowId: system.id, nodeId: imageNode.id, modelId: "seedream-5-lite" }),
    /does not support that model/i,
    "a system model override must not silently change the locked 1K quality",
  );
  await assert.rejects(
    repository.setSystemAutomationModelOverride({ userId: owner.userId, workflowId: system.id, nodeId: imageNode.id, modelId: "nano-banana-pro-flash" }),
    /does not support that model/i,
    "a retired model id must not silently alias to a different current model",
  );
  const storedOverrides = await db.prepare("SELECT node_id, model_id FROM automation_system_model_overrides WHERE workflow_id = ? ORDER BY node_id")
    .all(system.id) as Array<{ node_id: string; model_id: string }>;
  assert.deepEqual(new Map(storedOverrides.map((row) => [row.node_id, row.model_id])), new Map([[aiNode.id, "qwen/qwen3.8-max"], [imageNode.id, "nano-banana-pro"]]));

  await db.prepare("UPDATE automation_workflows SET system_revision = 0 WHERE id = ?").run(system.id);
  await repository.ensureSystemAutomationWorkflows(owner.workspaceId, owner.userId);
  const upgraded = await repository.getAutomationWorkflow(owner.userId, system.id);
  assert.equal(upgraded?.published?.graph.nodes.find((node) => node.id === aiNode.id)?.config.modelId, "qwen/qwen3.8-max");
  assert.equal(upgraded?.published?.graph.nodes.find((node) => node.id === imageNode.id)?.config.modelId, "nano-banana-pro");
  assert.equal((await db.prepare("SELECT active_version_id FROM automation_workflow_triggers WHERE id = ?").get(triggerId) as { active_version_id: string }).active_version_id, upgraded!.published!.id);

  const resetAi = await repository.setSystemAutomationModelOverride({ userId: owner.userId, workflowId: system.id, nodeId: aiNode.id, modelId: null });
  const resetImage = await repository.setSystemAutomationModelOverride({ userId: owner.userId, workflowId: system.id, nodeId: imageNode.id, modelId: originalImageModel });
  assert.equal(resetAi?.published?.graph.nodes.find((node) => node.id === aiNode.id)?.config.modelId, originalAiModel);
  assert.equal(resetImage?.published?.graph.nodes.find((node) => node.id === imageNode.id)?.config.modelId, originalImageModel);
  const remaining = await db.prepare("SELECT COUNT(*) AS count FROM automation_system_model_overrides WHERE workflow_id = ?").get(system.id) as { count: number };
  assert.equal(Number(remaining.count), 0);

  await assert.rejects(
    repository.setSystemAutomationModelOverride({ userId: owner.userId, workflowId: system.id, nodeId: "creative-settings", modelId: "qwen/qwen3.8-max" }),
    /does not support that model/i,
  );
});

test("system template upgrades surface unavailable model overrides and let operators clear them", async () => {
  const owner = await seedOwner();
  const [system] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  const before = await repository.getAutomationWorkflow(owner.userId, system.id);
  const aiNode = before!.published!.graph.nodes.find((node) => node.type === "ai.structured-task")!;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO automation_system_model_overrides
    (workflow_id, workspace_id, node_id, model_id, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 'assistant-model-that-no-longer-exists', ?, ?, ?),
           (?, ?, 'retired-system-step', 'retired-model', ?, ?, ?)`).run(
    system.id, owner.workspaceId, aiNode.id, owner.userId, now, now,
    system.id, owner.workspaceId, owner.userId, now, now,
  );
  await db.prepare("UPDATE automation_workflows SET system_revision = 0 WHERE id = ?").run(system.id);

  await repository.ensureSystemAutomationWorkflows(owner.workspaceId, owner.userId);
  const upgraded = await repository.getAutomationWorkflow(owner.userId, system.id);
  assert.equal(upgraded?.published?.graph.nodes.find((node) => node.id === aiNode.id)?.config.modelId, aiNode.config.modelId);
  assert.deepEqual(upgraded?.systemModelIssues.map((issue) => [issue.nodeId, issue.modelId]), [
    [aiNode.id, "assistant-model-that-no-longer-exists"],
    ["retired-system-step", "retired-model"],
  ]);

  const clearedModel = await repository.setSystemAutomationModelOverride({ userId: owner.userId, workflowId: system.id, nodeId: aiNode.id, modelId: null });
  const clearedRetiredStep = await repository.setSystemAutomationModelOverride({ userId: owner.userId, workflowId: system.id, nodeId: "retired-system-step", modelId: null });
  assert.deepEqual(clearedModel?.systemModelIssues.map((issue) => issue.nodeId), ["retired-system-step"]);
  assert.deepEqual(clearedRetiredStep?.systemModelIssues, []);
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

test("autosave retention bounds unnamed draft noise without deleting named checkpoints", async () => {
  const owner = await seedOwner();
  const [system] = (await repository.listAutomationWorkflows(owner.userId, owner.projectId))!;
  let detail = (await repository.createAutomationWorkflow({
    userId: owner.userId,
    projectId: owner.projectId,
    name: "Bounded autosaves",
    sourceWorkflowId: system.id,
  }))!;
  const checkpointGraph = structuredClone(detail.draft!.graph);
  checkpointGraph.nodes[0]!.name = "Named checkpoint";
  detail = (await repository.saveAutomationWorkflowDraft({
    userId: owner.userId,
    workflowId: detail.workflow.id,
    baseDraftVersionId: detail.workflow.draftVersionId,
    graph: checkpointGraph,
    changeNote: "Keep this checkpoint",
  }))!;
  const checkpointId = detail.draft!.id;

  for (let index = 0; index < 32; index += 1) {
    const graph = structuredClone(detail.draft!.graph);
    graph.nodes[0]!.name = `Autosave ${index + 1}`;
    detail = (await repository.saveAutomationWorkflowDraft({
      userId: owner.userId,
      workflowId: detail.workflow.id,
      baseDraftVersionId: detail.workflow.draftVersionId,
      graph,
    }))!;
  }

  const unnamed = await db.prepare(`SELECT COUNT(*) AS count FROM automation_workflow_versions
    WHERE workflow_id = ? AND status = 'superseded' AND published_at IS NULL AND change_note IS NULL`).get(detail.workflow.id) as { count: number };
  const checkpoint = await db.prepare("SELECT status, change_note FROM automation_workflow_versions WHERE id = ?").get(checkpointId) as { status: string; change_note: string } | undefined;
  assert.equal(Number(unnamed.count), 25);
  assert.deepEqual(checkpoint, { status: "superseded", change_note: "Keep this checkpoint" });
  assert.equal((await repository.getAutomationWorkflow(owner.userId, detail.workflow.id))?.draft?.graph.nodes[0]?.name, "Autosave 32");
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
