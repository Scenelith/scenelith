import { requireApiAdmin } from "@/lib/auth";
import { listFeatureRequests, listSupportTickets } from "@/lib/community";
import { db } from "@/lib/postgres-db";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireApiAdmin();
  if (auth.response) return auth.response;
  const [tickets, features, workers, queues, archiver, backup] = await Promise.all([
    listSupportTickets(auth.user, true),
    listFeatureRequests(auth.user, true),
    db.prepare(`SELECT worker_id, worker_role, started_at, last_seen_at, last_error,
      EXTRACT(EPOCH FROM (now() - last_seen_at))::integer AS age_seconds
      FROM worker_heartbeats ORDER BY worker_role, started_at`).all() as Promise<Array<Record<string, unknown>>>,
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM generation_dispatch_jobs WHERE status IN ('queued', 'dispatching')) AS generation_pending,
      (SELECT COUNT(*) FROM tiktok_automation_jobs WHERE status IN ('queued', 'running')) AS automation_pending,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::integer FROM generation_dispatch_jobs WHERE status = 'queued') AS generation_oldest_seconds,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::integer FROM tiktok_automation_jobs WHERE status = 'queued') AS automation_oldest_seconds,
      (SELECT COUNT(*) FROM collaboration_projection_outbox) AS projection_pending`)
      .get() as Promise<Record<string, unknown>>,
    db.prepare(`SELECT archived_count, failed_count, last_archived_time, last_failed_time,
      CASE WHEN failed_count = 0 OR last_failed_time < last_archived_time THEN true ELSE false END AS healthy
      FROM pg_stat_archiver`).get() as Promise<Record<string, unknown>>,
    db.prepare("SELECT status, details, updated_at FROM operation_status WHERE key = 'base_backup'").get() as Promise<Record<string, unknown> | undefined>,
  ]);
  return Response.json({
    tickets,
    features,
    counts: {
      openTickets: tickets.filter((ticket) => ticket.status === "open" || ticket.status === "in_progress").length,
      pendingFeatures: features.filter((feature) => !feature.hidden && feature.status === "pending").length,
      totalVotes: features.filter((feature) => !feature.hidden).reduce((sum, feature) => sum + feature.voteCount, 0),
    },
    operations: {
      workers: workers.map((worker) => ({
        id: String(worker.worker_id),
        role: String(worker.worker_role),
        startedAt: String(worker.started_at),
        lastSeenAt: String(worker.last_seen_at),
        ageSeconds: Number(worker.age_seconds || 0),
        error: worker.last_error ? String(worker.last_error) : null,
        healthy: Number(worker.age_seconds || 0) < 30 && !worker.last_error,
      })),
      queues: {
        generationPending: Number(queues.generation_pending || 0),
        automationPending: Number(queues.automation_pending || 0),
        generationOldestSeconds: queues.generation_oldest_seconds === null ? null : Number(queues.generation_oldest_seconds),
        automationOldestSeconds: queues.automation_oldest_seconds === null ? null : Number(queues.automation_oldest_seconds),
        projectionPending: Number(queues.projection_pending || 0),
      },
      walArchive: {
        archivedCount: Number(archiver.archived_count || 0),
        failedCount: Number(archiver.failed_count || 0),
        lastArchivedAt: archiver.last_archived_time ? String(archiver.last_archived_time) : null,
        lastFailedAt: archiver.last_failed_time ? String(archiver.last_failed_time) : null,
        healthy: Boolean(archiver.healthy),
      },
      baseBackup: backup ? {
        status: String(backup.status),
        details: (() => {
          try { return JSON.parse(String(backup.details || "{}")); }
          catch { return {}; }
        })(),
        updatedAt: String(backup.updated_at),
      } : null,
    },
  });
}
