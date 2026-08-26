import { randomUUID } from "node:crypto";
import { automationNotificationAdapter } from "@/editions/current/automation-notifications";
import type { AutomationNotificationEvent } from "@/editions/contracts/automation-notifications";
import { db } from "@/lib/postgres-db";
import { workerIdentity } from "@/lib/worker-identity";

type OutboxRow = {
  id: string;
  workspace_id: string;
  event_type: AutomationNotificationEvent["type"];
  payload_json: unknown;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
};

function jsonValue<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }

export async function enqueueAutomationNotification(input: {
  workspaceId: string;
  alertId: string;
  type: AutomationNotificationEvent["type"];
  payload: AutomationNotificationEvent["payload"];
}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO automation_notification_outbox
    (id, workspace_id, alert_id, event_type, payload_json, status, attempts, max_attempts, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', 0, 8, ?, ?, ?)`)
    .run(id, input.workspaceId, input.alertId, input.type, JSON.stringify(input.payload), now, now, now);
  return id;
}

async function claimNotification() {
  const workerId = workerIdentity("automation-notification");
  return await db.transaction(async () => {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 2 * 60_000).toISOString();
    await db.prepare(`UPDATE automation_notification_outbox SET status = 'retry_wait', available_at = ?, locked_at = NULL, worker_id = NULL,
      error = 'Notification worker stopped before acknowledgement', updated_at = ? WHERE status = 'processing' AND locked_at < ?`)
      .run(now, now, stale);
    const row = await db.prepare(`SELECT * FROM automation_notification_outbox WHERE status IN ('queued','retry_wait') AND available_at <= ?
      ORDER BY available_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`).get(now) as OutboxRow | undefined;
    if (!row) return null;
    const changed = await db.prepare(`UPDATE automation_notification_outbox SET status = 'processing', attempts = attempts + 1,
      locked_at = ?, worker_id = ?, updated_at = ? WHERE id = ? AND status IN ('queued','retry_wait')`).run(now, workerId, now, row.id);
    return changed.changes === 1 ? { ...row, attempts: Number(row.attempts || 0) + 1, worker_id: workerId } : null;
  })();
}

async function processNotification(row: OutboxRow) {
  const payload = jsonValue<AutomationNotificationEvent["payload"]>(row.payload_json);
  try {
    const result = await automationNotificationAdapter.deliver({ id: row.id, workspaceId: row.workspace_id, type: row.event_type, payload }, AbortSignal.timeout(15_000));
    const now = new Date().toISOString();
    await db.prepare(`UPDATE automation_notification_outbox SET status = 'delivered', channel = ?, error = NULL, locked_at = NULL,
      worker_id = NULL, delivered_at = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`)
      .run(result.channel, now, now, row.id, row.worker_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification delivery failed";
    const now = new Date().toISOString();
    if (row.attempts >= Number(row.max_attempts || 8)) {
      await db.prepare(`UPDATE automation_notification_outbox SET status = 'dead_letter', error = ?, locked_at = NULL, worker_id = NULL,
        updated_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`).run(message.slice(0, 2_000), now, row.id, row.worker_id);
      return;
    }
    const delaySeconds = Math.min(3_600, 10 * 2 ** Math.max(0, row.attempts - 1)) + Math.floor(Math.random() * 10);
    await db.prepare(`UPDATE automation_notification_outbox SET status = 'retry_wait', error = ?, available_at = ?, locked_at = NULL,
      worker_id = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND worker_id = ?`)
      .run(message.slice(0, 2_000), new Date(Date.now() + delaySeconds * 1_000).toISOString(), now, row.id, row.worker_id);
  }
}

let draining = false;
export async function drainAutomationNotifications(limit = 25) {
  if (draining) return 0;
  draining = true;
  let processed = 0;
  try {
    while (processed < limit) {
      const row = await claimNotification();
      if (!row) break;
      await processNotification(row);
      processed += 1;
    }
    return processed;
  } finally { draining = false; }
}
