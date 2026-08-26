import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { db, userCanAccessProject, workspaceIdForProject } from "@/lib/postgres-db";
import { getAutomationWorkflow } from "./repository";
import { validateAutomationRunInputs } from "./validation";
import { validateAutomationDeploymentBindings } from "./deployment-validation";
import type { AutomationWorkflowGraph } from "./types";
import { enqueueAutomationTriggerDelivery } from "./deliveries";
import { nextAutomationScheduleAt, parseAutomationScheduleConfig } from "./schedules";
import { requireAutomationPermission } from "./permissions";
import { assertAutomationProductEventVersion, AUTOMATION_PRODUCT_EVENT_NAMES, parseAutomationProductEvent, type AutomationProductEventName } from "./product-events";
import { workerIdentity } from "@/lib/worker-identity";

export type AutomationTriggerType = "schedule" | "webhook" | "canvas-event";
export type AutomationOverlapPolicy = "queue" | "skip" | "cancel-previous";
export const AUTOMATION_CANVAS_EVENTS = AUTOMATION_PRODUCT_EVENT_NAMES;
export type AutomationCanvasEvent = AutomationProductEventName;

type ProductEventOutboxRow = {
  id: string;
  project_id: string;
  event_name: AutomationProductEventName;
  event_version: number;
  payload_json: unknown;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
};

function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function jsonValue<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }

export async function listAutomationWorkflowTriggers(userId: string, workflowId: string) {
  const detail = await getAutomationWorkflow(userId, workflowId);
  if (!detail) return null;
  await requireAutomationPermission(userId, detail.workflow.workspaceId, "automation.triggers.manage");
  return await db.prepare(`SELECT id, workflow_id AS "workflowId", project_id AS "projectId", type, status, name,
    overlap_policy AS "overlapPolicy", max_concurrent_runs AS "maxConcurrentRuns", config_json AS config,
    input_json AS inputs, next_fire_at AS "nextFireAt", last_fired_at AS "lastFiredAt", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM automation_workflow_triggers WHERE workflow_id = ? ORDER BY created_at`).all(workflowId);
}

export async function createAutomationWorkflowTrigger(input: { userId: string; workflowId: string; projectId: string; type: AutomationTriggerType; name: string; overlapPolicy?: AutomationOverlapPolicy; maxConcurrentRuns?: number; config: Record<string, unknown>; inputs: Record<string, unknown> }) {
  const detail = await getAutomationWorkflow(input.userId, input.workflowId);
  if (!detail || !detail.published || !await userCanAccessProject(input.userId, input.projectId)) return null;
  if (detail.workflow.workspaceId !== await workspaceIdForProject(input.projectId)) return null;
  await requireAutomationPermission(input.userId, detail.workflow.workspaceId, "automation.triggers.manage");
  const inputValidation = validateAutomationRunInputs(detail.published.graph, input.inputs);
  if (!inputValidation.valid) throw Object.assign(new Error(inputValidation.issues.map((entry) => entry.message).join(" ")), { code: "TRIGGER_INPUT_INVALID" });
  const id = randomUUID();
  const now = new Date().toISOString();
  let token: string | null = null;
  let hash: string | null = null;
  let nextFireAt: string | null = null;
  let config: Record<string, unknown> = input.config;
  const overlapPolicy = input.overlapPolicy || "queue";
  const maxConcurrentRuns = Math.min(32, Math.max(1, input.maxConcurrentRuns || 1));
  if (input.type === "webhook") {
    token = randomBytes(32).toString("base64url");
    hash = tokenHash(token);
    config = {};
  }
  if (input.type === "schedule") {
    config = parseAutomationScheduleConfig(input.config);
    nextFireAt = nextAutomationScheduleAt(config, now);
  }
  if (input.type === "canvas-event") {
    const event = String(input.config.event || "");
    if (!AUTOMATION_CANVAS_EVENTS.includes(event as AutomationCanvasEvent)) throw new Error("Choose a supported canvas event");
    const version = Number(input.config.version || 1);
    // Validate the event identity now. Payload validation happens for every
    // delivery because product events are versioned contracts, not loose JSON.
    assertAutomationProductEventVersion(event, version);
    config = { event, version };
  }
  await db.prepare(`INSERT INTO automation_workflow_triggers
    (id, workflow_id, workspace_id, project_id, type, status, name, overlap_policy, max_concurrent_runs, config_json, input_json, webhook_token_hash, next_fire_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.workflowId, detail.workflow.workspaceId, input.projectId, input.type, input.name.trim().slice(0, 120), overlapPolicy,
      maxConcurrentRuns, JSON.stringify(config), JSON.stringify(input.inputs), hash, nextFireAt, input.userId, now, now);
  return { trigger: { id, workflowId: input.workflowId, projectId: input.projectId, type: input.type, status: "paused", name: input.name,
    overlapPolicy, maxConcurrentRuns, config, inputs: input.inputs, nextFireAt, lastFiredAt: null }, token };
}

export async function setAutomationWorkflowTriggerStatus(userId: string, triggerId: string, status: "active" | "paused") {
  const row = await db.prepare(`SELECT trigger.workflow_id, trigger.workspace_id, trigger.type, trigger.input_json, trigger.config_json, workflow.published_version_id, version.graph_json
    FROM automation_workflow_triggers trigger JOIN automation_workflows workflow ON workflow.id = trigger.workflow_id
    LEFT JOIN automation_workflow_versions version ON version.id = workflow.published_version_id WHERE trigger.id = ?`).get(triggerId) as { workflow_id: string; workspace_id: string; type: AutomationTriggerType; input_json: unknown; config_json: unknown; published_version_id: string | null; graph_json: unknown } | undefined;
  if (!row || !await getAutomationWorkflow(userId, row.workflow_id)) return null;
  await requireAutomationPermission(userId, row.workspace_id, "automation.triggers.manage");
  if (status === "active") {
    if (!row.published_version_id || !row.graph_json) throw new Error("Publish the workflow before activating this trigger");
    const inputs = jsonValue<Record<string, unknown>>(row.input_json);
    const graph = jsonValue<AutomationWorkflowGraph>(row.graph_json);
    const validation = validateAutomationRunInputs(graph, inputs);
    if (!validation.valid) throw new Error(`Trigger inputs no longer match the published workflow: ${validation.issues.map((entry) => entry.message).join(" ")}`);
    const deployment = await validateAutomationDeploymentBindings({ workflowId: row.workflow_id, workspaceId: row.workspace_id, graph });
    if (!deployment.valid) throw new Error(`Connect this workflow before activating the trigger: ${deployment.issues.map((entry) => entry.message).join(" ")}`);
  }
  const now = new Date().toISOString();
  const nextFireAt = status === "active" && row.type === "schedule" ? nextAutomationScheduleAt(jsonValue(row.config_json), now) : null;
  await db.prepare("UPDATE automation_workflow_triggers SET status = ?, next_fire_at = CASE WHEN type = 'schedule' THEN ? ELSE next_fire_at END, updated_at = ? WHERE id = ?").run(status, nextFireAt, now, triggerId);
  return { id: triggerId, status, workflowId: row.workflow_id, workspaceId: row.workspace_id };
}

export async function deleteAutomationWorkflowTrigger(userId: string, triggerId: string) {
  const row = await db.prepare("SELECT workflow_id, workspace_id FROM automation_workflow_triggers WHERE id = ?").get(triggerId) as { workflow_id: string; workspace_id: string } | undefined;
  if (!row || !await getAutomationWorkflow(userId, row.workflow_id)) return null;
  await requireAutomationPermission(userId, row.workspace_id, "automation.triggers.manage");
  const deleted = await db.prepare("DELETE FROM automation_workflow_triggers WHERE id = ?").run(triggerId);
  return deleted.changes === 1 ? { id: triggerId, workflowId: row.workflow_id, workspaceId: row.workspace_id } : null;
}

export async function fireAutomationWebhook(triggerId: string, token: string, payload: Record<string, unknown>, idempotencyKey?: string | null) {
  const row = await db.prepare("SELECT * FROM automation_workflow_triggers WHERE id = ? AND type = 'webhook' AND status = 'active'").get(triggerId) as Record<string, unknown> | undefined;
  if (!row || !row.webhook_token_hash) return null;
  const actual = Buffer.from(tokenHash(token));
  const expected = Buffer.from(String(row.webhook_token_hash));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const key = idempotencyKey?.trim().slice(0, 240);
  const deliveryKey = key ? `${triggerId}:webhook:${tokenHash(key)}` : `${triggerId}:webhook:${randomUUID()}`;
  const delivery = await enqueueAutomationTriggerDelivery({ trigger: row, deliveryKey, payload: { "trigger.payload": payload } });
  return delivery ? { status: 202 as const, deliveryId: delivery.id, deliveryStatus: delivery.status, deduplicated: delivery.deduplicated } : null;
}

export async function fireAutomationCanvasEvent(input: { userId: string; projectId: string; event: string; version?: number; payload: Record<string, unknown>; sourceKey?: string }) {
  const workspaceId = await workspaceIdForProject(input.projectId);
  if (!workspaceId) return null;
  const actor = await db.prepare("SELECT id FROM users WHERE id = ?").get(input.userId) as { id: string } | undefined;
  const event = parseAutomationProductEvent({ name: input.event, version: input.version, payload: input.payload });
  const id = randomUUID();
  const eventKey = input.sourceKey
    ? `product:${createHash("sha256").update(`${input.projectId}:${event.name}:${input.sourceKey}`).digest("hex")}`
    : `product:${id}`;
  const now = new Date().toISOString();
  const inserted = await db.prepare(`INSERT INTO automation_product_event_outbox
    (id, event_key, workspace_id, project_id, actor_user_id, event_name, event_version, payload_json, status, attempts, max_attempts, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 12, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`)
    .run(id, eventKey, workspaceId, input.projectId, actor?.id || null, event.name, event.version, JSON.stringify(event.payload), now, now, now);
  if (inserted.changes === 1) return { eventId: id, status: "queued" as const, deduplicated: false };
  const existing = await db.prepare("SELECT id, status FROM automation_product_event_outbox WHERE event_key = ?").get(eventKey) as { id: string; status: string } | undefined;
  return existing ? { eventId: existing.id, status: existing.status, deduplicated: true } : null;
}

async function claimAutomationProductEvent() {
  const workerId = workerIdentity("automation-product-event");
  return await db.transaction(async () => {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 2 * 60_000).toISOString();
    await db.prepare(`UPDATE automation_product_event_outbox SET status = 'retry_wait', available_at = ?, locked_at = NULL, worker_id = NULL,
      error = 'Product event worker stopped before acknowledgement', updated_at = ? WHERE status = 'processing' AND locked_at < ?`)
      .run(now, now, stale);
    const row = await db.prepare(`SELECT * FROM automation_product_event_outbox WHERE status IN ('queued','retry_wait') AND available_at <= ?
      ORDER BY available_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`).get(now) as ProductEventOutboxRow | undefined;
    if (!row) return null;
    const changed = await db.prepare(`UPDATE automation_product_event_outbox SET status = 'processing', attempts = attempts + 1,
      locked_at = ?, worker_id = ?, updated_at = ? WHERE id = ? AND status IN ('queued','retry_wait')`)
      .run(now, workerId, now, row.id);
    return changed.changes === 1 ? { ...row, attempts: Number(row.attempts || 0) + 1, worker_id: workerId } : null;
  })();
}

async function processAutomationProductEvent(row: ProductEventOutboxRow) {
  try {
    const event = parseAutomationProductEvent({ name: row.event_name, version: Number(row.event_version), payload: jsonValue(row.payload_json) });
    const triggers = await db.prepare("SELECT * FROM automation_workflow_triggers WHERE project_id = ? AND type = 'canvas-event' AND status = 'active'")
      .all(row.project_id) as Array<Record<string, unknown>>;
    for (const trigger of triggers) {
      const config = jsonValue<Record<string, unknown>>(trigger.config_json);
      if (String(config.event) !== event.name || Number(config.version || 1) !== event.version) continue;
      await enqueueAutomationTriggerDelivery({
        trigger,
        deliveryKey: `${trigger.id}:event:${row.id}`,
        payload: { "trigger.event": event.name, "trigger.eventVersion": event.version, "trigger.payload": event.payload },
      });
    }
    const now = new Date().toISOString();
    await db.prepare(`UPDATE automation_product_event_outbox SET status = 'delivered', error = NULL, locked_at = NULL, worker_id = NULL,
      delivered_at = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`)
      .run(now, now, row.id, row.worker_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Product event delivery failed";
    const now = new Date().toISOString();
    if (row.attempts >= Number(row.max_attempts || 12)) {
      await db.prepare(`UPDATE automation_product_event_outbox SET status = 'dead_letter', error = ?, locked_at = NULL, worker_id = NULL,
        updated_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`)
        .run(message.slice(0, 2_000), now, row.id, row.worker_id);
      return;
    }
    const delaySeconds = Math.min(3_600, 5 * 2 ** Math.max(0, row.attempts - 1)) + Math.floor(Math.random() * 5);
    await db.prepare(`UPDATE automation_product_event_outbox SET status = 'retry_wait', error = ?, available_at = ?, locked_at = NULL,
      worker_id = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`)
      .run(message.slice(0, 2_000), new Date(Date.now() + delaySeconds * 1_000).toISOString(), now, row.id, row.worker_id);
  }
}

let drainingProductEvents = false;
export async function drainAutomationProductEvents(limit = 50) {
  if (drainingProductEvents) return 0;
  drainingProductEvents = true;
  let processed = 0;
  try {
    while (processed < limit) {
      const row = await claimAutomationProductEvent();
      if (!row) break;
      await processAutomationProductEvent(row);
      processed += 1;
    }
    return processed;
  } finally { drainingProductEvents = false; }
}

export async function drainAutomationWorkflowTriggers(limit = 50) {
  const now = new Date().toISOString();
  const rows = await db.prepare(`SELECT * FROM automation_workflow_triggers
    WHERE type = 'schedule' AND status = 'active' AND next_fire_at <= ? ORDER BY next_fire_at LIMIT ?`).all(now, limit) as Array<Record<string, unknown>>;
  let queued = 0;
  for (const snapshot of rows) {
    const scheduledFor = String(snapshot.next_fire_at);
    const config = parseAutomationScheduleConfig(jsonValue(snapshot.config_json));
    const nextBase = config.misfirePolicy === "skip" && Date.parse(scheduledFor) < Date.now() ? now : scheduledFor;
    const next = nextAutomationScheduleAt(config, nextBase);
    const delivery = await db.transaction(async () => {
      const claimed = await db.prepare(`UPDATE automation_workflow_triggers SET next_fire_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND next_fire_at = ?`).run(next, now, snapshot.id, scheduledFor);
      if (claimed.changes !== 1) return null;
      return await enqueueAutomationTriggerDelivery({
        trigger: snapshot,
        deliveryKey: `${snapshot.id}:schedule:${scheduledFor}`,
        scheduledFor,
        payload: { "trigger.scheduledAt": scheduledFor },
      });
    })();
    if (delivery) queued += 1;
  }
  return queued;
}
