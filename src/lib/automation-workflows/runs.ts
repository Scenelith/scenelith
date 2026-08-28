import { createHash, randomUUID } from "node:crypto";
import { db, userCanAccessProject, workspaceIdForProject } from "@/lib/postgres-db";
import { workerIdentity } from "@/lib/worker-identity";
import { coreAutomationNodeHandlers } from "./node-handlers";
import { validateAutomationDeploymentBindings } from "./deployment-validation";
import type { AutomationDeploymentSnapshot } from "./deployment-validation";
import { getAutomationWorkflow } from "./repository";
import { executeAutomationGraph, executeAutomationNodePreview } from "./runtime";
import { automationWorkflowSettingsSchema, type AutomationNode, type AutomationWorkflowVersion } from "./types";
import { validateAutomationRunInputs, validateAutomationWorkflowGraph } from "./validation";
import { canPerformAutomationAction, requireAutomationPermission } from "./permissions";

type RunStatus = "queued" | "running" | "completed" | "completed_with_warnings" | "failed" | "cancelled";
type RunKind = "production" | "test" | "replay" | "trigger" | "subworkflow" | "node-preview";
type RunRow = {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  workspace_id: string;
  project_id: string;
  user_id: string;
  status: RunStatus;
  run_kind: RunKind;
  admission_key: string;
  overlap_policy: "queue" | "skip" | "cancel-previous";
  max_concurrent_runs: number;
  trigger_id: string | null;
  preview_node_id: string | null;
  fixture_id: string | null;
  parent_run_id: string | null;
  parent_node_id: string | null;
  root_run_id: string | null;
  replay_of_run_id: string | null;
  item_index: number | null;
  execution_depth: number;
  stage_label: string;
  progress: number;
  input_json: unknown;
  output_json: unknown;
  error: string | null;
  error_code: string | null;
  estimated_credits: number;
  charged_credits: number;
  reserved_credits: number;
  warning_count: number;
  reused_node_count: number;
  tree_node_executions: number;
  tree_generated_assets: number;
  policy_json: unknown;
  deployment_json: unknown;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  worker_id: string | null;
  created_at: string;
  started_at: string | null;
  deadline_at: string | null;
  trigger_payload_json?: unknown;
  updated_at: string;
  completed_at: string | null;
};

type RunsGlobal = typeof globalThis & {
  scenelithWorkflowRunDrain?: Promise<void>;
  scenelithWorkflowRunDrainRequested?: boolean;
  scenelithWorkflowRunTimer?: ReturnType<typeof setTimeout>;
  scenelithWorkflowRunActive?: Set<Promise<void>>;
};

const shared = globalThis as RunsGlobal;
const workerId = workerIdentity("automation");
const concurrency = Math.min(8, Math.max(1, Number(process.env.AUTOMATION_WORKFLOW_CONCURRENCY || 3)));
const workspaceConcurrency = Math.min(32, Math.max(1, Number(process.env.AUTOMATION_WORKSPACE_CONCURRENCY || 4)));
const staleAfterMs = Math.max(5 * 60_000, Number(process.env.AUTOMATION_WORKFLOW_STALE_MS || 20 * 60_000));

function jsonValue<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function publicRun(
  row: RunRow,
  nodeRuns: Array<Record<string, unknown>> = [],
  queuePosition: number | null = null,
  events: Array<Record<string, unknown>> = [],
  tree?: { chargedCredits: number; warningCount: number; runCount: number; nodeExecutions: number; generatedAssets: number },
) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    projectId: row.project_id,
    status: row.status,
    runKind: row.run_kind,
    overlapPolicy: row.overlap_policy,
    maxConcurrentRuns: Number(row.max_concurrent_runs || 1),
    triggerId: row.trigger_id,
    previewNodeId: row.preview_node_id,
    fixtureId: row.fixture_id,
    parentRunId: row.parent_run_id,
    parentNodeId: row.parent_node_id,
    replayOfRunId: row.replay_of_run_id,
    stageLabel: row.stage_label,
    progress: Number(row.progress || 0),
    output: row.status === "completed" || row.status === "completed_with_warnings" ? jsonValue(row.output_json) : null,
    error: row.error,
    code: row.error_code,
    attempts: Number(row.attempts || 0),
    estimatedCredits: Number(row.estimated_credits || 0),
    chargedCredits: Number(row.charged_credits || 0),
    treeChargedCredits: tree?.chargedCredits ?? Number(row.charged_credits || 0),
    warningCount: Number(row.warning_count || 0),
    treeWarningCount: tree?.warningCount ?? Number(row.warning_count || 0),
    treeRunCount: tree?.runCount ?? 1,
    treeNodeExecutions: tree?.nodeExecutions ?? Number(row.tree_node_executions || 0),
    treeGeneratedAssets: tree?.generatedAssets ?? Number(row.tree_generated_assets || 0),
    reusedNodeCount: Number(row.reused_node_count || 0),
    queuePosition,
    nodeRuns: nodeRuns.map((item) => ({
      id: String(item.id), nodeId: String(item.node_id), nodeType: String(item.node_type), attempt: Number(item.attempt), status: String(item.status),
      error: item.error ? String(item.error) : null, errorCode: item.error_code ? String(item.error_code) : null, chargedCredits: Number(item.charged_credits || 0), startedAt: item.started_at ? String(item.started_at) : null, completedAt: item.completed_at ? String(item.completed_at) : null,
      outputPorts: jsonValue<string[]>(item.output_ports_json || []), hasCapturedInput: Boolean(item.input_json), reusedFromNodeRunId: item.reused_from_node_run_id ? String(item.reused_from_node_run_id) : null,
      input: row.run_kind === "node-preview" ? jsonValue(item.input_json || {}) : undefined,
      output: row.run_kind === "node-preview" && item.output_json ? jsonValue(item.output_json) : undefined,
    })),
    events: events.map((item) => ({ id: Number(item.id), type: String(item.event_type), nodeRunId: item.node_run_id ? String(item.node_run_id) : null, payload: jsonValue(item.payload_json), createdAt: String(item.created_at) })),
    createdAt: row.created_at,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function workflowVersionById(id: string) {
  const row = await db.prepare("SELECT * FROM automation_workflow_versions WHERE id = ?").get(id) as {
    id: string; workflow_id: string; version: number; status: AutomationWorkflowVersion["status"]; graph_json: unknown; validation_json: unknown; created_by: string | null; created_at: string; published_at: string | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id, workflowId: row.workflow_id, version: Number(row.version), status: row.status,
    graph: jsonValue(row.graph_json), validation: jsonValue(row.validation_json), createdBy: row.created_by, createdAt: row.created_at, publishedAt: row.published_at,
  } as AutomationWorkflowVersion;
}

export async function enqueueAutomationWorkflowRun(input: {
  userId: string;
  projectId: string;
  workflowId: string;
  runtimeInputs: Record<string, unknown>;
  useDraft?: boolean;
  mode?: "production" | "test";
  trigger?: { id: string | null; deliveryId?: string; payload: Record<string, unknown> };
}) {
  if (!await userCanAccessProject(input.userId, input.projectId)) return { status: 404, error: "Canvas not found" } as const;
  const workspaceId = await workspaceIdForProject(input.projectId);
  if (!workspaceId) return { status: 404, error: "Canvas not found" } as const;
  if (!await canPerformAutomationAction(input.userId, workspaceId, "automation.run")) {
    return { status: 403, error: "This workspace role cannot run automations" } as const;
  }
  const detail = await getAutomationWorkflow(input.userId, input.workflowId);
  if (!detail || detail.workflow.workspaceId !== workspaceId || (detail.workflow.projectId && detail.workflow.projectId !== input.projectId)) {
    return { status: 404, error: "Workflow not found" } as const;
  }
  const runKind: RunKind = input.trigger ? "trigger" : input.mode === "test" || input.useDraft ? "test" : "production";
  if (runKind === "test" && !await canPerformAutomationAction(input.userId, workspaceId, "automation.edit")) {
    return { status: 403, error: "This workspace role cannot test unpublished automation drafts" } as const;
  }
  const version = runKind === "test" ? detail.draft || detail.published : detail.published;
  if (!version) return { status: 409, error: runKind === "test" ? "Workflow has no version to test" : "Publish the workflow before running it" } as const;
  const validation = validateAutomationWorkflowGraph(version.graph);
  if (!validation.valid) return { status: 422, error: "Fix workflow validation issues before running", validation } as const;
  const runInputValidation = validateAutomationRunInputs(version.graph, input.runtimeInputs);
  if (!runInputValidation.valid) return { status: 400, error: runInputValidation.issues.map((entry) => entry.message).join(" "), validation: runInputValidation } as const;
  const deploymentValidation = await validateAutomationDeploymentBindings({ workflowId: input.workflowId, workspaceId, graph: version.graph });
  if (!deploymentValidation.valid) return { status: 409, error: deploymentValidation.issues.map((entry) => entry.message).join(" "), validation: deploymentValidation } as const;

  const now = new Date().toISOString();
  const policy = automationWorkflowSettingsSchema.parse(version.graph.settings || {});
  const triggerAdmission = input.trigger?.id
    ? await db.prepare("SELECT overlap_policy, max_concurrent_runs FROM automation_workflow_triggers WHERE id = ?").get(input.trigger.id) as { overlap_policy: typeof policy.overlapPolicy; max_concurrent_runs: number } | undefined
    : undefined;
  const overlapPolicy = triggerAdmission?.overlap_policy || policy.overlapPolicy;
  const maxConcurrentRuns = Math.min(32, Math.max(1, Number(triggerAdmission?.max_concurrent_runs || policy.maxConcurrentRuns)));
  const admissionKey = input.trigger?.id ? `trigger:${input.trigger.id}` : `workflow:${input.workflowId}`;
  const deadlineAt = new Date(Date.now() + policy.timeoutSeconds * 1_000).toISOString();
  const requestJson = canonicalJson(input.runtimeInputs);
  const triggerJson = input.trigger ? canonicalJson(input.trigger.payload) : "";
  const dedupeKey = createHash("sha256").update(`${input.userId}:${input.projectId}:${version.id}:${runKind}:${requestJson}:${triggerJson}`).digest("hex");
  const queued = await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-admission:${admissionKey}`);
    if (input.trigger?.deliveryId) {
      const delivered = await db.prepare("SELECT id, status FROM automation_runs WHERE trigger_delivery_id = ? LIMIT 1")
        .get(input.trigger.deliveryId) as { id: string; status: RunStatus } | undefined;
      if (delivered) return { status: 202 as const, runId: delivered.id, runStatus: delivered.status, deduplicated: true };
    }
    const existing = await db.prepare("SELECT id, status FROM automation_runs WHERE user_id = ? AND dedupe_key = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
      .get(input.userId, dedupeKey) as { id: string; status: RunStatus } | undefined;
    if (existing) return { status: 202 as const, runId: existing.id, runStatus: existing.status, deduplicated: true };
    const id = randomUUID();
    const active = await db.prepare(`SELECT id FROM automation_runs WHERE admission_key = ? AND parent_run_id IS NULL
      AND status IN ('queued','running') ORDER BY created_at FOR UPDATE`).all(admissionKey) as Array<{ id: string }>;
    if (overlapPolicy === "cancel-previous" && active.length) {
      const activeIds = active.map((run) => run.id);
      await db.prepare(`UPDATE automation_runs SET status = 'cancelled', stage_label = 'Superseded by a newer run', error = NULL,
        error_code = 'OVERLAP_CANCELLED', locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
        WHERE (id = ANY(?::text[]) OR root_run_id = ANY(?::text[])) AND status IN ('queued','running')`)
        .run(now, now, activeIds, activeIds);
      await db.prepare(`UPDATE automation_run_budget_reservations SET status = 'released', actual_credits = 0, updated_at = ?
        WHERE run_id IN (SELECT id FROM automation_runs WHERE id = ANY(?::text[]) OR root_run_id = ANY(?::text[])) AND status = 'reserved'`)
        .run(now, activeIds, activeIds);
      await db.prepare(`UPDATE automation_runs SET reserved_credits = 0, updated_at = ?
        WHERE id = ANY(?::text[]) OR root_run_id = ANY(?::text[])`).run(now, activeIds, activeIds);
    }
    const skipped = overlapPolicy === "skip" && active.length >= maxConcurrentRuns;
    await db.prepare(`INSERT INTO automation_runs
      (id, workflow_id, workflow_version_id, workspace_id, project_id, user_id, status, run_kind, admission_key, overlap_policy, max_concurrent_runs,
       trigger_id, trigger_delivery_id, trigger_payload_json, stage_label, progress, input_json, policy_json, deployment_json,
       estimated_credits, charged_credits, reserved_credits, attempts, max_attempts, available_at, deadline_at, dedupe_key, created_at, updated_at, completed_at, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 2, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.workflowId, version.id, workspaceId, input.projectId, input.userId, skipped ? "cancelled" : "queued", runKind,
        admissionKey, overlapPolicy, maxConcurrentRuns, input.trigger?.id || null, input.trigger?.deliveryId || null,
        input.trigger ? JSON.stringify(input.trigger.payload) : null, skipped ? "Skipped because another run is active" : "Waiting for an automation slot",
        skipped ? 100 : 0, requestJson, JSON.stringify(policy), JSON.stringify(deploymentValidation.snapshot), now, deadlineAt, dedupeKey, now, now,
        skipped ? now : null, skipped ? "OVERLAP_SKIPPED" : null);
    await appendEvent(id, skipped ? "run.overlap_skipped" : "run.queued", { runKind, workflowVersionId: version.id, admissionKey, overlapPolicy, maxConcurrentRuns });
    scheduleWorkflowRunDrain(50);
    return { status: 202 as const, runId: id, runStatus: skipped ? "cancelled" as const : "queued" as const, deduplicated: false, overlapDecision: skipped ? "skipped" as const : overlapPolicy === "cancel-previous" && active.length ? "cancelled-previous" as const : "queued" as const };
  })();
  return queued;
}

export async function getAutomationWorkflowRun(userId: string, runId: string) {
  const row = await db.prepare("SELECT * FROM automation_runs WHERE id = ? AND user_id = ?").get(runId, userId) as RunRow | undefined;
  if (!row || !await userCanAccessProject(userId, row.project_id)) return null;
  const nodeRuns = await db.prepare("SELECT id, node_id, node_type, attempt, status, input_json, output_json, error, error_code, charged_credits, output_ports_json, reused_from_node_run_id, started_at, completed_at FROM automation_node_runs WHERE run_id = ? ORDER BY created_at, attempt")
    .all(runId) as Array<Record<string, unknown>>;
  const events = await db.prepare("SELECT id, event_type, node_run_id, payload_json, created_at FROM automation_run_events WHERE run_id = ? ORDER BY id").all(runId) as Array<Record<string, unknown>>;
  const queuePosition = row.status === "queued" ? Number((await db.prepare(`SELECT COUNT(*) AS count FROM automation_runs
    WHERE status IN ('queued','running') AND created_at <= (SELECT created_at FROM automation_runs WHERE id = ?)`)
    .get(runId) as { count: number }).count) : null;
  const rootRunId = row.root_run_id || row.id;
  const totals = await db.prepare(`SELECT COALESCE(SUM(charged_credits), 0) AS charged, COALESCE(SUM(warning_count), 0) AS warnings,
    COUNT(*) AS run_count FROM automation_runs WHERE id = ? OR root_run_id = ?`).get(rootRunId, rootRunId) as { charged: number; warnings: number; run_count: number };
  const root = rootRunId === row.id ? row : await db.prepare("SELECT tree_node_executions, tree_generated_assets FROM automation_runs WHERE id = ?").get(rootRunId) as Pick<RunRow, "tree_node_executions" | "tree_generated_assets"> | undefined;
  return publicRun(row, nodeRuns, queuePosition, events, {
    chargedCredits: Number(totals.charged || 0), warningCount: Number(totals.warnings || 0), runCount: Number(totals.run_count || 0),
    nodeExecutions: Number(root?.tree_node_executions || 0), generatedAssets: Number(root?.tree_generated_assets || 0),
  });
}

export async function getAutomationWorkflowNodeRunDetails(userId: string, runId: string, nodeId: string) {
  const run = await db.prepare("SELECT project_id FROM automation_runs WHERE id = ? AND user_id = ?").get(runId, userId) as { project_id: string } | undefined;
  if (!run || !await userCanAccessProject(userId, run.project_id)) return null;
  const rows = await db.prepare(`SELECT id, node_id, node_type, attempt, status, input_json, output_json, error, error_code,
    charged_credits, output_ports_json, reused_from_node_run_id, started_at, completed_at
    FROM automation_node_runs WHERE run_id = ? AND node_id = ? ORDER BY attempt DESC, created_at DESC`).all(runId, nodeId) as Array<Record<string, unknown>>;
  return rows.map((item) => ({
    id: String(item.id),
    nodeId: String(item.node_id),
    nodeType: String(item.node_type),
    attempt: Number(item.attempt),
    status: String(item.status),
    input: jsonValue(item.input_json || {}),
    output: item.output_json ? jsonValue(item.output_json) : null,
    error: item.error ? String(item.error) : null,
    errorCode: item.error_code ? String(item.error_code) : null,
    chargedCredits: Number(item.charged_credits || 0),
    outputPorts: jsonValue<string[]>(item.output_ports_json || []),
    reusedFromNodeRunId: item.reused_from_node_run_id ? String(item.reused_from_node_run_id) : null,
    startedAt: item.started_at ? String(item.started_at) : null,
    completedAt: item.completed_at ? String(item.completed_at) : null,
  }));
}

export async function listAutomationWorkflowRuns(input: {
  userId: string;
  projectId: string;
  workflowId?: string;
  before?: string;
  limit?: number;
}) {
  if (!await userCanAccessProject(input.userId, input.projectId)) return null;
  const limit = Math.min(100, Math.max(1, Number(input.limit || 30)));
  const before = input.before && Number.isFinite(new Date(input.before).getTime()) ? new Date(input.before).toISOString() : null;
  const clauses = ["user_id = ?", "project_id = ?", "parent_run_id IS NULL"];
  const parameters: unknown[] = [input.userId, input.projectId];
  if (input.workflowId) { clauses.push("workflow_id = ?"); parameters.push(input.workflowId); }
  if (before) { clauses.push("created_at < ?"); parameters.push(before); }
  parameters.push(limit);
  const rows = await db.prepare(`SELECT * FROM automation_runs WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters) as RunRow[];
  return rows.map((row) => publicRun(row));
}

export async function reserveAutomationTreeUsage(runId: string, kind: "node" | "asset", amount = 1, usageKey?: string) {
  const requested = Math.max(1, Math.floor(amount));
  await db.transaction(async () => {
    const run = await db.prepare("SELECT root_run_id FROM automation_runs WHERE id = ?").get(runId) as { root_run_id: string | null } | undefined;
    if (!run) throw Object.assign(new Error("Automation run is unavailable"), { code: "RUN_LEASE_LOST" });
    const rootRunId = run.root_run_id || runId;
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-run-usage:${rootRunId}`);
    if (kind === "asset" && usageKey) {
      const existing = await db.prepare(`SELECT 1 AS found FROM automation_tree_usage_reservations
        WHERE run_id = ? AND kind = 'asset' AND usage_key = ?`).get(runId, usageKey);
      if (existing) return;
    }
    const root = await db.prepare("SELECT policy_json, tree_node_executions, tree_generated_assets FROM automation_runs WHERE id = ? FOR UPDATE").get(rootRunId) as Pick<RunRow, "policy_json" | "tree_node_executions" | "tree_generated_assets"> | undefined;
    if (!root) throw Object.assign(new Error("Root automation run is unavailable"), { code: "RUN_LEASE_LOST" });
    const policy = automationWorkflowSettingsSchema.parse(jsonValue(root.policy_json) || {});
    const column = kind === "node" ? "tree_node_executions" : "tree_generated_assets";
    const current = kind === "node" ? Number(root.tree_node_executions || 0) : Number(root.tree_generated_assets || 0);
    const maximum = kind === "node" ? policy.maxNodeExecutions : policy.maxGeneratedAssets;
    if (current + requested > maximum) {
      const label = kind === "node" ? "step execution" : "generated asset";
      const code = kind === "node" ? "NODE_EXECUTION_LIMIT" : "GENERATED_ASSET_LIMIT";
      throw Object.assign(new Error(`Workflow tree exceeded its ${maximum} ${label} limit`), { code });
    }
    if (kind === "asset" && usageKey) {
      await db.prepare(`INSERT INTO automation_tree_usage_reservations (run_id, root_run_id, kind, usage_key, amount, created_at)
        VALUES (?, ?, 'asset', ?, ?, ?)`).run(runId, rootRunId, usageKey, requested, new Date().toISOString());
    }
    await db.prepare(`UPDATE automation_runs SET ${column} = ${column} + ?, updated_at = ? WHERE id = ?`).run(requested, new Date().toISOString(), rootRunId);
  })();
}

async function reserveAutomationRunBudget(runId: string, nodeId: string, requestedCredits: number) {
  const requested = Math.max(0, Math.ceil(Number(requestedCredits) || 0));
  if (!requested) return null;
  return await db.transaction(async () => {
    const run = await db.prepare("SELECT status, root_run_id, policy_json FROM automation_runs WHERE id = ?").get(runId) as Pick<RunRow, "status" | "root_run_id" | "policy_json"> | undefined;
    if (!run || run.status !== "running") throw Object.assign(new Error("Automation is no longer running"), { code: "RUN_LEASE_LOST" });
    const rootRunId = run.root_run_id || runId;
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-run-budget:${rootRunId}`);
    const root = await db.prepare("SELECT policy_json FROM automation_runs WHERE id = ?").get(rootRunId) as { policy_json: unknown } | undefined;
    const totals = await db.prepare(`SELECT COALESCE(SUM(charged_credits),0) AS charged, COALESCE(SUM(reserved_credits),0) AS reserved
      FROM automation_runs WHERE id = ? OR root_run_id = ?`).get(rootRunId, rootRunId) as { charged: number; reserved: number };
    const policy = automationWorkflowSettingsSchema.parse(jsonValue(root?.policy_json || run.policy_json) || {});
    if (policy.maxCredits !== null && Number(totals.charged || 0) + Number(totals.reserved || 0) + requested > policy.maxCredits) {
      throw Object.assign(new Error(`Workflow credit limit of ${policy.maxCredits} would be exceeded`), { code: "WORKFLOW_BUDGET_EXCEEDED" });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO automation_run_budget_reservations
      (id, run_id, node_id, requested_credits, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'reserved', ?, ?)`).run(id, runId, nodeId, requested, now, now);
    await db.prepare("UPDATE automation_runs SET reserved_credits = reserved_credits + ?, updated_at = ? WHERE id = ?")
      .run(requested, now, runId);
    return id;
  })();
}

async function settleAutomationRunBudget(reservationId: string | null, actualCredits: number) {
  if (!reservationId) return;
  await db.transaction(async () => {
    const reservation = await db.prepare("SELECT run_id, requested_credits, status FROM automation_run_budget_reservations WHERE id = ? FOR UPDATE")
      .get(reservationId) as { run_id: string; requested_credits: number; status: string } | undefined;
    if (!reservation || reservation.status !== "reserved") return;
    const actual = Math.max(0, Math.ceil(Number(actualCredits) || 0));
    const now = new Date().toISOString();
    await db.prepare("UPDATE automation_run_budget_reservations SET status = 'settled', actual_credits = ?, updated_at = ? WHERE id = ?")
      .run(actual, now, reservationId);
    await db.prepare(`UPDATE automation_runs SET reserved_credits = GREATEST(0, reserved_credits - ?), charged_credits = charged_credits + ?, updated_at = ? WHERE id = ?`)
      .run(reservation.requested_credits, actual, now, reservation.run_id);
  })();
}

async function releaseAutomationRunBudget(reservationId: string | null) {
  if (!reservationId) return;
  await db.transaction(async () => {
    const reservation = await db.prepare("SELECT run_id, requested_credits, status FROM automation_run_budget_reservations WHERE id = ? FOR UPDATE")
      .get(reservationId) as { run_id: string; requested_credits: number; status: string } | undefined;
    if (!reservation || reservation.status !== "reserved") return;
    const now = new Date().toISOString();
    await db.prepare("UPDATE automation_run_budget_reservations SET status = 'released', actual_credits = 0, updated_at = ? WHERE id = ?").run(now, reservationId);
    await db.prepare("UPDATE automation_runs SET reserved_credits = GREATEST(0, reserved_credits - ?), updated_at = ? WHERE id = ?")
      .run(reservation.requested_credits, now, reservation.run_id);
  })();
}

async function releaseOpenAutomationRunBudget(runId: string) {
  await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-run-budget:${runId}`);
    const now = new Date().toISOString();
    await db.prepare("UPDATE automation_run_budget_reservations SET status = 'released', actual_credits = 0, updated_at = ? WHERE run_id = ? AND status = 'reserved'")
      .run(now, runId);
    await db.prepare("UPDATE automation_runs SET reserved_credits = 0, updated_at = ? WHERE id = ?").run(now, runId);
  })();
}

export async function cancelAutomationWorkflowRun(userId: string, runId: string) {
  const row = await db.prepare("SELECT project_id, workspace_id, root_run_id FROM automation_runs WHERE id = ? AND user_id = ?").get(runId, userId) as { project_id: string; workspace_id: string; root_run_id: string | null } | undefined;
  if (!row || !await userCanAccessProject(userId, row.project_id)) return false;
  await requireAutomationPermission(userId, row.workspace_id, "automation.run");
  const rootRunId = row.root_run_id || runId;
  const now = new Date().toISOString();
  const changed = await db.prepare(`UPDATE automation_runs SET status = 'cancelled', stage_label = 'Cancelled', error = NULL, error_code = NULL,
    locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('queued','running')`).run(now, now, rootRunId, userId);
  if (changed.changes === 1) {
    await db.prepare(`UPDATE automation_runs SET status = 'cancelled', stage_label = 'Cancelled with parent', error = NULL, error_code = NULL,
      locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ? WHERE root_run_id = ? AND status IN ('queued','running')`).run(now, now, rootRunId);
    const descendants = await db.prepare("SELECT id FROM automation_runs WHERE root_run_id = ?").all(rootRunId) as Array<{ id: string }>;
    await Promise.all(descendants.map((descendant) => releaseOpenAutomationRunBudget(descendant.id)));
    await releaseOpenAutomationRunBudget(rootRunId);
    await appendEvent(rootRunId, "run.cancelled", { requestedRunId: runId });
  }
  return changed.changes === 1;
}

export async function retryAutomationWorkflowRun(input: { userId: string; runId: string; nodeId?: string }) {
  const source = await db.prepare("SELECT * FROM automation_runs WHERE id = ? AND user_id = ?").get(input.runId, input.userId) as RunRow | undefined;
  if (!source || !await userCanAccessProject(input.userId, source.project_id)) return { status: 404, error: "Automation run not found" } as const;
  if (!await canPerformAutomationAction(input.userId, source.workspace_id, "automation.run")) return { status: 403, error: "This workspace role cannot run automations" } as const;
  if (source.parent_run_id) return { status: 409, error: "Retry the parent automation run; child runs are recovered as part of their execution tree" } as const;
  if (!["failed", "completed_with_warnings"].includes(source.status)) return { status: 409, error: "Only failed runs or runs with warnings can be retried" } as const;
  const version = await workflowVersionById(source.workflow_version_id);
  if (!version) return { status: 409, error: "The exact workflow version for this run is unavailable" } as const;
  const latestRows = await db.prepare(`SELECT DISTINCT ON (node_id) * FROM automation_node_runs
    WHERE run_id = ? ORDER BY node_id, attempt DESC`).all(source.id) as Array<Record<string, unknown>>;
  const latestByNode = new Map(latestRows.map((row) => [String(row.node_id), row]));
  let selectedNodeId = input.nodeId || "";
  if (!selectedNodeId) {
    selectedNodeId = version.graph.nodes.find((node) => latestByNode.get(node.id)?.status === "failed")?.id || "";
  }
  if (!selectedNodeId && source.status === "completed_with_warnings") {
    selectedNodeId = version.graph.nodes.find((node) => {
      const row = latestByNode.get(node.id);
      const raw = row?.output_json;
      const output = raw ? jsonValue<Record<string, unknown>>(raw) : null;
      return row?.error_code === "FAILURE_POLICY_APPLIED"
        || (Array.isArray(output?.__warnings) && output.__warnings.length > 0)
        || (output?.assets && typeof output.assets === "object" && Array.isArray((output.assets as { failures?: unknown }).failures) && (output.assets as { failures: unknown[] }).failures.length > 0);
    })?.id || "";
  }
  if (!version.graph.nodes.some((node) => node.id === selectedNodeId)) return { status: 400, error: "Choose a step from this run to retry" } as const;

  const invalidated = new Set([selectedNodeId]);
  const pending = [selectedNodeId];
  while (pending.length) {
    const current = pending.shift()!;
    for (const edge of version.graph.edges.filter((candidate) => candidate.source === current)) {
      if (invalidated.has(edge.target)) continue;
      invalidated.add(edge.target);
      pending.push(edge.target);
    }
  }
  const reusable = version.graph.nodes.flatMap((node) => {
    const row = latestByNode.get(node.id);
    return row && row.status === "completed" && !invalidated.has(node.id) && row.output_json ? [row] : [];
  });
  const id = randomUUID();
  const now = new Date().toISOString();
  const policy = automationWorkflowSettingsSchema.parse(jsonValue(source.policy_json) || version.graph.settings || {});
  const deadlineAt = new Date(Date.now() + policy.timeoutSeconds * 1_000).toISOString();
  await db.transaction(async () => {
    await db.prepare(`INSERT INTO automation_runs
      (id, workflow_id, workflow_version_id, workspace_id, project_id, user_id, status, run_kind, admission_key, overlap_policy, max_concurrent_runs, stage_label, progress, input_json, policy_json, deployment_json,
       estimated_credits, charged_credits, reserved_credits, warning_count, reused_node_count, attempts, max_attempts, available_at, deadline_at,
       replay_of_run_id, root_run_id, execution_depth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', 'replay', ?, ?, ?, 'Waiting to retry failed steps', 0, ?, ?, ?, 0, 0, 0, 0, ?, 0, 2, ?, ?, ?, ?, ?, ?, ?)`)
      // A manual retry is a new root execution tree. replay_of_run_id carries
      // lineage; root_run_id must not attach its budgets to the old run.
      .run(id, source.workflow_id, source.workflow_version_id, source.workspace_id, source.project_id, source.user_id,
        `workflow:${source.workflow_id}`, policy.overlapPolicy, policy.maxConcurrentRuns, JSON.stringify(jsonValue(source.input_json) || {}),
        JSON.stringify(policy), JSON.stringify(jsonValue(source.deployment_json) || {}), reusable.length, now, deadlineAt, source.id, null, 0, now, now);
    for (const row of reusable) {
      const nodeRunId = randomUUID();
      await db.prepare(`INSERT INTO automation_node_runs
        (id, run_id, node_id, node_type, attempt, status, input_json, output_json, output_ports_json, reused_from_node_run_id,
         charged_credits, started_at, completed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 'completed', ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
        .run(nodeRunId, id, row.node_id, row.node_type, row.input_json || null, row.output_json, row.output_ports_json || null, row.id, now, now, now, now);
      await appendEvent(id, "node.reused", { nodeId: String(row.node_id), sourceRunId: source.id, sourceNodeRunId: String(row.id) }, nodeRunId);
    }
    await appendEvent(id, "run.queued", { runKind: "replay", replayOfRunId: source.id, retryNodeId: selectedNodeId, reusedNodeCount: reusable.length });
  })();
  scheduleWorkflowRunDrain(50);
  return { status: 202 as const, runId: id, runStatus: "queued" as const, retryNodeId: selectedNodeId, reusedNodeCount: reusable.length };
}

async function appendEvent(runId: string, eventType: string, payload: Record<string, unknown>, nodeRunId: string | null = null) {
  await db.prepare("INSERT INTO automation_run_events (run_id, node_run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(runId, nodeRunId, eventType, JSON.stringify(payload), new Date().toISOString());
}

async function recoverStaleRuns() {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const now = new Date().toISOString();
  const stale = await db.prepare(`SELECT run.id, run.worker_id, run.attempts, run.max_attempts, run.parent_run_id FROM automation_runs run
    WHERE run.status = 'running' AND run.locked_at < ? AND NOT EXISTS (
      SELECT 1 FROM worker_heartbeats worker WHERE worker.worker_id = run.worker_id AND worker.last_seen_at >= ?
    ) ORDER BY run.execution_depth DESC`).all(cutoff, cutoff) as Array<{ id: string; worker_id: string | null; attempts: number; max_attempts: number; parent_run_id: string | null }>;
  for (const run of stale) {
    await db.transaction(async () => {
      await db.prepare(`UPDATE automation_node_runs SET status = 'failed', error = 'Worker interrupted', error_code = 'WORKER_INTERRUPTED', completed_at = ?, updated_at = ?
        WHERE run_id = ? AND status = 'running'`).run(now, now, run.id);
      // A child is an inline part of its parent's node attempt. It must never
      // enter the global queue independently after a worker interruption.
      if (run.parent_run_id) {
        await db.prepare(`UPDATE automation_runs SET status = 'failed', stage_label = 'Child workflow was interrupted', progress = 100,
          error = 'Child workflow was interrupted with its parent.', error_code = 'WORKER_INTERRUPTED', locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND worker_id IS NOT DISTINCT FROM ?`).run(now, now, run.id, run.worker_id);
      } else if (run.attempts < run.max_attempts) {
        await db.prepare(`UPDATE automation_runs SET status = 'queued', stage_label = 'Resuming completed workflow steps',
          available_at = ?, locked_at = NULL, worker_id = NULL, error = NULL, error_code = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND worker_id IS NOT DISTINCT FROM ?`)
          .run(now, now, run.id, run.worker_id);
      } else {
        await db.prepare(`UPDATE automation_runs SET status = 'failed', stage_label = 'Automation was interrupted', progress = 100,
          error = 'Automation was interrupted. Start it again.', error_code = 'WORKER_INTERRUPTED', locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND worker_id IS NOT DISTINCT FROM ?`)
          .run(now, now, run.id, run.worker_id);
      }
    })();
    await releaseOpenAutomationRunBudget(run.id);
  }
}

async function claimRun() {
  return await db.transaction(async () => {
    const now = new Date().toISOString();
    const row = await db.prepare(`WITH eligible_queue AS (
        SELECT candidate.id, candidate.workspace_id, candidate.created_at
        FROM automation_runs candidate
        WHERE candidate.status = 'queued' AND candidate.available_at <= ? AND candidate.parent_run_id IS NULL
          AND (SELECT COUNT(*) FROM automation_runs active
            WHERE active.admission_key = candidate.admission_key AND active.parent_run_id IS NULL AND active.status = 'running') < candidate.max_concurrent_runs
      ), workspace_candidates AS (
        SELECT eligible.workspace_id, MIN(eligible.created_at) AS oldest_job,
          (SELECT COUNT(*) FROM automation_runs active
            WHERE active.workspace_id = eligible.workspace_id AND active.parent_run_id IS NULL AND active.status = 'running') AS running_count
        FROM eligible_queue eligible GROUP BY eligible.workspace_id
      ), chosen_workspace AS (
        SELECT workspace_id FROM workspace_candidates WHERE running_count < ?
        ORDER BY running_count, oldest_job, workspace_id LIMIT 1
      )
      SELECT candidate.* FROM chosen_workspace chosen
      JOIN eligible_queue eligible ON eligible.workspace_id = chosen.workspace_id
      JOIN automation_runs candidate ON candidate.id = eligible.id
      ORDER BY candidate.created_at, candidate.id
      LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED`).get(now, workspaceConcurrency) as RunRow | undefined;
    if (!row) return null;
    // Serialize the final capacity check per workspace. This keeps multiple
    // worker replicas from admitting beyond either the workspace or workflow
    // limit after observing the same pre-claim snapshot.
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-workspace-admission:${row.workspace_id}`);
    const capacity = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM automation_runs WHERE workspace_id = ? AND parent_run_id IS NULL AND status = 'running') AS workspace_active,
      (SELECT COUNT(*) FROM automation_runs WHERE admission_key = ? AND parent_run_id IS NULL AND status = 'running') AS admission_active`)
      .get(row.workspace_id, row.admission_key) as { workspace_active: number; admission_active: number };
    if (Number(capacity.workspace_active) >= workspaceConcurrency || Number(capacity.admission_active) >= Number(row.max_concurrent_runs || 1)) return null;
    const changed = await db.prepare(`UPDATE automation_runs SET status = 'running', stage_label = 'Preparing workflow', progress = 1,
      attempts = attempts + 1, locked_at = ?, worker_id = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'`)
      .run(now, workerId, now, now, row.id);
    return changed.changes === 1 ? { ...row, status: "running" as const, attempts: row.attempts + 1, locked_at: now, worker_id: workerId } : null;
  })();
}

async function assertRunActive(runId: string) {
  const row = await db.prepare("SELECT status, worker_id FROM automation_runs WHERE id = ?").get(runId) as { status: RunStatus; worker_id: string | null } | undefined;
  if (row?.status === "cancelled") throw Object.assign(new Error("Automation cancelled"), { code: "RUN_CANCELLED" });
  if (row?.status !== "running" || row.worker_id !== workerId) throw Object.assign(new Error("Automation lease was lost"), { code: "RUN_LEASE_LOST" });
}

async function failClaimedRun(run: Pick<RunRow, "id">, error: unknown) {
  const code = String((error as { code?: unknown })?.code || "WORKFLOW_FAILED");
  if (code === "RUN_CANCELLED") return;
  const message = error instanceof Error ? error.message : "Automation failed";
  const now = new Date().toISOString();
  const changed = await db.prepare(`UPDATE automation_runs SET status = 'failed', stage_label = 'Workflow stopped', progress = 100,
    error = ?, error_code = ?, locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ?`).run(message, code, now, now, run.id, workerId);
  if (changed.changes === 1) {
    await appendEvent(run.id, "run.failed", { message, code });
    await releaseOpenAutomationRunBudget(run.id);
  }
}

async function executeBoundSubworkflow(parent: RunRow, input: { parentNodeId: string; parentAttempt: number; slotKey: string; payload: unknown; runtimeInputs?: Record<string, unknown>; itemIndex?: number }) {
  await assertRunActive(parent.id);
  const deployment = jsonValue<AutomationDeploymentSnapshot>(parent.deployment_json || {}) || { version: 1, workflows: {} };
  const pinned = deployment.workflows?.[parent.workflow_id]?.subworkflows?.[input.slotKey];
  const target = pinned
    ? await db.prepare(`SELECT workflow.id AS workflow_id, version.id AS published_version_id, version.graph_json
        FROM automation_workflows workflow JOIN automation_workflow_versions version ON version.workflow_id = workflow.id
        WHERE workflow.id = ? AND workflow.workspace_id = ? AND version.id = ?`)
      .get(pinned.workflowId, parent.workspace_id, pinned.workflowVersionId) as { workflow_id: string; published_version_id: string; graph_json: unknown } | undefined
    : await db.prepare(`SELECT workflow.id AS workflow_id, workflow.published_version_id, version.graph_json
        FROM automation_workflow_bindings binding
        JOIN automation_workflows workflow ON workflow.id = binding.target_workflow_id
        JOIN automation_workflow_versions version ON version.id = workflow.published_version_id
        WHERE binding.workflow_id = ? AND binding.workspace_id = ? AND binding.slot_key = ? AND binding.binding_type = 'subworkflow'`)
      .get(parent.workflow_id, parent.workspace_id, input.slotKey) as { workflow_id: string; published_version_id: string; graph_json: unknown } | undefined;
  if (!target) throw Object.assign(new Error(`Workflow slot “${input.slotKey}” is not connected to a published workflow`), { code: "SUBWORKFLOW_BINDING_MISSING" });
  const runtimeInputs = input.runtimeInputs || {};
  const inputJson = JSON.stringify(runtimeInputs);
  const payloadJson = JSON.stringify(input.payload ?? null);
  // Resuming a parent after a worker interruption must not run successful Map
  // items twice. Exact child version and exact input are both part of identity.
  const completedExisting = await db.prepare(`SELECT * FROM automation_runs WHERE parent_run_id = ? AND parent_node_id = ?
    AND item_index IS NOT DISTINCT FROM ? AND workflow_id = ? AND workflow_version_id = ? AND input_json = ?::jsonb
    AND trigger_payload_json IS NOT DISTINCT FROM ?::jsonb
    AND status IN ('completed','completed_with_warnings') ORDER BY completed_at DESC LIMIT 1`)
    .get(parent.id, input.parentNodeId, input.itemIndex ?? null, target.workflow_id, target.published_version_id, inputJson, payloadJson) as RunRow | undefined;
  if (completedExisting) {
    await appendEvent(parent.id, "subworkflow.reused", { childRunId: completedExisting.id, parentNodeId: input.parentNodeId, itemIndex: input.itemIndex ?? null });
    return { runId: completedExisting.id, output: jsonValue(completedExisting.output_json), warningCount: Number(completedExisting.warning_count || 0) };
  }
  if (parent.replay_of_run_id) {
    const prior = await db.prepare(`SELECT * FROM automation_runs WHERE parent_run_id = ? AND parent_node_id = ?
      AND item_index IS NOT DISTINCT FROM ? AND workflow_id = ? AND status IN ('completed','completed_with_warnings')
      AND workflow_version_id = ? ORDER BY completed_at DESC LIMIT 1`).get(parent.replay_of_run_id, input.parentNodeId, input.itemIndex ?? null, target.workflow_id, target.published_version_id) as RunRow | undefined;
    if (prior) {
      const id = randomUUID(); const now = new Date().toISOString();
      await db.prepare(`INSERT INTO automation_runs
        (id, workflow_id, workflow_version_id, workspace_id, project_id, user_id, status, run_kind, admission_key, overlap_policy, max_concurrent_runs, parent_run_id, parent_node_id, root_run_id, replay_of_run_id,
         item_index, execution_depth, stage_label, progress, input_json, trigger_payload_json, output_json, policy_json, deployment_json, charged_credits, warning_count, reused_node_count,
         attempts, max_attempts, available_at, started_at, deadline_at, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'subworkflow', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Reused successful child run', 100, ?, ?, ?, ?, ?, 0, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?)`)
        .run(id, prior.workflow_id, prior.workflow_version_id, parent.workspace_id, parent.project_id, parent.user_id, prior.status,
          parent.admission_key, parent.overlap_policy, parent.max_concurrent_runs, parent.id, input.parentNodeId, parent.root_run_id || parent.id, prior.id,
          input.itemIndex ?? null, parent.execution_depth + 1, inputJson, payloadJson, prior.output_json, prior.policy_json, JSON.stringify(deployment), prior.warning_count, now, now, parent.deadline_at, now, now, now);
      await appendEvent(id, "run.reused", { sourceRunId: prior.id, parentRunId: parent.id, itemIndex: input.itemIndex ?? null });
      return { runId: id, output: jsonValue(prior.output_json), warningCount: Number(prior.warning_count || 0) };
    }
  }
  const ancestors = new Set<string>();
  let ancestorId: string | null = parent.id;
  while (ancestorId) {
    const row = await db.prepare("SELECT workflow_id, parent_run_id FROM automation_runs WHERE id = ?").get(ancestorId) as { workflow_id: string; parent_run_id: string | null } | undefined;
    if (!row) break;
    ancestors.add(row.workflow_id);
    ancestorId = row.parent_run_id;
  }
  if (ancestors.has(target.workflow_id)) throw Object.assign(new Error("Subworkflow recursion is not allowed in the active run chain"), { code: "SUBWORKFLOW_RECURSION" });
  const graph = jsonValue<AutomationWorkflowVersion["graph"]>(target.graph_json);
  const validation = validateAutomationWorkflowGraph(graph);
  if (!validation.valid) throw Object.assign(new Error("The bound child workflow is no longer valid"), { code: "SUBWORKFLOW_INVALID" });
  const validationInputs = { ...runtimeInputs };
  for (const node of graph.nodes.filter((candidate) => candidate.type === "input.workflow-data")) {
    if (node.bindings.value?.mode === "ask-on-run") validationInputs[`${node.id}.value`] = input.payload;
  }
  const inputValidation = validateAutomationRunInputs(graph, validationInputs);
  if (!inputValidation.valid) throw Object.assign(new Error(inputValidation.issues.map((entry) => entry.message).join(" ")), { code: "SUBWORKFLOW_INPUT_INVALID" });
  const rootRunId = parent.root_run_id || parent.id;
  const rootPolicyRow = rootRunId === parent.id
    ? parent
    : await db.prepare("SELECT policy_json FROM automation_runs WHERE id = ?").get(rootRunId) as Pick<RunRow, "policy_json"> | undefined;
  if (!rootPolicyRow) throw Object.assign(new Error("Root automation run is unavailable"), { code: "RUN_LEASE_LOST" });
  const rootPolicy = automationWorkflowSettingsSchema.parse(jsonValue(rootPolicyRow.policy_json) || {});
  const policy = automationWorkflowSettingsSchema.parse(graph.settings || {});
  const depth = parent.execution_depth + 1;
  if (depth > rootPolicy.maxSubworkflowDepth) throw Object.assign(new Error(`Workflow exceeded its ${rootPolicy.maxSubworkflowDepth} level subworkflow limit`), { code: "SUBWORKFLOW_DEPTH_LIMIT" });
  const now = new Date().toISOString();
  const id = randomUUID();
  const deadlineAt = new Date(Math.min(Date.parse(parent.deadline_at || new Date(Date.now() + policy.timeoutSeconds * 1_000).toISOString()), Date.now() + policy.timeoutSeconds * 1_000)).toISOString();
  await db.prepare(`INSERT INTO automation_runs
    (id, workflow_id, workflow_version_id, workspace_id, project_id, user_id, status, run_kind, admission_key, overlap_policy, max_concurrent_runs, parent_run_id, parent_node_id, root_run_id, item_index,
     execution_depth, stage_label, progress, input_json, trigger_payload_json, policy_json, deployment_json, attempts, max_attempts, available_at, locked_at, worker_id, started_at, deadline_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', 'subworkflow', ?, ?, ?, ?, ?, ?, ?, ?, 'Running child workflow', 1, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, target.workflow_id, target.published_version_id, parent.workspace_id, parent.project_id, parent.user_id,
      parent.admission_key, parent.overlap_policy, parent.max_concurrent_runs, parent.id, input.parentNodeId, parent.root_run_id || parent.id,
      input.itemIndex ?? null, depth, inputJson, payloadJson, JSON.stringify(policy), JSON.stringify(deployment), now, now, workerId, now, deadlineAt, now, now);
  await appendEvent(id, "run.started", { runKind: "subworkflow", parentRunId: parent.id, parentNodeId: input.parentNodeId, parentAttempt: input.parentAttempt, itemIndex: input.itemIndex ?? null });
  const child = await db.prepare("SELECT * FROM automation_runs WHERE id = ?").get(id) as RunRow;
  await processRun(child);
  await assertRunActive(parent.id);
  const finished = await db.prepare("SELECT status, output_json, error, warning_count FROM automation_runs WHERE id = ?").get(id) as { status: RunStatus; output_json: unknown; error: string | null; warning_count: number };
  if (!finished || !["completed", "completed_with_warnings"].includes(finished.status)) throw Object.assign(new Error(finished?.error || "Child workflow failed"), { code: "SUBWORKFLOW_FAILED", childRunId: id });
  return { runId: id, output: jsonValue(finished.output_json), warningCount: Number(finished.warning_count || 0) };
}

async function processRun(run: RunRow) {
  const version = await workflowVersionById(run.workflow_version_id);
  if (!version) throw new Error("Workflow version not found");
  const runtimeInputs = jsonValue<Record<string, unknown>>(run.input_json);
  const deployment = jsonValue<AutomationDeploymentSnapshot>(run.deployment_json || {}) || { version: 1, workflows: {} };
  const credentialIds = Object.fromEntries(Object.entries(deployment.workflows?.[run.workflow_id]?.credentials || {}).map(([slot, binding]) => [slot, binding.credentialId]));
  const nodeIndex = new Map(version.graph.nodes.map((node, index) => [node.id, index]));
  const nodeRunIds = new Map<string, { id: string; attempt: number }>();
  const priorAttemptRows = await db.prepare("SELECT node_id, MAX(attempt) AS attempt FROM automation_node_runs WHERE run_id = ? GROUP BY node_id")
    .all(run.id) as Array<{ node_id: string; attempt: number }>;
  const attemptBaseByNode = new Map(priorAttemptRows.map((row) => [row.node_id, Number(row.attempt || 0)]));
  const completedRows = await db.prepare(`SELECT DISTINCT ON (node_id) node_id, output_json
    FROM automation_node_runs WHERE run_id = ? AND status = 'completed' AND output_json IS NOT NULL
    ORDER BY node_id, completed_at DESC`).all(run.id) as Array<{ node_id: string; output_json: unknown }>;
  const initialOutputs = new Map(completedRows.map((row) => [row.node_id, jsonValue<Record<string, unknown>>(row.output_json)]));
  const executionAbort = new AbortController();
  let cancellationCheckPending = false;
  const cancellationMonitor = setInterval(() => {
    if (cancellationCheckPending || executionAbort.signal.aborted) return;
    cancellationCheckPending = true;
    void db.prepare("SELECT status, worker_id FROM automation_runs WHERE id = ?").get(run.id)
      .then((current) => {
        const state = current as { status?: string; worker_id?: string | null } | undefined;
        if (state?.status !== "running") {
          executionAbort.abort(Object.assign(new Error(state?.status === "cancelled" ? "Automation cancelled" : "Automation stopped"), {
            code: state?.status === "cancelled" ? "RUN_CANCELLED" : "RUN_LEASE_LOST",
          }));
        } else if (state.worker_id !== workerId) {
          executionAbort.abort(Object.assign(new Error("Automation lease was transferred"), { code: "RUN_LEASE_LOST" }));
        }
      })
      .catch(() => undefined)
      .finally(() => { cancellationCheckPending = false; });
  }, 750);
  cancellationMonitor.unref?.();
  const deadlineDelay = run.deadline_at ? Math.max(0, Date.parse(run.deadline_at) - Date.now()) : null;
  const deadlineTimer = deadlineDelay === null ? null : setTimeout(() => {
    executionAbort.abort(Object.assign(new Error("Workflow exceeded its configured timeout"), { code: "WORKFLOW_TIMEOUT" }));
  }, deadlineDelay);
  deadlineTimer?.unref?.();
  const stopExecutionMonitors = () => {
    clearInterval(cancellationMonitor);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  };
  const heartbeat = setInterval(() => {
    const now = new Date().toISOString();
    void db.prepare("UPDATE automation_runs SET locked_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?")
      .run(now, now, run.id, workerId)
      .catch(() => undefined);
  }, 30_000);
  heartbeat.unref?.();
  if (run.run_kind === "node-preview") {
    try {
      if (!run.preview_node_id || !run.fixture_id) throw Object.assign(new Error("Preview run is missing its fixture or selected step"), { code: "PREVIEW_CONFIGURATION_MISSING" });
      const fixture = await db.prepare("SELECT workflow_version_id, node_inputs_json FROM automation_workflow_fixtures WHERE id = ? AND workflow_id = ?")
        .get(run.fixture_id, run.workflow_id) as { workflow_version_id: string; node_inputs_json: unknown } | undefined;
      if (!fixture || fixture.workflow_version_id !== run.workflow_version_id) throw Object.assign(new Error("Preview fixture is unavailable or no longer matches this workflow version"), { code: "PREVIEW_FIXTURE_MISSING" });
      const inputsByNode = jsonValue<Record<string, Record<string, unknown>>>(fixture.node_inputs_json) || {};
      const nodeInput = inputsByNode[run.preview_node_id] || {};
      const previewNodeRunId = randomUUID();
      const execution = await executeAutomationNodePreview({
        graph: version.graph,
        nodeId: run.preview_node_id,
        nodeInputs: nodeInput,
        context: {
          runId: run.id,
          workflowId: run.workflow_id,
          userId: run.user_id,
          workspaceId: run.workspace_id,
          projectId: run.project_id,
          runtimeInputs,
          workerId,
          runKind: "node-preview",
          deadlineAt: run.deadline_at || undefined,
          signal: executionAbort.signal,
          credentialIds,
          policy: automationWorkflowSettingsSchema.parse(jsonValue(run.policy_json) || {}),
          budget: {
            reserve: (nodeId, credits) => reserveAutomationRunBudget(run.id, nodeId, credits),
            settle: settleAutomationRunBudget,
            release: releaseAutomationRunBudget,
          },
          usage: {
            reserveGeneratedAssets: (count, usageKey) => reserveAutomationTreeUsage(run.id, "asset", count, usageKey),
          },
          subworkflow: {
            run: (childInput) => executeBoundSubworkflow(run, childInput),
          },
        },
        handlers: coreAutomationNodeHandlers(),
        observer: {
          async nodeStarted(node, capturedInput) {
            await assertRunActive(run.id);
            await reserveAutomationTreeUsage(run.id, "node", 1);
            const now = new Date().toISOString();
            await db.prepare(`INSERT INTO automation_node_runs
              (id, run_id, node_id, node_type, attempt, status, input_json, charged_credits, started_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, 'running', ?, 0, ?, ?, ?)`)
              .run(previewNodeRunId, run.id, node.id, node.type, JSON.stringify(capturedInput), now, now, now);
            await db.prepare("UPDATE automation_runs SET stage_label = ?, progress = 20, locked_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?")
              .run(`Previewing ${node.name}`, now, now, run.id, workerId);
            await appendEvent(run.id, "preview.node.started", { nodeId: node.id, fixtureId: run.fixture_id }, previewNodeRunId);
          },
          async nodeCompleted(node, output) {
            await assertRunActive(run.id);
            const now = new Date().toISOString();
            const chargedCredits = Math.max(0, Number((output.__usage as { chargedCredits?: unknown } | undefined)?.chargedCredits || 0));
            const outputPorts = Object.keys(output).filter((key) => !key.startsWith("__") && output[key] !== undefined);
            await db.prepare("UPDATE automation_node_runs SET status = 'completed', output_json = ?, output_ports_json = ?, charged_credits = ?, completed_at = ?, updated_at = ? WHERE id = ?")
              .run(JSON.stringify(output), JSON.stringify(outputPorts), chargedCredits, now, now, previewNodeRunId);
            await appendEvent(run.id, "preview.node.completed", { nodeId: node.id, outputPorts, chargedCredits }, previewNodeRunId);
          },
          async nodeFailed(node, error) {
            const now = new Date().toISOString();
            const message = error instanceof Error ? error.message : String(error);
            const code = typeof (error as { code?: unknown } | null)?.code === "string" ? String((error as { code: string }).code) : "NODE_PREVIEW_FAILED";
            await db.prepare("UPDATE automation_node_runs SET status = 'failed', error = ?, error_code = ?, completed_at = ?, updated_at = ? WHERE id = ?")
              .run(message, code, now, now, previewNodeRunId);
            await appendEvent(run.id, "preview.node.failed", { nodeId: node.id, message }, previewNodeRunId);
          },
        },
      });
      await assertRunActive(run.id);
      const now = new Date().toISOString();
      const completedStatus = execution.warnings.length ? "completed_with_warnings" : "completed";
      const completed = await db.prepare(`UPDATE automation_runs SET status = ?, stage_label = 'Step preview complete', progress = 100,
        output_json = ?, warning_count = ?, error = NULL, error_code = NULL, reserved_credits = 0, locked_at = NULL, worker_id = NULL,
        completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?`)
        .run(completedStatus, JSON.stringify({ [execution.node.id]: execution.output }), execution.warnings.length, now, now, run.id, workerId);
      if (completed.changes !== 1) throw Object.assign(new Error("Automation lease was lost"), { code: "RUN_LEASE_LOST" });
      await appendEvent(run.id, "preview.completed", { nodeId: execution.node.id, warnings: execution.warnings });
      await releaseOpenAutomationRunBudget(run.id);
    } catch (error) {
      await failClaimedRun(run, error);
    } finally {
      clearInterval(heartbeat);
      stopExecutionMonitors();
    }
    return;
  }
  try {
    const execution = await executeAutomationGraph({
      graph: version.graph,
      context: {
        runId: run.id,
        workflowId: run.workflow_id,
        userId: run.user_id,
        workspaceId: run.workspace_id,
        projectId: run.project_id,
        runtimeInputs,
        triggerPayload: run.trigger_payload_json ? jsonValue<unknown>(run.trigger_payload_json) : undefined,
        workerId,
        runKind: run.run_kind,
        deadlineAt: run.deadline_at || undefined,
        signal: executionAbort.signal,
        executionDepth: run.execution_depth,
        replayOfRunId: run.replay_of_run_id,
        credentialIds,
        policy: automationWorkflowSettingsSchema.parse(jsonValue(run.policy_json) || {}),
        budget: {
          reserve: (nodeId, credits) => reserveAutomationRunBudget(run.id, nodeId, credits),
          settle: settleAutomationRunBudget,
          release: releaseAutomationRunBudget,
        },
        usage: {
          reserveGeneratedAssets: (count, usageKey) => reserveAutomationTreeUsage(run.id, "asset", count, usageKey),
        },
        subworkflow: {
          run: (childInput) => executeBoundSubworkflow(run, {
            ...childInput,
            parentAttempt: nodeRunIds.get(`${childInput.parentNodeId}:${childInput.parentAttempt}`)?.attempt || childInput.parentAttempt,
          }),
        },
      },
      handlers: coreAutomationNodeHandlers(),
      initialOutputs,
      observer: {
        async nodeStarted(node, nodeInput, attempt) {
          await assertRunActive(run.id);
          await reserveAutomationTreeUsage(run.id, "node", 1);
          const nodeRunId = randomUUID();
          const durableAttempt = (attemptBaseByNode.get(node.id) || 0) + attempt;
          nodeRunIds.set(`${node.id}:${attempt}`, { id: nodeRunId, attempt: durableAttempt });
          const now = new Date().toISOString();
          const progress = Math.max(2, Math.round(((nodeIndex.get(node.id) || 0) / Math.max(1, version.graph.nodes.length)) * 94));
          await db.prepare(`INSERT INTO automation_node_runs
            (id, run_id, node_id, node_type, attempt, status, input_json, charged_credits, started_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, 0, ?, ?, ?)`)
            .run(nodeRunId, run.id, node.id, node.type, durableAttempt, JSON.stringify(nodeInput), now, now, now);
          await db.prepare("UPDATE automation_runs SET stage_label = ?, progress = ?, locked_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?")
            .run(node.name, progress, now, now, run.id, workerId);
          await appendEvent(run.id, "node.started", { nodeId: node.id, nodeType: node.type, attempt: durableAttempt }, nodeRunId);
        },
        async nodeCompleted(node, output, attempt) {
          await assertRunActive(run.id);
          const nodeRun = nodeRunIds.get(`${node.id}:${attempt}`)!;
          const now = new Date().toISOString();
          const chargedCredits = Math.max(0, Number((output.__usage as { chargedCredits?: unknown } | undefined)?.chargedCredits || 0));
          const outputPorts = Object.keys(output).filter((key) => !key.startsWith("__") && output[key] !== undefined);
          await db.prepare("UPDATE automation_node_runs SET status = 'completed', output_json = ?, output_ports_json = ?, charged_credits = ?, completed_at = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(output), JSON.stringify(outputPorts), chargedCredits, now, now, nodeRun.id);
          await appendEvent(run.id, "node.completed", { nodeId: node.id, attempt: nodeRun.attempt, outputPorts, chargedCredits }, nodeRun.id);
        },
        async nodeFailed(node, error, attempt) {
          const nodeRun = nodeRunIds.get(`${node.id}:${attempt}`)!;
          const now = new Date().toISOString();
          const message = error instanceof Error ? error.message : String(error);
          const code = typeof (error as { code?: unknown } | null)?.code === "string" ? String((error as { code: string }).code) : "NODE_FAILED";
          const chargedCredits = Math.max(0, Number((error as { automationUsage?: { chargedCredits?: unknown } } | null)?.automationUsage?.chargedCredits || 0));
          await db.prepare("UPDATE automation_node_runs SET status = 'failed', error = ?, error_code = ?, charged_credits = ?, completed_at = ?, updated_at = ? WHERE id = ?")
            .run(message, code, chargedCredits, now, now, nodeRun.id);
          await appendEvent(run.id, "node.failed", { nodeId: node.id, attempt: nodeRun.attempt, message }, nodeRun.id);
        },
        async nodeContinued(node, output, attempt, reason) {
          await assertRunActive(run.id);
          const nodeRun = nodeRunIds.get(`${node.id}:${attempt}`)!;
          const now = new Date().toISOString();
          const outputPorts = Object.keys(output).filter((key) => !key.startsWith("__") && output[key] !== undefined);
          await db.prepare(`UPDATE automation_node_runs SET status = 'completed', output_json = ?, error_code = COALESCE(error_code, 'FAILURE_POLICY_APPLIED'),
            output_ports_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(output), JSON.stringify(outputPorts), now, now, nodeRun.id);
          await appendEvent(run.id, "node.continued", { nodeId: node.id, attempt: nodeRun.attempt, reason, outputPorts }, nodeRun.id);
        },
        async nodeSkipped(node: AutomationNode, reason: string, attempt: number) {
          const id = randomUUID();
          const durableAttempt = (attemptBaseByNode.get(node.id) || 0) + attempt;
          const now = new Date().toISOString();
          await db.prepare(`INSERT INTO automation_node_runs
            (id, run_id, node_id, node_type, attempt, status, error, charged_credits, completed_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'skipped', ?, 0, ?, ?, ?)`)
            .run(id, run.id, node.id, node.type, durableAttempt, reason, now, now, now);
          await appendEvent(run.id, "node.skipped", { nodeId: node.id, attempt: durableAttempt, reason }, id);
        },
      },
    });
    await assertRunActive(run.id);
    const output = Object.fromEntries(execution.completedTerminalNodeIds.map((id) => [id, execution.outputs.get(id)]));
    const now = new Date().toISOString();
    const completedStatus = execution.warnings.length ? "completed_with_warnings" : "completed";
    const completed = await db.prepare(`UPDATE automation_runs SET status = ?, stage_label = ?, progress = 100, output_json = ?, warning_count = ?,
      error = NULL, error_code = NULL, reserved_credits = 0, locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?`).run(completedStatus, execution.warnings.length ? "Workflow complete with warnings" : "Workflow complete", JSON.stringify(output), execution.warnings.length, now, now, run.id, workerId);
    if (completed.changes !== 1) throw Object.assign(new Error("Automation lease was lost"), { code: "RUN_LEASE_LOST" });
    await appendEvent(run.id, completedStatus === "completed" ? "run.completed" : "run.completed_with_warnings", { terminalNodeIds: execution.completedTerminalNodeIds, warnings: execution.warnings.slice(0, 100) });
    await releaseOpenAutomationRunBudget(run.id);
  } catch (error) {
    await failClaimedRun(run, error);
  } finally {
    clearInterval(heartbeat);
    stopExecutionMonitors();
  }
}

async function runDrain() {
  await recoverStaleRuns();
  const active = shared.scenelithWorkflowRunActive || new Set<Promise<void>>();
  shared.scenelithWorkflowRunActive = active;
  while (true) {
    while (active.size < concurrency) {
      const run = await claimRun();
      if (!run) break;
      const promise = processRun(run).catch((error) => failClaimedRun(run, error)).finally(() => active.delete(promise));
      active.add(promise);
    }
    if (!active.size) return;
    await Promise.race(active);
  }
}

export function drainAutomationWorkflowRuns() {
  shared.scenelithWorkflowRunDrainRequested = true;
  if (shared.scenelithWorkflowRunDrain) return shared.scenelithWorkflowRunDrain;
  shared.scenelithWorkflowRunDrain = (async () => {
    while (shared.scenelithWorkflowRunDrainRequested) {
      shared.scenelithWorkflowRunDrainRequested = false;
      await runDrain();
    }
  })().finally(() => {
    shared.scenelithWorkflowRunDrain = undefined;
  });
  return shared.scenelithWorkflowRunDrain;
}

export function scheduleWorkflowRunDrain(delayMs = 100) {
  if (shared.scenelithWorkflowRunTimer) return;
  shared.scenelithWorkflowRunTimer = setTimeout(() => {
    shared.scenelithWorkflowRunTimer = undefined;
    // A web replica may shut down between enqueue and the short wake-up timer.
    // The durable row remains queued for the worker; never turn that benign
    // shutdown race into an unhandled process rejection.
    void drainAutomationWorkflowRuns().catch(() => undefined);
  }, Math.max(50, delayMs));
  shared.scenelithWorkflowRunTimer.unref?.();
}

export async function startAutomationWorkflowWorkers() {
  await recoverStaleRuns();
  scheduleWorkflowRunDrain(100);
}
