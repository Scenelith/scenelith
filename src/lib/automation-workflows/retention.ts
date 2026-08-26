import { automationRetentionPolicy } from "@/editions/current/automation-retention";
import { db } from "@/lib/postgres-db";

function before(days: number) { return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString(); }

export async function cleanupAutomationRetention(batchSize = 500) {
  const policy = automationRetentionPolicy();
  const limit = Math.min(2_000, Math.max(1, Math.floor(batchSize)));
  const counts = { successfulRuns: 0, failedRuns: 0, deliveries: 0, productEvents: 0, notifications: 0, fixtures: 0 };

  counts.successfulRuns = (await db.prepare(`WITH candidates AS (
      SELECT id FROM automation_runs WHERE parent_run_id IS NULL AND status IN ('completed','completed_with_warnings') AND completed_at < ?
      ORDER BY completed_at LIMIT ?
    ) DELETE FROM automation_runs WHERE id IN (SELECT id FROM candidates)`).run(before(policy.successfulRunDays), limit)).changes;
  counts.failedRuns = (await db.prepare(`WITH candidates AS (
      SELECT id FROM automation_runs WHERE parent_run_id IS NULL AND status IN ('failed','cancelled') AND completed_at < ?
      ORDER BY completed_at LIMIT ?
    ) DELETE FROM automation_runs WHERE id IN (SELECT id FROM candidates)`).run(before(policy.failedRunDays), limit)).changes;
  counts.deliveries = (await db.prepare(`WITH candidates AS (
      SELECT delivery.id FROM automation_trigger_deliveries delivery
      LEFT JOIN automation_trigger_alerts alert ON alert.delivery_id = delivery.id AND alert.status = 'open'
      WHERE delivery.status IN ('delivered','cancelled','dead_letter') AND delivery.updated_at < ? AND alert.id IS NULL
      ORDER BY delivery.updated_at LIMIT ?
    ) DELETE FROM automation_trigger_deliveries WHERE id IN (SELECT id FROM candidates)`).run(before(policy.deliveryDays), limit)).changes;
  counts.productEvents = (await db.prepare(`WITH candidates AS (
      SELECT id FROM automation_product_event_outbox WHERE status IN ('delivered','dead_letter') AND updated_at < ?
      ORDER BY updated_at LIMIT ?
    ) DELETE FROM automation_product_event_outbox WHERE id IN (SELECT id FROM candidates)`).run(before(policy.productEventDays), limit)).changes;
  counts.notifications = (await db.prepare(`WITH candidates AS (
      SELECT id FROM automation_notification_outbox WHERE status IN ('delivered','dead_letter') AND updated_at < ?
      ORDER BY updated_at LIMIT ?
    ) DELETE FROM automation_notification_outbox WHERE id IN (SELECT id FROM candidates)`).run(before(policy.notificationDays), limit)).changes;
  if (policy.fixtureDays !== null) {
    counts.fixtures = (await db.prepare(`WITH candidates AS (
        SELECT id FROM automation_workflow_fixtures WHERE updated_at < ? ORDER BY updated_at LIMIT ?
      ) DELETE FROM automation_workflow_fixtures WHERE id IN (SELECT id FROM candidates)`).run(before(policy.fixtureDays), limit)).changes;
  }
  return { policy, counts };
}
