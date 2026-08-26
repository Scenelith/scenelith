import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, userCanAccessProject } from "@/lib/postgres-db";
import { automationWorkflowSettingsSchema, type AutomationWorkflowGraph } from "./types";
import { validateAutomationDeploymentBindings } from "./deployment-validation";
import { getAutomationWorkflow } from "./repository";
import { requireAutomationPermission } from "./permissions";
import { canPerformAutomationAction } from "./permissions";
import { scheduleWorkflowRunDrain } from "./runs";

const jsonObjectSchema = z.record(z.string().max(200), z.unknown());
export const automationFixtureInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  runtimeInputs: jsonObjectSchema.default({}),
  nodeInputs: z.record(z.string().max(120), jsonObjectSchema).default({}),
  sourceRunId: z.string().min(1).optional(),
  sourceNodeId: z.string().min(1).max(120).optional(),
}).strict().superRefine((value, context) => {
  try {
    if (JSON.stringify(value).length > 1_000_000) context.addIssue({ code: "custom", message: "Fixture is larger than the 1 MB safety limit" });
  } catch { context.addIssue({ code: "custom", message: "Fixture must be serializable" }); }
});

function jsonValue<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }

function publicFixture(row: Record<string, unknown>) {
  return {
    id: String(row.id), workflowId: String(row.workflow_id), workflowVersionId: String(row.workflow_version_id),
    workspaceId: String(row.workspace_id), projectId: String(row.project_id), name: String(row.name),
    runtimeInputs: jsonValue(row.runtime_inputs_json), nodeInputs: jsonValue(row.node_inputs_json),
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export async function listAutomationWorkflowFixtures(userId: string, workflowId: string) {
  const workflow = await getAutomationWorkflow(userId, workflowId);
  if (!workflow) return null;
  const canUseFixtures = await canPerformAutomationAction(userId, workflow.workflow.workspaceId, "automation.run")
    || await canPerformAutomationAction(userId, workflow.workflow.workspaceId, "automation.edit");
  if (!canUseFixtures) await requireAutomationPermission(userId, workflow.workflow.workspaceId, "automation.run");
  return (await db.prepare("SELECT * FROM automation_workflow_fixtures WHERE workflow_id = ? ORDER BY updated_at DESC").all(workflowId) as Array<Record<string, unknown>>).map(publicFixture);
}

export async function createAutomationWorkflowFixture(input: { userId: string; workflowId: string; value: z.infer<typeof automationFixtureInputSchema> }) {
  const workflow = await getAutomationWorkflow(input.userId, input.workflowId);
  if (!workflow || !workflow.workflow.projectId) return null;
  await requireAutomationPermission(input.userId, workflow.workflow.workspaceId, "automation.edit");
  const version = workflow.draft || workflow.published;
  if (!version) throw new Error("Workflow has no version for this fixture");
  let workflowVersionId = version.id;
  let nodeInputs = structuredClone(input.value.nodeInputs);
  let runtimeInputs = structuredClone(input.value.runtimeInputs);
  let sourceRunId: string | null = null;
  if (input.value.sourceRunId) {
    const source = await db.prepare("SELECT id, workflow_id, workflow_version_id, project_id, input_json FROM automation_runs WHERE id = ? AND user_id = ?")
      .get(input.value.sourceRunId, input.userId) as { id: string; workflow_id: string; workflow_version_id: string; project_id: string; input_json: unknown } | undefined;
    if (!source || source.workflow_id !== input.workflowId || source.project_id !== workflow.workflow.projectId) throw new Error("Source run does not belong to this workflow and canvas");
    sourceRunId = source.id;
    workflowVersionId = source.workflow_version_id;
    runtimeInputs = jsonValue(source.input_json);
    if (input.value.sourceNodeId) {
      const nodeRun = await db.prepare(`SELECT input_json FROM automation_node_runs WHERE run_id = ? AND node_id = ? AND input_json IS NOT NULL
        ORDER BY attempt DESC LIMIT 1`).get(source.id, input.value.sourceNodeId) as { input_json: unknown } | undefined;
      if (!nodeRun) throw new Error("The selected source run has no captured input for this step");
      nodeInputs = { ...nodeInputs, [input.value.sourceNodeId]: jsonValue(nodeRun.input_json) };
    }
  }
  const payload = automationFixtureInputSchema.parse({ ...input.value, runtimeInputs, nodeInputs });
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO automation_workflow_fixtures
    (id, workflow_id, workflow_version_id, workspace_id, project_id, name, runtime_inputs_json, node_inputs_json, source_run_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.workflowId, workflowVersionId, workflow.workflow.workspaceId, workflow.workflow.projectId, payload.name,
      JSON.stringify(payload.runtimeInputs), JSON.stringify(payload.nodeInputs), sourceRunId, input.userId, now, now);
  return publicFixture((await db.prepare("SELECT * FROM automation_workflow_fixtures WHERE id = ?").get(id)) as Record<string, unknown>);
}

export async function deleteAutomationWorkflowFixture(input: { userId: string; workflowId: string; fixtureId: string }) {
  const workflow = await getAutomationWorkflow(input.userId, input.workflowId);
  if (!workflow) return null;
  await requireAutomationPermission(input.userId, workflow.workflow.workspaceId, "automation.edit");
  const result = await db.prepare("DELETE FROM automation_workflow_fixtures WHERE id = ? AND workflow_id = ?").run(input.fixtureId, input.workflowId);
  return { deleted: result.changes === 1, id: input.fixtureId, workspaceId: workflow.workflow.workspaceId };
}

export async function enqueueAutomationNodePreview(input: { userId: string; workflowId: string; fixtureId: string; nodeId: string }) {
  const fixture = await db.prepare("SELECT * FROM automation_workflow_fixtures WHERE id = ? AND workflow_id = ?").get(input.fixtureId, input.workflowId) as Record<string, unknown> | undefined;
  if (!fixture || !await userCanAccessProject(input.userId, String(fixture.project_id))) return null;
  await requireAutomationPermission(input.userId, String(fixture.workspace_id), "automation.run");
  const versionRow = await db.prepare("SELECT graph_json FROM automation_workflow_versions WHERE id = ? AND workflow_id = ?").get(fixture.workflow_version_id, input.workflowId) as { graph_json: unknown } | undefined;
  if (!versionRow) throw new Error("The workflow version pinned by this fixture is unavailable");
  const graph = jsonValue<AutomationWorkflowGraph>(versionRow.graph_json);
  const node = graph.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node) throw new Error("This step is not present in the fixture's pinned workflow version");
  const previewGraph = { ...graph, nodes: [node], edges: [], groups: [] };
  const deployment = await validateAutomationDeploymentBindings({ workflowId: input.workflowId, workspaceId: String(fixture.workspace_id), graph: previewGraph });
  if (!deployment.valid) throw new Error(deployment.issues.map((issue) => issue.message).join(" "));
  const policy = automationWorkflowSettingsSchema.parse(graph.settings || {});
  const now = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + Math.min(policy.timeoutSeconds, 900) * 1_000).toISOString();
  const id = randomUUID();
  const dedupeKey = createHash("sha256").update(`${input.userId}:${input.fixtureId}:${input.nodeId}:${now}:${randomUUID()}`).digest("hex");
  await db.prepare(`INSERT INTO automation_runs
    (id, workflow_id, workflow_version_id, workspace_id, project_id, user_id, status, run_kind, admission_key, overlap_policy, max_concurrent_runs, preview_node_id, fixture_id,
     stage_label, progress, input_json, policy_json, deployment_json, attempts, max_attempts, available_at, deadline_at, dedupe_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', 'node-preview', ?, 'queue', ?, ?, ?, 'Waiting to preview step', 0, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`)
    .run(id, input.workflowId, fixture.workflow_version_id, fixture.workspace_id, fixture.project_id, input.userId, `preview:${input.workflowId}`, policy.maxConcurrentRuns, input.nodeId, input.fixtureId,
      JSON.stringify(jsonValue(fixture.runtime_inputs_json)), JSON.stringify(policy), JSON.stringify(deployment.snapshot), now, deadlineAt, dedupeKey, now, now);
  scheduleWorkflowRunDrain(50);
  return { status: 202 as const, runId: id, runStatus: "queued" as const, fixtureId: input.fixtureId, nodeId: input.nodeId };
}
