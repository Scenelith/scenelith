import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationWorkflowGraph } from "../src/lib/automation-workflows/types";

let db: typeof import("./postgres-test-db")["db"];
let closeRelationalPool: typeof import("./postgres-test-db")["closeRelationalPool"];
let repository: typeof import("../src/lib/automation-workflows/repository");
let runs: typeof import("../src/lib/automation-workflows/runs");
let credentials: typeof import("../src/lib/automation-workflows/credentials");
let triggers: typeof import("../src/lib/automation-workflows/triggers");
let deliveries: typeof import("../src/lib/automation-workflows/deliveries");
let fixtures: typeof import("../src/lib/automation-workflows/fixtures");
let notifications: typeof import("../src/lib/automation-workflows/notifications");
let retention: typeof import("../src/lib/automation-workflows/retention");

before(async () => {
  const testDb = await import("./postgres-test-db");
  ({ db, closeRelationalPool } = testDb);
  await testDb.resetTestDatabase();
  repository = await import("../src/lib/automation-workflows/repository");
  runs = await import("../src/lib/automation-workflows/runs");
  credentials = await import("../src/lib/automation-workflows/credentials");
  triggers = await import("../src/lib/automation-workflows/triggers");
  deliveries = await import("../src/lib/automation-workflows/deliveries");
  fixtures = await import("../src/lib/automation-workflows/fixtures");
  notifications = await import("../src/lib/automation-workflows/notifications");
  retention = await import("../src/lib/automation-workflows/retention");
});

after(async () => closeRelationalPool());

async function seedOwner() {
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, 'Owner', ?, ?)").run(userId, `${userId}@example.test`, now, now);
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Workspace', ?, ?)").run(workspaceId, now, now);
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(workspaceId, userId, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, 'Canvas', '{\"nodes\":[],\"edges\":[]}', ?, ?)").run(projectId, workspaceId, now, now);
  return { userId, workspaceId, projectId };
}

function stopScheduledWorkflowDrain() {
  const shared = globalThis as typeof globalThis & { scenelithWorkflowRunTimer?: ReturnType<typeof setTimeout> };
  if (shared.scenelithWorkflowRunTimer) clearTimeout(shared.scenelithWorkflowRunTimer);
  shared.scenelithWorkflowRunTimer = undefined;
}

function finishGraph(outcome: "completed" | "failed"): AutomationWorkflowGraph {
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, timeoutSeconds: 120, maxCredits: 10 },
    nodes: [
      { id: "manual", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 300, y: 0 }, groupId: null, config: { outcome, message: outcome }, bindings: {}, disabled: false },
    ],
    edges: [{ id: "run-finish", source: "manual", sourcePort: "run", target: "finish", targetPort: "data" }],
    groups: [],
  };
}

function inputSnapshotGraph(input: { sourceNodeId: string; identityId: string; referenceAssetId: string }, caption: { mode: "original" | "replacement" | "empty"; value?: string } = { mode: "original" }): AutomationWorkflowGraph {
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, timeoutSeconds: 120, maxCredits: 10 },
    nodes: [
      { id: "manual", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "source", type: "input.tiktok-source", version: 2, name: "Source", description: "", position: { x: 180, y: 0 }, groupId: null, config: { source: input.sourceNodeId, captionMode: caption.mode, caption: caption.value || "" }, bindings: {}, disabled: false },
      { id: "identity", type: "input.identity", version: 1, name: "Identity", description: "", position: { x: 180, y: 180 }, groupId: null, config: { identity: input.identityId, referenceGroup: "auto", optional: false }, bindings: {}, disabled: false },
      { id: "references", type: "input.visual-references", version: 1, name: "References", description: "", position: { x: 180, y: 360 }, groupId: null, config: { references: [input.referenceAssetId], maxItems: 8, optional: false }, bindings: {}, disabled: false },
      { id: "merge", type: "logic.merge", version: 1, name: "Frozen inputs", description: "", position: { x: 420, y: 180 }, groupId: null, config: { mode: "named-object", inputs: [
        { id: "source-value", name: "source" },
        { id: "identity-value", name: "identity" },
        { id: "reference-value", name: "references" },
      ] }, bindings: {}, disabled: false },
      { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 680, y: 180 }, groupId: null, config: { outcome: "completed", message: "snapshot" }, bindings: {}, disabled: false },
    ],
    edges: [
      { id: "run-source", source: "manual", sourcePort: "run", target: "source", targetPort: "run", role: "flow" },
      { id: "run-identity", source: "manual", sourcePort: "run", target: "identity", targetPort: "run", role: "flow" },
      { id: "run-references", source: "manual", sourcePort: "run", target: "references", targetPort: "run", role: "flow" },
      { id: "source-merge", source: "source", sourcePort: "source", target: "merge", targetPort: "source-value", role: "flow" },
      { id: "identity-merge", source: "identity", sourcePort: "identity", target: "merge", targetPort: "identity-value", role: "data" },
      { id: "references-merge", source: "references", sourcePort: "references", target: "merge", targetPort: "reference-value", role: "data" },
      { id: "merge-finish", source: "merge", sourcePort: "result", target: "finish", targetPort: "data", role: "flow" },
    ],
    groups: [],
  };
}

function mediaUseGraph(input: { sourceNodeId: string; identityId: string; referenceAssetId: string }): AutomationWorkflowGraph {
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, timeoutSeconds: 120, maxCredits: 10 },
    nodes: [
      { id: "manual", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "payload", type: "input.workflow-data", version: 1, name: "Task", description: "", position: { x: 180, y: 0 }, groupId: null, config: { value: { task: "Inspect the media" }, payloadPath: "" }, bindings: {}, disabled: false },
      { id: "source", type: "input.tiktok-source", version: 2, name: "Source", description: "", position: { x: 180, y: 150 }, groupId: null, config: { source: input.sourceNodeId, captionMode: "original", caption: "" }, bindings: {}, disabled: false },
      { id: "identity", type: "input.identity", version: 1, name: "Identity", description: "", position: { x: 180, y: 300 }, groupId: null, config: { identity: input.identityId, referenceGroup: "auto", optional: false }, bindings: {}, disabled: false },
      { id: "references", type: "input.visual-references", version: 1, name: "References", description: "", position: { x: 180, y: 450 }, groupId: null, config: { references: [input.referenceAssetId], maxItems: 8, optional: false }, bindings: {}, disabled: false },
      { id: "ai", type: "ai.structured-task", version: 2, name: "Inspect", description: "", position: { x: 460, y: 220 }, groupId: null, config: { modelId: "google/gemini-3.7-flash", userPrompt: "Inspect the connected media.", outputMode: "text", runWhen: "always", systemPrompt: "", creativity: "consistent", maxAttempts: 1, fallbackModelId: "", failureMode: "stop" }, bindings: {}, disabled: false },
      { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 720, y: 220 }, groupId: null, config: { outcome: "completed", message: "done" }, bindings: {}, disabled: false },
    ],
    edges: [
      { id: "run-payload", source: "manual", sourcePort: "run", target: "payload", targetPort: "run", role: "flow" },
      { id: "run-source", source: "manual", sourcePort: "run", target: "source", targetPort: "run", role: "flow" },
      { id: "run-identity", source: "manual", sourcePort: "run", target: "identity", targetPort: "run", role: "flow" },
      { id: "run-references", source: "manual", sourcePort: "run", target: "references", targetPort: "run", role: "flow" },
      { id: "payload-ai", source: "payload", sourcePort: "data", target: "ai", targetPort: "primary", role: "flow" },
      { id: "source-ai", source: "source", sourcePort: "source", target: "ai", targetPort: "context", role: "data" },
      { id: "references-ai", source: "references", sourcePort: "references", target: "ai", targetPort: "context", role: "data" },
      { id: "identity-ai", source: "identity", sourcePort: "identity", target: "ai", targetPort: "identity", role: "data" },
      { id: "ai-finish", source: "ai", sourcePort: "result", target: "finish", targetPort: "data", role: "flow" },
    ],
    groups: [],
  };
}

async function seedSnapshotInputs(owner: Awaited<ReturnType<typeof seedOwner>>) {
  const sourceAssetId = crypto.randomUUID();
  const identityAssetId = crypto.randomUUID();
  const referenceAssetId = crypto.randomUUID();
  const identityId = crypto.randomUUID();
  const sourceNodeId = `source-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO personas (id, workspace_id, name, notes, created_at, updated_at) VALUES (?, ?, 'Original person', 'Original notes', ?, ?)")
    .run(identityId, owner.workspaceId, now, now);
  await db.prepare(`INSERT INTO assets (id, workspace_id, project_id, kind, filename, storage_path, mime_type, created_at)
    VALUES (?, ?, ?, 'scene', 'original-slide.png', 'snapshots/original-slide.png', 'image/png', ?)`).run(sourceAssetId, owner.workspaceId, owner.projectId, now);
  await db.prepare(`INSERT INTO assets (id, workspace_id, persona_id, kind, role, filename, storage_path, mime_type, created_at)
    VALUES (?, ?, ?, 'persona', 'reference', 'original-person.png', 'snapshots/original-person.png', 'image/png', ?)`).run(identityAssetId, owner.workspaceId, identityId, now);
  await db.prepare(`INSERT INTO assets (id, workspace_id, project_id, kind, filename, storage_path, mime_type, created_at)
    VALUES (?, ?, ?, 'library', 'original-reference.png', 'snapshots/original-reference.png', 'image/png', ?)`).run(referenceAssetId, owner.workspaceId, owner.projectId, now);
  const projectGraph = {
    nodes: [
      { id: sourceNodeId, type: "frameNode", position: { x: 0, y: 0 }, data: { kind: "source", title: "Original caption", postId: "snapshot-post", sourceUrl: "https://www.tiktok.com/@test/photo/snapshot-post", tiktokMediaType: "slideshow" } },
      { id: "source-slide", type: "frameNode", position: { x: 300, y: 0 }, data: { kind: "scene", title: "Screen 01", assetId: sourceAssetId, tiktokSourceNodeId: sourceNodeId } },
    ],
    edges: [],
  };
  const { writeProjectGraphSnapshot } = await import("../src/lib/postgres-db");
  const written = await writeProjectGraphSnapshot(owner.projectId, projectGraph);
  assert.equal(written.ok, true);
  return { sourceAssetId, identityAssetId, referenceAssetId, identityId, sourceNodeId, projectGraph };
}

test("a draft test run is pinned, observable and side-effect mode aware", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Draft test" });
  const saved = await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  const production = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "production" });
  assert.equal("error" in production ? production.error : "", "Take the workflow live before running it");
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in queued);
  await runs.drainAutomationWorkflowRuns();
  const run = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  assert.equal(run?.status, "completed");
  assert.equal(run?.runKind, "test");
  assert.equal(run?.workflowVersionId, saved?.draft?.id);
  assert.deepEqual(run?.events.map((event) => event.type), ["run.queued", "node.input_snapshotted", "node.started", "node.completed", "run.completed"]);
  assert.deepEqual(run?.nodeRuns.map((node) => node.outputPorts), [["run"], ["result"]]);
  const captured = await fixtures.createAutomationWorkflowFixture({
    userId: owner.userId,
    workflowId: workflow!.workflow.id,
    value: { name: "Captured finish input", runtimeInputs: {}, nodeInputs: {}, sourceRunId: run!.id, sourceNodeId: "finish" },
  });
  assert.equal(captured?.workflowVersionId, run?.workflowVersionId);
  assert.equal((captured?.nodeInputs as { finish?: { data?: { projectId?: string } } }).finish?.data?.projectId, owner.projectId);
});

test("a saved fixture previews one pinned node and exposes only its port data", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Step preview" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  const fixture = await fixtures.createAutomationWorkflowFixture({
    userId: owner.userId,
    workflowId: workflow!.workflow.id,
    value: { name: "Finish example", runtimeInputs: {}, nodeInputs: { finish: { data: { exact: "fixture-value" } } } },
  });
  const queued = await fixtures.enqueueAutomationNodePreview({ userId: owner.userId, workflowId: workflow!.workflow.id, fixtureId: fixture!.id, nodeId: "finish" });
  assert.equal(queued?.status, 202);
  await runs.drainAutomationWorkflowRuns();
  const preview = await runs.getAutomationWorkflowRun(owner.userId, queued!.runId);
  assert.equal(preview?.status, "completed");
  assert.equal(preview?.runKind, "node-preview");
  assert.equal(preview?.nodeRuns.length, 1);
  assert.deepEqual(preview?.nodeRuns[0].input, { data: { exact: "fixture-value" } });
  assert.deepEqual(preview?.nodeRuns[0].output, { result: { outcome: "completed", message: "completed", data: { exact: "fixture-value" } } });
  const executionDetails = await runs.getAutomationWorkflowNodeRunDetails(owner.userId, queued!.runId, "finish");
  assert.equal(executionDetails?.length, 1);
  assert.deepEqual(executionDetails?.[0].input, { data: { exact: "fixture-value" } });
  assert.deepEqual(executionDetails?.[0].output, { result: { outcome: "completed", message: "completed", data: { exact: "fixture-value" } } });
  assert.equal(executionDetails?.[0].error, null);
  assert.equal(executionDetails?.[0].errorCode, null);
  const intruder = await seedOwner();
  assert.equal(await runs.getAutomationWorkflowNodeRunDetails(intruder.userId, queued!.runId, "finish"), null);
});

test("queued runs keep the exact source, identity and visual references captured at enqueue time", async () => {
  const owner = await seedOwner();
  const inputs = await seedSnapshotInputs(owner);
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Immutable inputs" });
  await repository.saveAutomationWorkflowDraft({
    userId: owner.userId,
    workflowId: workflow!.workflow.id,
    baseDraftVersionId: workflow!.draft!.id,
    graph: inputSnapshotGraph(inputs),
  });
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in queued);

  await db.prepare("UPDATE personas SET name = 'Changed person', notes = 'Changed notes', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), inputs.identityId);
  await db.prepare("UPDATE assets SET filename = 'changed-person.png', storage_path = 'snapshots/changed-person.png' WHERE id = ?")
    .run(inputs.identityAssetId);
  await db.prepare("UPDATE assets SET filename = 'changed-reference.png', storage_path = 'snapshots/changed-reference.png' WHERE id = ?")
    .run(inputs.referenceAssetId);
  const changedGraph = structuredClone(inputs.projectGraph);
  changedGraph.nodes[0].data.title = "Changed caption";
  const { writeProjectGraphSnapshot } = await import("../src/lib/postgres-db");
  const changed = await writeProjectGraphSnapshot(owner.projectId, changedGraph);
  assert.equal(changed.ok, true);

  await runs.drainAutomationWorkflowRuns();
  const completed = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  assert.equal(completed?.status, "completed");
  const finalData = (completed?.output as { finish?: { result?: { data?: Record<string, unknown> } } })?.finish?.result?.data as {
    source: { caption: string; label: string; slides: Array<{ filename: string; path: string }> };
    identity: { name: string; notes: string; assets: Array<{ filename: string; path: string }> };
    references: { assets: Array<{ filename: string; path: string }> };
  };
  assert.equal(finalData.source.caption, "Original caption");
  assert.equal(finalData.source.label, "Original caption");
  assert.deepEqual(finalData.source.slides.map((slide) => [slide.filename, slide.path]), [["original-slide.png", "snapshots/original-slide.png"]]);
  assert.equal(finalData.identity.name, "Original person");
  assert.equal(finalData.identity.notes, "Original notes");
  assert.deepEqual(finalData.identity.assets.map((asset) => [asset.filename, asset.path]), [["original-person.png", "snapshots/original-person.png"]]);
  assert.deepEqual(finalData.references.assets.map((asset) => [asset.filename, asset.path]), [["original-reference.png", "snapshots/original-reference.png"]]);
  assert.deepEqual(completed?.nodeRuns.filter((node) => ["manual", "source", "identity", "references"].includes(node.nodeId)).map((node) => node.status), ["completed", "completed", "completed", "completed"]);
  assert.equal(completed?.events.filter((event) => event.type === "node.input_snapshotted").length, 4);
});

test("active-run deduplication includes the exact resolved input snapshot", async () => {
  const owner = await seedOwner();
  const inputs = await seedSnapshotInputs(owner);
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Snapshot-aware dedupe" });
  await repository.saveAutomationWorkflowDraft({
    userId: owner.userId,
    workflowId: workflow!.workflow.id,
    baseDraftVersionId: workflow!.draft!.id,
    graph: inputSnapshotGraph(inputs),
  });
  const first = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in first);
  stopScheduledWorkflowDrain();

  const changedGraph = structuredClone(inputs.projectGraph);
  changedGraph.nodes[0].data.title = "Changed caption before the second run";
  const { writeProjectGraphSnapshot } = await import("../src/lib/postgres-db");
  assert.equal((await writeProjectGraphSnapshot(owner.projectId, changedGraph)).ok, true);

  const second = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in second);
  stopScheduledWorkflowDrain();
  assert.notEqual("runId" in first ? first.runId : "", "runId" in second ? second.runId : "", "a changed input snapshot must create a distinct run");
  assert.equal(second.deduplicated, false);

  const duplicate = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  stopScheduledWorkflowDrain();
  assert.equal(duplicate.deduplicated, true, "an unchanged snapshot still collapses a duplicate submission");
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE workflow_id = ?").get(workflow!.workflow.id) as { count: number }).count), 2);

  const snapshots = await db.prepare("SELECT input_snapshot_json FROM automation_runs WHERE workflow_id = ? ORDER BY created_at, id")
    .all(workflow!.workflow.id) as Array<{ input_snapshot_json: unknown }>;
  const captions = snapshots.map((row) => {
    const snapshot = (typeof row.input_snapshot_json === "string" ? JSON.parse(row.input_snapshot_json) : row.input_snapshot_json) as Record<string, { output: { source?: { caption?: string } } }>;
    return snapshot.source.output.source?.caption;
  }).sort();
  assert.deepEqual(captions, ["Changed caption before the second run", "Original caption"]);
  await runs.drainAutomationWorkflowRuns();
});

test("a referenced asset revoked after enqueue fails explicitly when a later step tries to use it", async () => {
  const owner = await seedOwner();
  const inputs = await seedSnapshotInputs(owner);
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Revoked media" });
  await repository.saveAutomationWorkflowDraft({
    userId: owner.userId,
    workflowId: workflow!.workflow.id,
    baseDraftVersionId: workflow!.draft!.id,
    graph: mediaUseGraph(inputs),
  });
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in queued);
  await db.prepare("DELETE FROM assets WHERE id = ?").run(inputs.referenceAssetId);

  await runs.drainAutomationWorkflowRuns();
  const failed = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.code, "AI_MEDIA_UNAVAILABLE");
  assert.match(failed?.error || "", /Connected image .* is not available to this workflow/);
  assert.equal(failed?.nodeRuns.find((node) => node.nodeId === "references")?.status, "completed");
  assert.equal(failed?.nodeRuns.find((node) => node.nodeId === "ai")?.status, "failed");
});

test("TikTok source v2 can intentionally snapshot an empty caption without falling back to the source title", async () => {
  const owner = await seedOwner();
  const inputs = await seedSnapshotInputs(owner);
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "No caption" });
  await repository.saveAutomationWorkflowDraft({
    userId: owner.userId,
    workflowId: workflow!.workflow.id,
    baseDraftVersionId: workflow!.draft!.id,
    graph: inputSnapshotGraph(inputs, { mode: "empty" }),
  });
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in queued);
  await runs.drainAutomationWorkflowRuns();
  const completed = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  const data = (completed?.output as { finish?: { result?: { data?: { source?: { caption?: string; label?: string } } } } })?.finish?.result?.data;
  assert.equal(data?.source?.caption, "");
  assert.equal(data?.source?.label, "Original caption");
});

test("Identity v2 fails when a selected group is empty while historical v1 preserves its saved behavior", async () => {
  const owner = await seedOwner();
  const inputs = await seedSnapshotInputs(owner);

  const historicalWorkflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Historical optional identity" });
  const historicalGraph = inputSnapshotGraph(inputs);
  const historicalIdentity = historicalGraph.nodes.find((node) => node.id === "identity")!;
  historicalIdentity.version = 1;
  historicalIdentity.config.referenceGroup = "before";
  historicalIdentity.config.optional = true;
  await repository.saveAutomationWorkflowDraft({
    userId: owner.userId,
    workflowId: historicalWorkflow!.workflow.id,
    baseDraftVersionId: historicalWorkflow!.draft!.id,
    graph: historicalGraph,
  });
  const historicalRun = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: historicalWorkflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in historicalRun);
  await runs.drainAutomationWorkflowRuns();
  const historicalResult = await runs.getAutomationWorkflowRun(owner.userId, "runId" in historicalRun ? historicalRun.runId : "");
  const historicalIdentityOutput = (historicalResult?.output as { finish?: { result?: { data?: { identity?: { assets?: unknown[] } } } } })?.finish?.result?.data?.identity;
  assert.equal(historicalResult?.status, "completed");
  assert.deepEqual(historicalIdentityOutput?.assets, []);

  const currentWorkflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Strict optional identity" });
  const currentGraph = inputSnapshotGraph(inputs);
  const currentIdentity = currentGraph.nodes.find((node) => node.id === "identity")!;
  currentIdentity.version = 2;
  currentIdentity.config.referenceGroup = "before";
  currentIdentity.config.optional = true;
  await repository.saveAutomationWorkflowDraft({
    userId: owner.userId,
    workflowId: currentWorkflow!.workflow.id,
    baseDraftVersionId: currentWorkflow!.draft!.id,
    graph: currentGraph,
  });
  const rejected = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: currentWorkflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.deepEqual(rejected, {
    status: 422,
    error: "The selected identity has no usable images in the Before group",
    code: "INPUT_SNAPSHOT_FAILED",
  });

  const noSelectionWorkflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "No optional identity selected" });
  const noSelectionGraph = inputSnapshotGraph(inputs);
  const noSelectionIdentity = noSelectionGraph.nodes.find((node) => node.id === "identity")!;
  noSelectionIdentity.version = 2;
  noSelectionIdentity.config.identity = "";
  noSelectionIdentity.config.optional = true;
  await repository.saveAutomationWorkflowDraft({
    userId: owner.userId,
    workflowId: noSelectionWorkflow!.workflow.id,
    baseDraftVersionId: noSelectionWorkflow!.draft!.id,
    graph: noSelectionGraph,
  });
  const noSelectionRun = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: noSelectionWorkflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in noSelectionRun);
  await runs.drainAutomationWorkflowRuns();
  const noSelectionResult = await runs.getAutomationWorkflowRun(owner.userId, "runId" in noSelectionRun ? noSelectionRun.runId : "");
  const noSelectionIdentityOutput = (noSelectionResult?.output as { finish?: { result?: { data?: { identity?: unknown } } } })?.finish?.result?.data?.identity;
  assert.equal(noSelectionResult?.status, "completed");
  assert.equal(noSelectionIdentityOutput, null);
});

test("retry creates a linked run and reuses only safe upstream outputs", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Replay" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("failed") });
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in queued);
  await runs.drainAutomationWorkflowRuns();
  const failed = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  assert.equal(failed?.status, "failed");
  const sourceSnapshot = await db.prepare("SELECT input_snapshot_json FROM automation_runs WHERE id = ?").get(failed!.id) as { input_snapshot_json: unknown };
  const replay = await runs.retryAutomationWorkflowRun({ userId: owner.userId, runId: failed!.id, nodeId: "finish" });
  assert.ok("runId" in replay);
  if (!("runId" in replay) || !replay.runId) throw new Error("Replay was not queued");
  await runs.drainAutomationWorkflowRuns();
  const replayed = await runs.getAutomationWorkflowRun(owner.userId, replay.runId);
  assert.equal(replayed?.status, "failed");
  assert.equal(replayed?.runKind, "replay");
  assert.equal(replayed?.replayOfRunId, failed?.id);
  assert.equal(replayed?.reusedNodeCount, 1);
  const replaySnapshot = await db.prepare("SELECT input_snapshot_json FROM automation_runs WHERE id = ?").get(replayed!.id) as { input_snapshot_json: unknown };
  assert.deepEqual(replaySnapshot.input_snapshot_json, sourceSnapshot.input_snapshot_json);
  assert.equal(replayed?.nodeRuns.find((node) => node.nodeId === "manual")?.reusedFromNodeRunId, failed?.nodeRuns.find((node) => node.nodeId === "manual")?.id);
  assert.ok(replayed?.events.some((event) => event.type === "node.reused"));
});

test("an overlapping drain request guarantees a follow-up queue sweep", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Overlapping drain" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  const firstSweep = runs.drainAutomationWorkflowRuns();
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in queued);
  stopScheduledWorkflowDrain();
  await Promise.all([firstSweep, runs.drainAutomationWorkflowRuns()]);
  const completed = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  assert.equal(completed?.status, "completed");
});

function childGraph(): AutomationWorkflowGraph {
  return { schemaVersion: 1, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, timeoutSeconds: 120 }, groups: [], nodes: [
    { id: "manual", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    { id: "workflow-input", type: "input.workflow-data", version: 1, name: "Item", description: "", position: { x: 200, y: 0 }, groupId: null, config: {}, bindings: { value: { mode: "ask-on-run", required: true } }, disabled: false },
    { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 400, y: 0 }, groupId: null, config: { outcome: "completed", message: "done" }, bindings: {}, disabled: false },
  ], edges: [
    { id: "a", source: "manual", sourcePort: "run", target: "workflow-input", targetPort: "run" },
    { id: "b", source: "workflow-input", sourcePort: "data", target: "finish", targetPort: "data" },
  ] };
}

function mapGraph(): AutomationWorkflowGraph {
  return { schemaVersion: 1, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, timeoutSeconds: 120, maxSubworkflowDepth: 3 }, groups: [], nodes: [
    { id: "manual", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    { id: "workflow-input", type: "input.workflow-data", version: 1, name: "Items", description: "", position: { x: 200, y: 0 }, groupId: null, config: {}, bindings: { value: { mode: "ask-on-run", required: true } }, disabled: false },
    { id: "map", type: "logic.map-subworkflow", version: 1, name: "Map", description: "", position: { x: 400, y: 0 }, groupId: null, config: { subworkflowSlot: "item-workflow", childInputs: {}, maxItems: 10, concurrency: 2, itemFailure: "keep-successful", failureMode: "stop" }, bindings: {}, disabled: false },
    { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 600, y: 0 }, groupId: null, config: { outcome: "completed", message: "mapped" }, bindings: {}, disabled: false },
  ], edges: [
    { id: "a", source: "manual", sourcePort: "run", target: "workflow-input", targetPort: "run" },
    { id: "b", source: "workflow-input", sourcePort: "data", target: "map", targetPort: "items" },
    { id: "c", source: "map", sourcePort: "results", target: "finish", targetPort: "data" },
  ] };
}

function nestedGraph(slot: string): AutomationWorkflowGraph {
  return { schemaVersion: 1, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, timeoutSeconds: 120 }, groups: [], nodes: [
    { id: "manual", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    { id: "workflow-input", type: "input.workflow-data", version: 1, name: "Input", description: "", position: { x: 200, y: 0 }, groupId: null, config: {}, bindings: { value: { mode: "ask-on-run", required: true } }, disabled: false },
    { id: "child", type: "logic.run-subworkflow", version: 1, name: "Child", description: "", position: { x: 400, y: 0 }, groupId: null, config: { subworkflowSlot: slot, childInputs: {}, failureMode: "stop" }, bindings: {}, disabled: false },
    { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 600, y: 0 }, groupId: null, config: { outcome: "completed", message: "done" }, bindings: {}, disabled: false },
  ], edges: [
    { id: "a", source: "manual", sourcePort: "run", target: "workflow-input", targetPort: "run" },
    { id: "b", source: "workflow-input", sourcePort: "data", target: "child", targetPort: "data" },
    { id: "c", source: "child", sourcePort: "result", target: "finish", targetPort: "data" },
  ] };
}

function replayableChildGraph(): AutomationWorkflowGraph {
  return { schemaVersion: 1, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, timeoutSeconds: 120, maxSubworkflowDepth: 3 }, groups: [], nodes: [
    { id: "manual", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    { id: "workflow-input", type: "input.workflow-data", version: 1, name: "Input", description: "", position: { x: 180, y: 0 }, groupId: null, config: {}, bindings: { value: { mode: "ask-on-run", required: true } }, disabled: false },
    { id: "transform", type: "logic.transform", version: 1, name: "Prepare child input", description: "", position: { x: 360, y: 0 }, groupId: null, config: { template: { item: "{{ inputs.0 }}" } }, bindings: {}, disabled: false },
    { id: "child", type: "logic.run-subworkflow", version: 1, name: "Run child", description: "", position: { x: 540, y: 0 }, groupId: null, config: { subworkflowSlot: "item-workflow", childInputs: {}, failureMode: "stop" }, bindings: {}, disabled: false },
    { id: "finish", type: "output.finish", version: 1, name: "Fail after child", description: "", position: { x: 720, y: 0 }, groupId: null, config: { outcome: "failed", message: "retry child" }, bindings: {}, disabled: false },
  ], edges: [
    { id: "a", source: "manual", sourcePort: "run", target: "workflow-input", targetPort: "run" },
    { id: "b", source: "workflow-input", sourcePort: "data", target: "transform", targetPort: "data" },
    { id: "c", source: "transform", sourcePort: "result", target: "child", targetPort: "data" },
    { id: "d", source: "child", sourcePort: "result", target: "finish", targetPort: "data" },
  ] };
}

test("Map creates durable pinned child runs and rejects recursive bindings", async () => {
  const owner = await seedOwner();
  const child = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Child" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: child!.workflow.id, baseDraftVersionId: child!.draft!.id, graph: childGraph() });
  const childPublished = await repository.publishAutomationWorkflow(owner.userId, child!.workflow.id);
  const parent = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Parent" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: parent!.workflow.id, baseDraftVersionId: parent!.draft!.id, graph: mapGraph() });
  await credentials.bindAutomationSubworkflow({ userId: owner.userId, workflowId: parent!.workflow.id, workspaceId: owner.workspaceId, slotKey: "item-workflow", targetWorkflowId: child!.workflow.id });
  await repository.publishAutomationWorkflow(owner.userId, parent!.workflow.id);
  await assert.rejects(credentials.bindAutomationSubworkflow({ userId: owner.userId, workflowId: parent!.workflow.id, workspaceId: owner.workspaceId, slotKey: "self", targetWorkflowId: parent!.workflow.id }), /itself/);
  await assert.rejects(credentials.bindAutomationSubworkflow({ userId: owner.userId, workflowId: child!.workflow.id, workspaceId: owner.workspaceId, slotKey: "cycle", targetWorkflowId: parent!.workflow.id }), /recursive workflow cycle/);
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: parent!.workflow.id, runtimeInputs: { "workflow-input.value": [{ id: 1 }, { id: 2 }, { id: 3 }] } });
  assert.ok("runId" in queued);
  const changedChildGraph = childGraph();
  changedChildGraph.nodes.find((node) => node.id === "finish")!.config.message = "new child version";
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: child!.workflow.id, baseDraftVersionId: null, graph: changedChildGraph });
  const newerChild = await repository.publishAutomationWorkflow(owner.userId, child!.workflow.id);
  assert.notEqual(newerChild?.detail?.published?.id, childPublished!.detail!.published!.id);
  await runs.drainAutomationWorkflowRuns();
  const completed = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  assert.equal(completed?.status, "completed");
  const children = await db.prepare("SELECT status, workflow_version_id, item_index, input_snapshot_json FROM automation_runs WHERE parent_run_id = ? ORDER BY item_index").all(completed!.id) as Array<{ status: string; workflow_version_id: string; item_index: number; input_snapshot_json: unknown }>;
  assert.deepEqual(children.map((row) => [row.status, row.item_index]), [["completed", 0], ["completed", 1], ["completed", 2]]);
  assert.ok(children.every((row) => row.workflow_version_id === childPublished!.detail!.published!.id));
  assert.deepEqual(children.map((row) => {
    const snapshot = (typeof row.input_snapshot_json === "string" ? JSON.parse(row.input_snapshot_json) : row.input_snapshot_json) as Record<string, { output: { data: unknown } }>;
    return snapshot["workflow-input"].output.data;
  }), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(completed?.treeRunCount, 4);
  assert.equal(completed?.treeNodeExecutions, 13);
  await runs.reserveAutomationTreeUsage(completed!.id, "asset", 1, "generate:slide-1");
  await runs.reserveAutomationTreeUsage(completed!.id, "asset", 1, "generate:slide-1");
  const usage = await db.prepare("SELECT tree_generated_assets FROM automation_runs WHERE id = ?").get(completed!.id) as { tree_generated_assets: number };
  assert.equal(usage.tree_generated_assets, 1);
  const history = await runs.listAutomationWorkflowRuns({ userId: owner.userId, projectId: owner.projectId });
  assert.deepEqual(history?.map((entry) => entry.id), [completed!.id]);

  // Simulate a worker dying after every Map item completed but before the Map
  // node result became durable. Resuming the parent must reuse those exact
  // children instead of invoking the child workflow three more times.
  await db.prepare("DELETE FROM automation_node_runs WHERE run_id = ? AND node_id IN ('map','finish')").run(completed!.id);
  await db.prepare(`UPDATE automation_runs SET status = 'queued', stage_label = 'Recovering', progress = 50, output_json = NULL,
    completed_at = NULL, available_at = ?, deadline_at = ?, attempts = 1, worker_id = NULL, locked_at = NULL WHERE id = ?`)
    .run(new Date().toISOString(), new Date(Date.now() + 120_000).toISOString(), completed!.id);
  await runs.drainAutomationWorkflowRuns();
  const resumed = await runs.getAutomationWorkflowRun(owner.userId, completed!.id);
  assert.equal(resumed?.status, "completed");
  const childrenAfterResume = await db.prepare("SELECT id FROM automation_runs WHERE parent_run_id = ?").all(completed!.id);
  assert.equal(childrenAfterResume.length, 3);
  assert.equal(resumed?.events.filter((event) => event.type === "subworkflow.reused").length, 3);
});

test("a replay reuses a child workflow only when its exact inputs still match", async () => {
  const owner = await seedOwner();
  const child = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Replay child" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: child!.workflow.id, baseDraftVersionId: child!.draft!.id, graph: childGraph() });
  await repository.publishAutomationWorkflow(owner.userId, child!.workflow.id);

  const parent = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Replay parent" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: parent!.workflow.id, baseDraftVersionId: parent!.draft!.id, graph: replayableChildGraph() });
  await credentials.bindAutomationSubworkflow({ userId: owner.userId, workflowId: parent!.workflow.id, workspaceId: owner.workspaceId, slotKey: "item-workflow", targetWorkflowId: child!.workflow.id });
  await repository.publishAutomationWorkflow(owner.userId, parent!.workflow.id);

  const queued = await runs.enqueueAutomationWorkflowRun({
    userId: owner.userId,
    projectId: owner.projectId,
    workflowId: parent!.workflow.id,
    runtimeInputs: { "workflow-input.value": { id: 1 } },
  });
  assert.ok("runId" in queued);
  stopScheduledWorkflowDrain();
  await runs.drainAutomationWorkflowRuns();
  const source = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  assert.equal(source?.status, "failed");
  const sourceChild = await db.prepare("SELECT id FROM automation_runs WHERE parent_run_id = ? AND parent_node_id = 'child'")
    .get(source!.id) as { id: string };

  const exactReplay = await runs.retryAutomationWorkflowRun({ userId: owner.userId, runId: source!.id, nodeId: "transform" });
  assert.ok("runId" in exactReplay);
  stopScheduledWorkflowDrain();
  await runs.drainAutomationWorkflowRuns();
  const exactChild = await db.prepare("SELECT replay_of_run_id FROM automation_runs WHERE parent_run_id = ? AND parent_node_id = 'child'")
    .get("runId" in exactReplay ? exactReplay.runId : "") as { replay_of_run_id: string | null };
  assert.equal(exactChild.replay_of_run_id, sourceChild.id, "an exact replay may reuse the successful child side effect");

  const changedReplay = await runs.retryAutomationWorkflowRun({ userId: owner.userId, runId: source!.id, nodeId: "transform" });
  assert.ok("runId" in changedReplay);
  stopScheduledWorkflowDrain();
  if (!("runId" in changedReplay)) throw new Error("Changed replay was not queued");
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO automation_node_runs
    (id, run_id, node_id, node_type, attempt, status, input_json, output_json, output_ports_json, charged_credits, started_at, completed_at, created_at, updated_at)
    VALUES (?, ?, 'transform', 'logic.transform', 1, 'completed', ?, ?, '["result"]', 0, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), changedReplay.runId, JSON.stringify({ data: [{ id: 1 }] }), JSON.stringify({ result: { item: { id: 2 } } }), now, now, now, now);
  await runs.drainAutomationWorkflowRuns();
  const changedChild = await db.prepare("SELECT replay_of_run_id, input_snapshot_json FROM automation_runs WHERE parent_run_id = ? AND parent_node_id = 'child'")
    .get(changedReplay.runId) as { replay_of_run_id: string | null; input_snapshot_json: unknown };
  const changedSnapshot = (typeof changedChild.input_snapshot_json === "string" ? JSON.parse(changedChild.input_snapshot_json) : changedChild.input_snapshot_json) as Record<string, { output: { data: unknown } }>;
  assert.equal(changedChild.replay_of_run_id, null, "changed child input must execute a new child run");
  assert.deepEqual(changedSnapshot["workflow-input"].output.data, { item: { id: 2 } });
});

test("run preflight blocks an unbound credential before any node executes", async () => {
  const owner = await seedOwner();
  const graph: AutomationWorkflowGraph = { schemaVersion: 1, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, timeoutSeconds: 120 }, groups: [], nodes: [
    { id: "manual", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    { id: "input", type: "input.workflow-data", version: 1, name: "Input", description: "", position: { x: 150, y: 0 }, groupId: null, config: { value: { hello: "world" } }, bindings: {}, disabled: false },
    { id: "http", type: "integration.http-request", version: 1, name: "API", description: "", position: { x: 300, y: 0 }, groupId: null, config: { url: "https://example.com", method: "GET", headers: {}, body: {}, credentialSlot: "provider", credentialKind: "bearer", timeoutSeconds: 10, maxAttempts: 1, failureMode: "stop" }, bindings: {}, disabled: false },
    { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 450, y: 0 }, groupId: null, config: { outcome: "completed", message: "done" }, bindings: {}, disabled: false },
  ], edges: [
    { id: "a", source: "manual", sourcePort: "run", target: "input", targetPort: "run" },
    { id: "b", source: "input", sourcePort: "data", target: "http", targetPort: "data" },
    { id: "c", source: "http", sourcePort: "response", target: "finish", targetPort: "data" },
  ] };
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Credential preflight" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph });
  const result = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.equal(result.status, 409);
  assert.match("error" in result ? result.error : "", /Connect credential slot/);
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE workflow_id = ?").get(workflow!.workflow.id) as { count: number }).count), 0);
});

test("run preflight blocks a missing child workflow connection before queuing the parent", async () => {
  const owner = await seedOwner();
  const parentGraph = mapGraph();
  const parent = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Invalid child mapping" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: parent!.workflow.id, baseDraftVersionId: parent!.draft!.id, graph: parentGraph });
  const live = await repository.publishAutomationWorkflow(owner.userId, parent!.workflow.id);
  assert.equal(live?.published, false);
  assert.match(live?.validation.issues[0]?.message || "", /Connect workflow slot/);
  const result = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: parent!.workflow.id, runtimeInputs: { "workflow-input.value": [{ id: 1 }] }, mode: "test" });
  assert.equal(result.status, 409);
  assert.match("error" in result ? result.error : "", /Connect workflow slot/);
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE workflow_id = ?").get(parent!.workflow.id) as { count: number }).count), 0);
});

test("the root workflow depth limit governs the entire nested execution tree", async () => {
  const owner = await seedOwner();
  const leaf = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Leaf" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: leaf!.workflow.id, baseDraftVersionId: leaf!.draft!.id, graph: childGraph() });
  await repository.publishAutomationWorkflow(owner.userId, leaf!.workflow.id);

  const middle = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Middle" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: middle!.workflow.id, baseDraftVersionId: middle!.draft!.id, graph: nestedGraph("leaf") });
  await credentials.bindAutomationSubworkflow({ userId: owner.userId, workflowId: middle!.workflow.id, workspaceId: owner.workspaceId, slotKey: "leaf", targetWorkflowId: leaf!.workflow.id });
  await repository.publishAutomationWorkflow(owner.userId, middle!.workflow.id);

  const rootGraph = nestedGraph("middle");
  rootGraph.settings = { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, ...rootGraph.settings, maxSubworkflowDepth: 1 };
  const root = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Root" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: root!.workflow.id, baseDraftVersionId: root!.draft!.id, graph: rootGraph });
  await credentials.bindAutomationSubworkflow({ userId: owner.userId, workflowId: root!.workflow.id, workspaceId: owner.workspaceId, slotKey: "middle", targetWorkflowId: middle!.workflow.id });
  const result = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: root!.workflow.id, runtimeInputs: { "workflow-input.value": { hello: "world" } }, mode: "test" });
  assert.equal(result.status, 409);
  assert.match("error" in result ? result.error : "", /root workflow limit/);
});

test("credential vault encrypts payloads and never lists secret material", async () => {
  process.env.AUTOMATION_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const owner = await seedOwner();
  const created = await credentials.createAutomationCredential({ userId: owner.userId, workspaceId: owner.workspaceId, name: "API", kind: "bearer", payload: { token: "super-secret-token-value" } });
  assert.ok(created?.id);
  await assert.rejects(
    credentials.createAutomationCredential({ userId: owner.userId, workspaceId: owner.workspaceId, name: "Ambiguous", kind: "bearer", payload: { value: "old-alias" } }),
    /require exactly: token/,
  );
  await assert.rejects(
    credentials.createAutomationCredential({ userId: owner.userId, workspaceId: owner.workspaceId, name: "Managed header", kind: "header", payload: { headerName: "Host", value: "example.com" } }),
    /managed by Scenelith/,
  );
  const stored = await db.prepare("SELECT encrypted_payload FROM automation_credentials WHERE id = ?").get(created!.id) as { encrypted_payload: string };
  assert.ok(!stored.encrypted_payload.includes("super-secret-token-value"));
  const listed = await credentials.listAutomationCredentials(owner.userId, owner.workspaceId);
  assert.ok(listed && !JSON.stringify(listed).includes("super-secret-token-value") && !JSON.stringify(listed).includes("encrypted_payload"));

  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Credential owner" });
  await credentials.bindAutomationCredential({ userId: owner.userId, workflowId: workflow!.workflow.id, workspaceId: owner.workspaceId, slotKey: "provider", credentialId: created!.id });
  const unbound = await credentials.unbindAutomationWorkflowSlot({ userId: owner.userId, workflowId: workflow!.workflow.id, workspaceId: owner.workspaceId, slotKey: "provider" });
  assert.equal(unbound?.deleted, true);

  const outsider = await seedOwner();
  const outsiderCredential = await credentials.createAutomationCredential({ userId: outsider.userId, workspaceId: outsider.workspaceId, name: "Other tenant", kind: "bearer", payload: { token: "other-secret-token" } });
  await assert.rejects(credentials.bindAutomationCredential({ userId: owner.userId, workflowId: workflow!.workflow.id, workspaceId: owner.workspaceId, slotKey: "foreign", credentialId: outsiderCredential!.id }), /same workspace/);
});

test("webhook triggers are paused by default and enqueue only after token verification", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Webhook" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  await repository.publishAutomationWorkflow(owner.userId, workflow!.workflow.id);
  const created = await triggers.createAutomationWorkflowTrigger({ userId: owner.userId, workflowId: workflow!.workflow.id, projectId: owner.projectId, type: "webhook", name: "Incoming", config: {}, inputs: {} });
  assert.equal(created?.trigger.status, "paused");
  assert.equal(await triggers.fireAutomationWebhook(created!.trigger.id, created!.token!, { hello: "world" }), null);
  await triggers.setAutomationWorkflowTriggerStatus(owner.userId, created!.trigger.id, "active");
  assert.equal(await triggers.fireAutomationWebhook(created!.trigger.id, "wrong", {}), null);
  const queued = await triggers.fireAutomationWebhook(created!.trigger.id, created!.token!, { hello: "world" }, "event-1");
  assert.ok(queued?.deliveryId);
  const duplicate = await triggers.fireAutomationWebhook(created!.trigger.id, created!.token!, { hello: "world" }, "event-1");
  assert.equal(duplicate?.deliveryId, queued?.deliveryId);
  assert.equal(duplicate?.deduplicated, true);
  const beforeDelivery = await db.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE trigger_id = ?").get(created!.trigger.id) as { count: number };
  assert.equal(Number(beforeDelivery.count), 0);
  await deliveries.drainAutomationTriggerDeliveries();
  const delivery = await db.prepare("SELECT status, run_id FROM automation_trigger_deliveries WHERE id = ?").get(queued!.deliveryId) as { status: string; run_id: string };
  assert.equal(delivery.status, "delivered");
  await runs.drainAutomationWorkflowRuns();
  const run = await runs.getAutomationWorkflowRun(owner.userId, delivery.run_id);
  assert.equal(run?.status, "completed");
  assert.equal(run?.runKind, "trigger");
  const changed = await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: null, graph: childGraph() });
  const republished = await repository.publishAutomationWorkflow(owner.userId, workflow!.workflow.id);
  assert.equal(republished?.published, false);
  assert.match(republished?.validation.issues[0]?.message || "", /Active trigger .* incompatible/);
  assert.ok(changed?.draft);
  const trigger = await db.prepare("SELECT status FROM automation_workflow_triggers WHERE id = ?").get(created!.trigger.id) as { status: string };
  assert.equal(trigger.status, "active");
  await assert.rejects(triggers.createAutomationWorkflowTrigger({ userId: owner.userId, workflowId: workflow!.workflow.id, projectId: owner.projectId, type: "canvas-event", name: "Unknown", config: { event: "project.updated" }, inputs: {} }), /supported canvas event/);
  const deleted = await triggers.deleteAutomationWorkflowTrigger(owner.userId, created!.trigger.id);
  assert.equal(deleted?.id, created!.trigger.id);
  assert.equal(await db.prepare("SELECT id FROM automation_workflow_triggers WHERE id = ?").get(created!.trigger.id), undefined);
});

test("an accepted trigger delivery keeps its exact live version and admission snapshot", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Pinned webhook" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  const firstLive = await repository.publishAutomationWorkflow(owner.userId, workflow!.workflow.id);
  const firstVersionId = firstLive!.detail!.published!.id;
  const created = await triggers.createAutomationWorkflowTrigger({
    userId: owner.userId,
    workflowId: workflow!.workflow.id,
    projectId: owner.projectId,
    type: "webhook",
    name: "Pinned incoming",
    overlapPolicy: "skip",
    maxConcurrentRuns: 2,
    config: {},
    inputs: {},
  });
  await triggers.setAutomationWorkflowTriggerStatus(owner.userId, created!.trigger.id, "active");
  const accepted = await triggers.fireAutomationWebhook(created!.trigger.id, created!.token!, { exact: "v1" }, "pinned-v1");
  assert.ok(accepted?.deliveryId);

  const secondGraph = structuredClone(finishGraph("completed"));
  secondGraph.nodes.find((node) => node.id === "finish")!.config.message = "v2";
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: null, graph: secondGraph });
  const secondLive = await repository.publishAutomationWorkflow(owner.userId, workflow!.workflow.id);
  const secondVersionId = secondLive!.detail!.published!.id;
  assert.notEqual(secondVersionId, firstVersionId);
  const active = await db.prepare("SELECT active_version_id FROM automation_workflow_triggers WHERE id = ?").get(created!.trigger.id) as { active_version_id: string };
  assert.equal(active.active_version_id, secondVersionId);

  const snapshot = await db.prepare(`SELECT workflow_version_id, trigger_key, overlap_policy, max_concurrent_runs, payload_json, deployment_json
    FROM automation_trigger_deliveries WHERE id = ?`).get(accepted!.deliveryId) as {
      workflow_version_id: string; trigger_key: string; overlap_policy: string; max_concurrent_runs: number; payload_json: unknown; deployment_json: unknown;
    };
  assert.equal(snapshot.workflow_version_id, firstVersionId);
  assert.equal(snapshot.trigger_key, created!.trigger.id);
  assert.equal(snapshot.overlap_policy, "skip");
  assert.equal(snapshot.max_concurrent_runs, 2);
  const payloadSnapshot = typeof snapshot.payload_json === "string" ? JSON.parse(snapshot.payload_json) : snapshot.payload_json;
  const deploymentSnapshot = typeof snapshot.deployment_json === "string" ? JSON.parse(snapshot.deployment_json) : snapshot.deployment_json;
  assert.deepEqual(payloadSnapshot, { contractVersion: 1, type: "webhook", payload: { exact: "v1" } });
  assert.deepEqual(deploymentSnapshot, { version: 1, workflows: { [workflow!.workflow.id]: { credentials: {}, subworkflows: {} } } });

  await deliveries.drainAutomationTriggerDeliveries();
  stopScheduledWorkflowDrain();
  const storedRun = await db.prepare("SELECT id, workflow_version_id, overlap_policy, max_concurrent_runs, trigger_payload_json FROM automation_runs WHERE trigger_delivery_id = ?")
    .get(accepted!.deliveryId) as { id: string; workflow_version_id: string; overlap_policy: string; max_concurrent_runs: number; trigger_payload_json: unknown };
  assert.equal(storedRun.workflow_version_id, firstVersionId);
  assert.equal(storedRun.overlap_policy, "skip");
  assert.equal(storedRun.max_concurrent_runs, 2);
  assert.deepEqual(
    typeof storedRun.trigger_payload_json === "string" ? JSON.parse(storedRun.trigger_payload_json) : storedRun.trigger_payload_json,
    payloadSnapshot,
  );
  await runs.drainAutomationWorkflowRuns();
  const completed = await runs.getAutomationWorkflowRun(owner.userId, storedRun.id);
  assert.equal(completed?.status, "completed");
  assert.equal((completed?.output as { finish?: { result?: { message?: string } } })?.finish?.result?.message, "completed");
});

test("product events survive the request boundary and fan out idempotently", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Product event" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  await repository.publishAutomationWorkflow(owner.userId, workflow!.workflow.id);
  const created = await triggers.createAutomationWorkflowTrigger({
    userId: owner.userId,
    workflowId: workflow!.workflow.id,
    projectId: owner.projectId,
    type: "canvas-event",
    name: "Generation complete",
    config: { event: "generation.completed", version: 1 },
    inputs: {},
  });
  await triggers.setAutomationWorkflowTriggerStatus(owner.userId, created!.trigger.id, "active");
  const outsider = await seedOwner();
  assert.equal(await triggers.fireAutomationCanvasEvent({
    userId: outsider.userId,
    projectId: owner.projectId,
    event: "generation.completed",
    payload: { generationId: "forbidden", nodeId: "node-1", assetId: "asset-1", mediaType: "image", operation: "generation" },
  }), null);
  const event = await triggers.fireAutomationCanvasEvent({
    userId: owner.userId,
    projectId: owner.projectId,
    event: "generation.completed",
    payload: { generationId: "generation-1", nodeId: "node-1", assetId: "asset-1", mediaType: "image", operation: "generation" },
    sourceKey: "generation:generation-1",
  });
  assert.equal(event?.status, "queued");
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS count FROM automation_trigger_deliveries WHERE trigger_id = ?").get(created!.trigger.id) as { count: number }).count), 0);
  const duplicate = await triggers.fireAutomationCanvasEvent({
    userId: owner.userId,
    projectId: owner.projectId,
    event: "generation.completed",
    payload: { generationId: "generation-1", nodeId: "node-1", assetId: "asset-1", mediaType: "image", operation: "generation" },
    sourceKey: "generation:generation-1",
  });
  assert.equal(duplicate?.eventId, event?.eventId);
  assert.equal(duplicate?.deduplicated, true);
  assert.equal(await triggers.drainAutomationProductEvents(), 1);
  const outbox = await db.prepare("SELECT status, attempts FROM automation_product_event_outbox WHERE id = ?").get(event!.eventId) as { status: string; attempts: number };
  assert.deepEqual(outbox, { status: "delivered", attempts: 1 });
  const delivery = await db.prepare("SELECT id FROM automation_trigger_deliveries WHERE trigger_id = ?").get(created!.trigger.id) as { id: string };
  assert.ok(delivery.id);
  await deliveries.drainAutomationTriggerDeliveries();
  await runs.drainAutomationWorkflowRuns();
  const triggered = await db.prepare("SELECT status FROM automation_runs WHERE trigger_delivery_id = ?").get(delivery.id) as { status: string };
  assert.equal(triggered.status, "completed");
});

test("trigger overlap policies skip or supersede runs before worker admission", async () => {
  for (const overlapPolicy of ["skip", "cancel-previous"] as const) {
    const owner = await seedOwner();
    const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: `Overlap ${overlapPolicy}` });
    await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
    await repository.publishAutomationWorkflow(owner.userId, workflow!.workflow.id);
    const created = await triggers.createAutomationWorkflowTrigger({
      userId: owner.userId,
      workflowId: workflow!.workflow.id,
      projectId: owner.projectId,
      type: "webhook",
      name: `Incoming ${overlapPolicy}`,
      overlapPolicy,
      maxConcurrentRuns: 1,
      config: {},
      inputs: {},
    });
    await triggers.setAutomationWorkflowTriggerStatus(owner.userId, created!.trigger.id, "active");
    await triggers.fireAutomationWebhook(created!.trigger.id, created!.token!, { sequence: 1 }, `${overlapPolicy}-1`);
    await deliveries.drainAutomationTriggerDeliveries(1);
    stopScheduledWorkflowDrain();
    await triggers.fireAutomationWebhook(created!.trigger.id, created!.token!, { sequence: 2 }, `${overlapPolicy}-2`);
    await deliveries.drainAutomationTriggerDeliveries(1);
    stopScheduledWorkflowDrain();
    const rows = await db.prepare("SELECT id, status, error_code FROM automation_runs WHERE trigger_id = ? ORDER BY created_at, id")
      .all(created!.trigger.id) as Array<{ id: string; status: string; error_code: string | null }>;
    assert.equal(rows.length, 2);
    if (overlapPolicy === "skip") {
      assert.deepEqual(rows.map((row) => row.status).sort(), ["cancelled", "queued"]);
      assert.equal(rows.find((row) => row.status === "cancelled")?.error_code, "OVERLAP_SKIPPED");
    } else {
      assert.equal(rows[0].status, "cancelled");
      assert.equal(rows[0].error_code, "OVERLAP_CANCELLED");
      assert.equal(rows[1].status, "queued");
    }
    await runs.drainAutomationWorkflowRuns();
    const survivor = rows.find((row) => row.status === "queued");
    assert.equal((await runs.getAutomationWorkflowRun(owner.userId, survivor!.id))?.status, "completed");
  }
});

test("a dead trigger delivery creates one durable notification and self-host acknowledges it in-app", {
  skip: process.env.SCENELITH_TEST_EDITION === "cloud" ? "Cloud notification delivery is covered by the private adapter suite" : false,
}, async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Delivery alert" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  await repository.publishAutomationWorkflow(owner.userId, workflow!.workflow.id);
  const created = await triggers.createAutomationWorkflowTrigger({ userId: owner.userId, workflowId: workflow!.workflow.id, projectId: owner.projectId, type: "webhook", name: "Alert source", config: {}, inputs: {} });
  await triggers.setAutomationWorkflowTriggerStatus(owner.userId, created!.trigger.id, "active");
  const queued = await triggers.fireAutomationWebhook(created!.trigger.id, created!.token!, { event: "orphaned" }, "dead-letter-alert");
  await db.prepare("DELETE FROM users WHERE id = ?").run(owner.userId);
  await deliveries.drainAutomationTriggerDeliveries();
  const delivery = await db.prepare("SELECT status FROM automation_trigger_deliveries WHERE id = ?").get(queued!.deliveryId) as { status: string };
  assert.equal(delivery.status, "dead_letter");
  assert.equal(await notifications.drainAutomationNotifications(), 1);
  const outbox = await db.prepare("SELECT status, channel, attempts FROM automation_notification_outbox WHERE payload_json ->> 'deliveryId' = ?")
    .get(queued!.deliveryId) as { status: string; channel: string; attempts: number };
  assert.deepEqual(outbox, { status: "delivered", channel: "in-app", attempts: 1 });
});

test("retention removes expired run trees while current automation history remains", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Retention" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  stopScheduledWorkflowDrain();
  await runs.drainAutomationWorkflowRuns();
  if (!("runId" in queued)) throw new Error("Run was not queued");
  const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString();
  await db.prepare("UPDATE automation_runs SET completed_at = ?, updated_at = ? WHERE id = ?").run(old, old, queued.runId);
  const previous = process.env.AUTOMATION_SUCCESSFUL_RUN_RETENTION_DAYS;
  process.env.AUTOMATION_SUCCESSFUL_RUN_RETENTION_DAYS = "30";
  try {
    const cleaned = await retention.cleanupAutomationRetention(20);
    assert.equal(cleaned.counts.successfulRuns, 1);
    assert.equal(await db.prepare("SELECT id FROM automation_runs WHERE id = ?").get(queued.runId), undefined);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_SUCCESSFUL_RUN_RETENTION_DAYS;
    else process.env.AUTOMATION_SUCCESSFUL_RUN_RETENTION_DAYS = previous;
  }
});
