import { randomUUID } from "node:crypto";
import { db, userCanAccessProject } from "@/lib/postgres-db";
import { workerIdentity } from "@/lib/worker-identity";
import { enqueueAutomationWorkflowRun } from "./runs";
import { canPerformAutomationAction, requireAutomationPermission } from "./permissions";
import { enqueueAutomationNotification } from "./notifications";

export type AutomationTriggerDeliveryStatus = "queued" | "processing" | "retry_wait" | "delivered" | "dead_letter" | "cancelled";

type DeliveryRow = {
  id: string;
  delivery_key: string;
  trigger_id: string | null;
  workflow_id: string;
  workspace_id: string;
  project_id: string;
  actor_user_id: string | null;
  trigger_type: "schedule" | "webhook" | "canvas-event";
  trigger_name: string;
  status: AutomationTriggerDeliveryStatus;
  runtime_inputs_json: unknown;
  payload_json: unknown;
  scheduled_for: string | null;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  replay_of_delivery_id: string | null;
};

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function publicDelivery(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    deliveryKey: String(row.delivery_key),
    triggerId: row.trigger_id ? String(row.trigger_id) : null,
    workflowId: String(row.workflow_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    triggerType: String(row.trigger_type),
    triggerName: String(row.trigger_name),
    status: String(row.status),
    runtimeInputs: jsonValue(row.runtime_inputs_json),
    payload: jsonValue(row.payload_json),
    scheduledFor: row.scheduled_for ? String(row.scheduled_for) : null,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    runId: row.run_id ? String(row.run_id) : null,
    replayOfDeliveryId: row.replay_of_delivery_id ? String(row.replay_of_delivery_id) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
    deadLetteredAt: row.dead_lettered_at ? String(row.dead_lettered_at) : null,
  };
}

export async function enqueueAutomationTriggerDelivery(input: {
  trigger: Record<string, unknown>;
  deliveryKey: string;
  payload: Record<string, unknown>;
  scheduledFor?: string | null;
  replayOfDeliveryId?: string | null;
}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const trigger = input.trigger;
  const result = await db.prepare(`INSERT INTO automation_trigger_deliveries
    (id, delivery_key, trigger_id, workflow_id, workspace_id, project_id, actor_user_id, trigger_type, trigger_name,
     status, runtime_inputs_json, payload_json, scheduled_for, attempts, max_attempts, available_at, replay_of_delivery_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, 6, ?, ?, ?, ?)
    ON CONFLICT(delivery_key) DO NOTHING`)
    .run(id, input.deliveryKey, trigger.id, trigger.workflow_id, trigger.workspace_id, trigger.project_id, trigger.created_by,
      trigger.type, String(trigger.name || "Automation trigger"), typeof trigger.input_json === "string" ? trigger.input_json : JSON.stringify(trigger.input_json || {}), JSON.stringify(input.payload), input.scheduledFor || null,
      now, input.replayOfDeliveryId || null, now, now);
  if (result.changes !== 1) {
    const existing = await db.prepare("SELECT id, status, run_id FROM automation_trigger_deliveries WHERE delivery_key = ?").get(input.deliveryKey) as Record<string, unknown> | undefined;
    return existing ? { id: String(existing.id), status: String(existing.status), runId: existing.run_id ? String(existing.run_id) : null, deduplicated: true } : null;
  }
  return { id, status: "queued", runId: null, deduplicated: false };
}

async function markDeadLetter(row: DeliveryRow, code: string, message: string) {
  const now = new Date().toISOString();
  await db.transaction(async () => {
    const changed = await db.prepare(`UPDATE automation_trigger_deliveries SET status = 'dead_letter', error_code = ?, error = ?, locked_at = NULL,
      worker_id = NULL, updated_at = ?, dead_lettered_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`)
      .run(code, message.slice(0, 2_000), now, now, row.id, row.worker_id);
    if (changed.changes !== 1) return;
    const alertId = randomUUID();
    const alert = await db.prepare(`INSERT INTO automation_trigger_alerts
      (id, delivery_id, trigger_id, workflow_id, workspace_id, project_id, status, code, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`)
      .run(alertId, row.id, row.trigger_id, row.workflow_id, row.workspace_id, row.project_id, code, message.slice(0, 2_000), now);
    if (alert.changes === 1) await enqueueAutomationNotification({
      workspaceId: row.workspace_id,
      alertId,
      type: "trigger-delivery-failed",
      payload: { alertId, deliveryId: row.id, workflowId: row.workflow_id, projectId: row.project_id, triggerName: row.trigger_name, code, message: message.slice(0, 2_000) },
    });
  })();
}

async function retryOrDeadLetter(row: DeliveryRow, code: string, message: string) {
  const attempts = Number(row.attempts || 0);
  if (attempts >= Number(row.max_attempts || 6)) return await markDeadLetter(row, code, message);
  const delaySeconds = Math.min(900, 5 * 2 ** Math.max(0, attempts - 1)) + Math.floor(Math.random() * 5);
  const availableAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();
  await db.prepare(`UPDATE automation_trigger_deliveries SET status = 'retry_wait', error_code = ?, error = ?, available_at = ?,
    locked_at = NULL, worker_id = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`)
    .run(code, message.slice(0, 2_000), availableAt, new Date().toISOString(), row.id, row.worker_id);
}

async function claimDelivery() {
  const workerId = workerIdentity("automation-trigger-delivery");
  return await db.transaction(async () => {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    await db.prepare(`UPDATE automation_trigger_deliveries SET status = 'retry_wait', available_at = ?, locked_at = NULL, worker_id = NULL,
      error_code = 'DELIVERY_LEASE_EXPIRED', error = 'Delivery worker stopped before acknowledging this attempt', updated_at = ?
      WHERE status = 'processing' AND locked_at < ?`).run(now, now, stale);
    const row = await db.prepare(`SELECT * FROM automation_trigger_deliveries
      WHERE status IN ('queued','retry_wait') AND available_at <= ? ORDER BY available_at, created_at
      LIMIT 1 FOR UPDATE SKIP LOCKED`).get(now) as DeliveryRow | undefined;
    if (!row) return null;
    const changed = await db.prepare(`UPDATE automation_trigger_deliveries SET status = 'processing', attempts = attempts + 1,
      locked_at = ?, worker_id = ?, updated_at = ? WHERE id = ? AND status IN ('queued','retry_wait')`)
      .run(now, workerId, now, row.id);
    return changed.changes === 1 ? { ...row, status: "processing" as const, attempts: Number(row.attempts || 0) + 1, worker_id: workerId } : null;
  })();
}

async function processDelivery(row: DeliveryRow) {
  if (!row.actor_user_id) return await markDeadLetter(row, "TRIGGER_ACTOR_MISSING", "The user who created this trigger no longer exists");
  if (!await canPerformAutomationAction(row.actor_user_id, row.workspace_id, "automation.run")) {
    return await markDeadLetter(row, "TRIGGER_RUN_PERMISSION_REVOKED", "The trigger owner no longer has permission to run automations");
  }
  try {
    const result = await enqueueAutomationWorkflowRun({
      userId: row.actor_user_id,
      projectId: row.project_id,
      workflowId: row.workflow_id,
      runtimeInputs: jsonValue<Record<string, unknown>>(row.runtime_inputs_json),
      mode: "production",
      trigger: { id: row.trigger_id, deliveryId: row.id, payload: jsonValue<Record<string, unknown>>(row.payload_json) },
    });
    if (result.status === 202) {
      const now = new Date().toISOString();
      await db.transaction(async () => {
        const changed = await db.prepare(`UPDATE automation_trigger_deliveries SET status = 'delivered', run_id = ?, error = NULL, error_code = NULL,
          locked_at = NULL, worker_id = NULL, delivered_at = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`)
          .run(result.runId, now, now, row.id, row.worker_id);
        if (changed.changes !== 1) return;
        if (row.trigger_id) await db.prepare("UPDATE automation_workflow_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.trigger_id);
        if (row.replay_of_delivery_id) {
          const alert = await db.prepare(`SELECT id, code, message FROM automation_trigger_alerts WHERE delivery_id = ? AND status = 'open'`)
            .get(row.replay_of_delivery_id) as { id: string; code: string; message: string } | undefined;
          if (alert) {
            const resolved = await db.prepare(`UPDATE automation_trigger_alerts SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'`).run(now, alert.id);
            if (resolved.changes === 1) await enqueueAutomationNotification({
              workspaceId: row.workspace_id,
              alertId: alert.id,
              type: "trigger-delivery-recovered",
              payload: { alertId: alert.id, deliveryId: row.id, workflowId: row.workflow_id, projectId: row.project_id, triggerName: row.trigger_name, code: alert.code, message: "Trigger delivery recovered after manual replay" },
            });
          }
        }
      })();
      return;
    }
    const message = result.error || "Workflow run was rejected";
    if ([400, 403, 404, 409, 422].includes(result.status)) return await markDeadLetter(row, `RUN_REJECTED_${result.status}`, message);
    return await retryOrDeadLetter(row, `RUN_REJECTED_${result.status}`, message);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "DELIVERY_FAILED";
    await retryOrDeadLetter(row, code, error instanceof Error ? error.message : "Could not create an automation run");
  }
}

let drainActive = false;
export async function drainAutomationTriggerDeliveries(limit = 25) {
  if (drainActive) return 0;
  drainActive = true;
  let processed = 0;
  try {
    while (processed < limit) {
      const row = await claimDelivery();
      if (!row) break;
      await processDelivery(row);
      processed += 1;
    }
    return processed;
  } finally { drainActive = false; }
}

export async function listAutomationTriggerDeliveries(input: {
  userId: string;
  projectId: string;
  workflowId?: string;
  triggerId?: string;
  status?: AutomationTriggerDeliveryStatus;
  limit?: number;
}) {
  if (!await userCanAccessProject(input.userId, input.projectId)) return null;
  const workspace = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(input.projectId) as { workspace_id: string } | undefined;
  if (!workspace) return null;
  await requireAutomationPermission(input.userId, workspace.workspace_id, "automation.triggers.manage");
  const clauses = ["project_id = ?"];
  const params: unknown[] = [input.projectId];
  if (input.workflowId) { clauses.push("workflow_id = ?"); params.push(input.workflowId); }
  if (input.triggerId) { clauses.push("trigger_id = ?"); params.push(input.triggerId); }
  if (input.status) { clauses.push("status = ?"); params.push(input.status); }
  params.push(Math.min(100, Math.max(1, input.limit || 50)));
  const rows = await db.prepare(`SELECT * FROM automation_trigger_deliveries WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
  const alerts = await db.prepare(`SELECT delivery_id FROM automation_trigger_alerts WHERE project_id = ? AND status = 'open'`)
    .all(input.projectId) as Array<{ delivery_id: string }>;
  const open = new Set(alerts.map((alert) => alert.delivery_id));
  return rows.map((row) => ({ ...publicDelivery(row), alertOpen: open.has(String(row.id)) }));
}

export async function replayAutomationTriggerDelivery(input: { userId: string; deliveryId: string }) {
  const row = await db.prepare("SELECT * FROM automation_trigger_deliveries WHERE id = ?").get(input.deliveryId) as DeliveryRow | undefined;
  if (!row || !await userCanAccessProject(input.userId, row.project_id)) return null;
  await requireAutomationPermission(input.userId, row.workspace_id, "automation.triggers.manage");
  if (row.status !== "dead_letter") throw new Error("Only dead-letter deliveries can be replayed");
  const trigger = row.trigger_id
    ? await db.prepare("SELECT * FROM automation_workflow_triggers WHERE id = ?").get(row.trigger_id) as Record<string, unknown> | undefined
    : undefined;
  const snapshot = trigger || {
    id: null,
    workflow_id: row.workflow_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    created_by: input.userId,
    type: row.trigger_type,
    name: row.trigger_name,
    input_json: JSON.stringify(jsonValue(row.runtime_inputs_json)),
  };
  const replay = await enqueueAutomationTriggerDelivery({
    trigger: snapshot,
    deliveryKey: `${row.delivery_key}:replay:${randomUUID()}`,
    payload: jsonValue<Record<string, unknown>>(row.payload_json),
    scheduledFor: row.scheduled_for,
    replayOfDeliveryId: row.id,
  });
  return replay ? { ...replay, workspaceId: row.workspace_id, workflowId: row.workflow_id } : null;
}
