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

test("a draft test run is pinned, observable and side-effect mode aware", async () => {
  const owner = await seedOwner();
  const workflow = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Draft test" });
  const saved = await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: workflow!.workflow.id, baseDraftVersionId: workflow!.draft!.id, graph: finishGraph("completed") });
  const production = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "production" });
  assert.equal("error" in production ? production.error : "", "Publish the workflow before running it");
  const queued = await runs.enqueueAutomationWorkflowRun({ userId: owner.userId, projectId: owner.projectId, workflowId: workflow!.workflow.id, runtimeInputs: {}, mode: "test" });
  assert.ok("runId" in queued);
  await runs.drainAutomationWorkflowRuns();
  const run = await runs.getAutomationWorkflowRun(owner.userId, "runId" in queued ? queued.runId : "");
  assert.equal(run?.status, "completed");
  assert.equal(run?.runKind, "test");
  assert.equal(run?.workflowVersionId, saved?.draft?.id);
  assert.deepEqual(run?.events.map((event) => event.type), ["run.queued", "node.started", "node.completed", "node.started", "node.completed", "run.completed"]);
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
  const replay = await runs.retryAutomationWorkflowRun({ userId: owner.userId, runId: failed!.id, nodeId: "finish" });
  assert.ok("runId" in replay);
  if (!("runId" in replay) || !replay.runId) throw new Error("Replay was not queued");
  await runs.drainAutomationWorkflowRuns();
  const replayed = await runs.getAutomationWorkflowRun(owner.userId, replay.runId);
  assert.equal(replayed?.status, "failed");
  assert.equal(replayed?.runKind, "replay");
  assert.equal(replayed?.replayOfRunId, failed?.id);
  assert.equal(replayed?.reusedNodeCount, 1);
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

test("Map creates durable pinned child runs and rejects recursive bindings", async () => {
  const owner = await seedOwner();
  const child = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Child" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: child!.workflow.id, baseDraftVersionId: child!.draft!.id, graph: childGraph() });
  const childPublished = await repository.publishAutomationWorkflow(owner.userId, child!.workflow.id);
  const parent = await repository.createAutomationWorkflow({ userId: owner.userId, projectId: owner.projectId, name: "Parent" });
  await repository.saveAutomationWorkflowDraft({ userId: owner.userId, workflowId: parent!.workflow.id, baseDraftVersionId: parent!.draft!.id, graph: mapGraph() });
  await repository.publishAutomationWorkflow(owner.userId, parent!.workflow.id);
  await credentials.bindAutomationSubworkflow({ userId: owner.userId, workflowId: parent!.workflow.id, workspaceId: owner.workspaceId, slotKey: "item-workflow", targetWorkflowId: child!.workflow.id });
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
  const children = await db.prepare("SELECT status, workflow_version_id, item_index FROM automation_runs WHERE parent_run_id = ? ORDER BY item_index").all(completed!.id) as Array<{ status: string; workflow_version_id: string; item_index: number }>;
  assert.deepEqual(children.map((row) => [row.status, row.item_index]), [["completed", 0], ["completed", 1], ["completed", 2]]);
  assert.ok(children.every((row) => row.workflow_version_id === childPublished!.detail!.published!.id));
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
  await repository.publishAutomationWorkflow(owner.userId, middle!.workflow.id);
  await credentials.bindAutomationSubworkflow({ userId: owner.userId, workflowId: middle!.workflow.id, workspaceId: owner.workspaceId, slotKey: "leaf", targetWorkflowId: leaf!.workflow.id });

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
  assert.equal(republished?.pausedTriggerCount, 1);
  assert.ok(changed?.draft);
  const trigger = await db.prepare("SELECT status FROM automation_workflow_triggers WHERE id = ?").get(created!.trigger.id) as { status: string };
  assert.equal(trigger.status, "paused");
  await assert.rejects(triggers.createAutomationWorkflowTrigger({ userId: owner.userId, workflowId: workflow!.workflow.id, projectId: owner.projectId, type: "canvas-event", name: "Unknown", config: { event: "project.updated" }, inputs: { "workflow-input.value": { hello: "world" } } }), /supported canvas event/);
  const deleted = await triggers.deleteAutomationWorkflowTrigger(owner.userId, created!.trigger.id);
  assert.equal(deleted?.id, created!.trigger.id);
  assert.equal(await db.prepare("SELECT id FROM automation_workflow_triggers WHERE id = ?").get(created!.trigger.id), undefined);
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
