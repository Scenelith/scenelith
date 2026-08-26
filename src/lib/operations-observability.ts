import { relationalPool } from "./relational-db";
import { editionServer } from "@/editions/current/server";

export const REQUIRED_APPLICATION_BASELINE = "core-v1";
export const REQUIRED_COLLABORATION_MIGRATION = "004_document_tombstones.sql";

type Scalar = string | number | boolean | null;

export async function databaseSchemaStatus() {
  const result = await relationalPool().query(`SELECT
    (EXISTS (
      SELECT 1 FROM application_schema_stream_migrations WHERE stream = 'baseline' AND version = $1
    ) OR EXISTS (
      SELECT 1 FROM application_schema_migrations WHERE version = '012_usage_workspace_naming.sql'
    )) AS application_current,
    EXISTS (
      SELECT 1 FROM collaboration_schema_migrations WHERE version = $2
    ) AS collaboration_current`, [REQUIRED_APPLICATION_BASELINE, REQUIRED_COLLABORATION_MIGRATION]);
  return {
    application: Boolean(result.rows[0]?.application_current),
    collaboration: Boolean(result.rows[0]?.collaboration_current),
  };
}

export async function operationsSnapshot() {
  const pool = relationalPool();
  const [queues, workers, storage, collaboration, backup, archiver, recoveryDrill] = await Promise.all([
    pool.query(`SELECT
      (SELECT COUNT(*) FROM generation_dispatch_jobs WHERE status = 'queued') AS generation_queued,
      (SELECT COUNT(*) FROM generation_dispatch_jobs WHERE status = 'dispatching') AS generation_processing,
      (SELECT COUNT(*) FROM generation_dispatch_jobs WHERE status = 'failed') AS generation_dead,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) FROM generation_dispatch_jobs WHERE status = 'queued') AS generation_oldest_seconds,
      (SELECT COUNT(*) FROM tiktok_automation_jobs WHERE status = 'queued') AS automation_queued,
      (SELECT COUNT(*) FROM tiktok_automation_jobs WHERE status = 'running') AS automation_processing,
      (SELECT COUNT(*) FROM tiktok_automation_jobs WHERE status = 'failed') AS automation_dead,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) FROM tiktok_automation_jobs WHERE status = 'queued') AS automation_oldest_seconds,
      (SELECT COUNT(*) FROM automation_runs WHERE parent_run_id IS NULL AND status = 'queued') AS workflow_queued,
      (SELECT COUNT(*) FROM automation_runs WHERE parent_run_id IS NULL AND status = 'running') AS workflow_processing,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) FROM automation_runs WHERE parent_run_id IS NULL AND status = 'queued') AS workflow_oldest_seconds,
      (SELECT COUNT(*) FROM automation_trigger_deliveries WHERE status IN ('queued', 'retry_wait')) AS trigger_delivery_queued,
      (SELECT COUNT(*) FROM automation_trigger_deliveries WHERE status = 'processing') AS trigger_delivery_processing,
      (SELECT COUNT(*) FROM automation_trigger_deliveries WHERE status = 'dead_letter') AS trigger_delivery_dead,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) FROM automation_trigger_deliveries WHERE status IN ('queued', 'retry_wait')) AS trigger_delivery_oldest_seconds,
      (SELECT COUNT(*) FROM automation_product_event_outbox WHERE status IN ('queued', 'retry_wait')) AS product_event_queued,
      (SELECT COUNT(*) FROM automation_product_event_outbox WHERE status = 'processing') AS product_event_processing,
      (SELECT COUNT(*) FROM automation_product_event_outbox WHERE status = 'dead_letter') AS product_event_dead,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) FROM automation_product_event_outbox WHERE status IN ('queued', 'retry_wait')) AS product_event_oldest_seconds,
      (SELECT COUNT(*) FROM automation_notification_outbox WHERE status IN ('queued', 'retry_wait')) AS automation_notification_queued,
      (SELECT COUNT(*) FROM automation_notification_outbox WHERE status = 'processing') AS automation_notification_processing,
      (SELECT COUNT(*) FROM automation_notification_outbox WHERE status = 'dead_letter') AS automation_notification_dead,
      ${editionServer.operationsQueueProjectionSql}
      (SELECT COUNT(*) FROM storage_deletion_jobs WHERE status = 'queued') AS storage_gc_queued,
      (SELECT COUNT(*) FROM storage_deletion_jobs WHERE status = 'processing') AS storage_gc_processing,
      (SELECT COUNT(*) FROM storage_deletion_jobs WHERE status = 'dead') AS storage_gc_dead,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) FROM storage_deletion_jobs WHERE status = 'queued') AS storage_gc_oldest_seconds,
      (SELECT COUNT(*) FROM asset_upload_sessions WHERE status IN ('prepared', 'aborting')) AS uploads_pending,
      (SELECT COUNT(*) FROM asset_upload_sessions WHERE status = 'prepared' AND expires_at < now()) AS uploads_expired,
      (SELECT COUNT(*) FROM collaboration_projection_outbox) AS projection_queued,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) FROM collaboration_projection_outbox) AS projection_oldest_seconds`),
    pool.query(`SELECT worker_role,
      COUNT(*) FILTER (WHERE last_seen_at >= now() - interval '30 seconds' AND last_error IS NULL) AS healthy,
      COUNT(*) AS total,
      MAX(EXTRACT(EPOCH FROM (now() - last_seen_at))) AS oldest_heartbeat_seconds
      FROM worker_heartbeats GROUP BY worker_role ORDER BY worker_role`),
    pool.query(`SELECT COALESCE(SUM(used_bytes), 0) AS used_bytes,
      COALESCE(SUM(reserved_bytes), 0) AS reserved_bytes,
      COALESCE(SUM(quota_bytes), 0) AS quota_bytes
      FROM workspace_storage_usage`),
    pool.query(`SELECT COUNT(*) AS documents,
      COUNT(*) FILTER (WHERE compacting) AS compacting,
      COALESCE(MAX(state_bytes), 0) AS largest_state_bytes,
      COALESCE(SUM(state_bytes), 0) AS state_bytes,
      COALESCE(SUM(update_bytes_since_checkpoint), 0) AS journal_bytes
      FROM collaboration_documents`),
    pool.query(`SELECT status, updated_at,
      EXTRACT(EPOCH FROM (now() - updated_at)) AS age_seconds
      FROM operation_status WHERE key = 'base_backup'`),
    pool.query(`SELECT archived_count, failed_count,
      EXTRACT(EPOCH FROM (now() - last_archived_time)) AS last_archived_age_seconds,
      CASE WHEN failed_count = 0 OR last_failed_time < last_archived_time THEN true ELSE false END AS healthy
      FROM pg_stat_archiver`),
    editionServer.recoveryDrillStatus(),
  ]);
  return {
    queues: queues.rows[0] as Record<string, Scalar>,
    workers: workers.rows as Array<Record<string, Scalar>>,
    storage: storage.rows[0] as Record<string, Scalar>,
    collaboration: collaboration.rows[0] as Record<string, Scalar>,
    backup: (backup.rows[0] || null) as Record<string, Scalar> | null,
    archiver: archiver.rows[0] as Record<string, Scalar>,
    recoveryDrill,
    databasePool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: Math.min(40, Math.max(4, Number(process.env.DATABASE_POOL_SIZE || 12))),
    },
  };
}

function metricName(key: string) {
  return key.replace(/[^a-zA-Z0-9_]/g, "_");
}

function number(value: Scalar | undefined) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function operationsPrometheus(snapshot: Awaited<ReturnType<typeof operationsSnapshot>>) {
  const lines = ["# TYPE scenelith_build_info gauge", "scenelith_build_info 1"];
  for (const [key, value] of Object.entries(snapshot.queues)) {
    lines.push(`scenelith_queue_${metricName(key)} ${number(value)}`);
  }
  for (const worker of snapshot.workers) {
    const role = String(worker.worker_role || "unknown").replace(/[\\"\\n]/g, "_");
    lines.push(`scenelith_workers_healthy{role="${role}"} ${number(worker.healthy)}`);
    lines.push(`scenelith_workers_total{role="${role}"} ${number(worker.total)}`);
    lines.push(`scenelith_worker_oldest_heartbeat_seconds{role="${role}"} ${number(worker.oldest_heartbeat_seconds)}`);
  }
  for (const [key, value] of Object.entries(snapshot.storage)) {
    lines.push(`scenelith_storage_${metricName(key)} ${number(value)}`);
  }
  for (const [key, value] of Object.entries(snapshot.collaboration)) {
    lines.push(`scenelith_collaboration_${metricName(key)} ${number(value)}`);
  }
  lines.push(`scenelith_backup_age_seconds ${number(snapshot.backup?.age_seconds)}`);
  lines.push(`scenelith_backup_healthy ${snapshot.backup?.status === "healthy" ? 1 : 0}`);
  lines.push(`scenelith_wal_archiver_healthy ${number(snapshot.archiver.healthy)}`);
  lines.push(`scenelith_wal_last_archived_age_seconds ${number(snapshot.archiver.last_archived_age_seconds)}`);
  if (snapshot.recoveryDrill) {
    lines.push(`scenelith_restore_drill_healthy ${snapshot.recoveryDrill.healthy ? 1 : 0}`);
    lines.push(`scenelith_restore_drill_last_completed_timestamp_seconds ${number(snapshot.recoveryDrill.completedAtUnixSeconds)}`);
    lines.push(`scenelith_restore_drill_age_seconds ${number(snapshot.recoveryDrill.ageSeconds)}`);
    lines.push(`scenelith_restore_drill_recovery_point_age_seconds ${number(snapshot.recoveryDrill.recoveryPointAgeSeconds)}`);
    lines.push(`scenelith_restore_drill_recovery_time_seconds ${number(snapshot.recoveryDrill.recoveryTimeSeconds)}`);
  }
  for (const [key, value] of Object.entries(snapshot.databasePool)) {
    lines.push(`scenelith_database_pool_${metricName(key)} ${number(value)}`);
  }
  return `${lines.join("\n")}\n`;
}
