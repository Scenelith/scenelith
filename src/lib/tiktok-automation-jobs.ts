import { createHash, randomUUID } from "node:crypto";
import { usageAuthority } from "@/modules/usage";
import { db, userCanAccessProject } from "./postgres-db";
import {
  executeTikTokAutomationPlan,
  tiktokAutomationPlanSchema,
  type TikTokAutomationPlanInput,
  type TikTokAutomationRunResult,
} from "./tiktok-automation-runner";
import { workerIdentity } from "./worker-identity";

export type TikTokAutomationJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

type AutomationJobRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  project_id: string;
  source_node_id: string;
  request_json: string;
  status: TikTokAutomationJobStatus;
  stage: string;
  stage_label: string;
  progress: number;
  result_json: string | null;
  error: string | null;
  error_code: string | null;
  http_status: number | null;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  worker_id: string | null;
  reservation_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type StaleAutomationJob = Pick<AutomationJobRow, "id" | "attempts" | "max_attempts" | "reservation_id" | "worker_id">;

type AutomationJobsGlobal = typeof globalThis & {
  scenelithAutomationDrain?: Promise<void>;
  scenelithAutomationTimer?: ReturnType<typeof setTimeout>;
  scenelithAutomationActive?: Set<Promise<void>>;
  scenelithAutomationStarted?: boolean;
};

const shared = globalThis as AutomationJobsGlobal;
const workerId = workerIdentity("automation");
const staleAfterMs = Math.max(5 * 60_000, Number(process.env.TIKTOK_AUTOMATION_STALE_MS || 15 * 60_000));
const globalConcurrency = Math.min(8, Math.max(1, Number(process.env.TIKTOK_AUTOMATION_CONCURRENCY || 3)));
const heartbeatMs = 30_000;

export function tiktokAutomationReservationId(jobId: string, attempt: number, nonce = randomUUID()) {
  return `tiktok:${jobId}:${attempt}:${nonce}`;
}

function safeJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; }
  catch { return null; }
}

function errorMessage(result: TikTokAutomationRunResult) {
  const body = result.body as { error?: unknown };
  return typeof body.error === "string" ? body.error : "TikTok automation failed";
}

function errorCode(result: TikTokAutomationRunResult) {
  const body = result.body as { code?: unknown };
  return typeof body.code === "string" ? body.code : null;
}

export async function enqueueTikTokAutomationJob(input: {
  userId: string;
  workspaceId: string;
  request: TikTokAutomationPlanInput;
}) {
  const now = new Date().toISOString();
  const requestJson = JSON.stringify(input.request);
  const dedupeKey = createHash("sha256").update(`${input.userId}:${requestJson}`).digest("hex");
  return await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-dedupe:${input.userId}:${dedupeKey}`);
    const reusableAfter = new Date(Date.now() - 30 * 60_000).toISOString();
    const existing = await db.prepare(
      `SELECT id, status FROM tiktok_automation_jobs
       WHERE user_id = ? AND dedupe_key = ?
         AND (status IN ('queued', 'running') OR (status = 'completed' AND completed_at >= ?))
       ORDER BY created_at DESC LIMIT 1`,
    ).get(input.userId, dedupeKey, reusableAfter) as { id: string; status: TikTokAutomationJobStatus } | undefined;
    if (existing) return { jobId: existing.id, status: existing.status, deduplicated: true };

    const id = randomUUID();
    await db.prepare(`INSERT INTO tiktok_automation_jobs (
      id, user_id, workspace_id, project_id, source_node_id, dedupe_key, request_json,
      status, stage, stage_label, progress, attempts, max_attempts, available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 'Waiting for an available planning slot', 0, 0, 2, ?, ?, ?)`)
      .run(
        id, input.userId, input.workspaceId, input.request.projectId, input.request.sourceNodeId,
        dedupeKey, requestJson, now, now, now,
      );
    return { jobId: id, status: "queued" as const, deduplicated: false };
  })();
}

export async function getTikTokAutomationJob(jobId: string, userId: string) {
  const row = await db.prepare(
    `SELECT id, project_id, status, stage, stage_label, progress, result_json, error, error_code,
            http_status, attempts, max_attempts, created_at, updated_at, completed_at
     FROM tiktok_automation_jobs WHERE id = ? AND user_id = ?`,
  ).get(jobId, userId) as Pick<AutomationJobRow,
    "id" | "project_id" | "status" | "stage" | "stage_label" | "progress" | "result_json" | "error" | "error_code" |
    "http_status" | "attempts" | "max_attempts" | "created_at" | "updated_at" | "completed_at"
  > | undefined;
  if (!row || !await userCanAccessProject(userId, row.project_id)) return null;
  const queuePosition = row.status === "queued"
    ? Number((await db.prepare(
      `SELECT COUNT(*) AS count FROM tiktok_automation_jobs
       WHERE status IN ('queued', 'running') AND created_at <=
         (SELECT created_at FROM tiktok_automation_jobs WHERE id = ?)`,
    ).get(jobId) as { count: number }).count)
    : null;
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    stageLabel: row.stage_label,
    progress: row.progress,
    result: row.status === "completed" ? safeJson<Record<string, unknown>>(row.result_json) : null,
    error: row.error,
    code: row.error_code,
    httpStatus: row.http_status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    queuePosition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const stale = await db.prepare(
    `SELECT id, attempts, max_attempts, reservation_id, worker_id FROM tiktok_automation_jobs AS job
     WHERE status = 'running' AND locked_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM worker_heartbeats worker
         WHERE worker.worker_id = job.worker_id AND worker.last_seen_at >= ?
       )`,
  ).all(cutoff, cutoff) as StaleAutomationJob[];
  for (const job of stale) {
    const now = new Date().toISOString();
    let recovered = false;
    if (job.attempts < job.max_attempts) {
      const changed = await db.prepare(`UPDATE tiktok_automation_jobs SET
        status = 'queued', stage = 'queued', stage_label = 'Resuming after an interrupted worker', progress = 0,
        available_at = ?, locked_at = NULL, worker_id = NULL, reservation_id = NULL,
        error = NULL, error_code = NULL, http_status = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND attempts = ? AND locked_at < ?`)
        .run(now, now, job.id, job.worker_id, job.attempts, cutoff);
      recovered = changed.changes === 1;
    } else {
      const changed = await db.prepare(`UPDATE tiktok_automation_jobs SET
        status = 'failed', stage = 'failed', stage_label = 'Automation was interrupted',
        error = 'Automation was interrupted. Start it again.', error_code = 'WORKER_INTERRUPTED', http_status = 503,
        locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND attempts = ? AND locked_at < ?`)
        .run(now, now, job.id, job.worker_id, job.attempts, cutoff);
      recovered = changed.changes === 1;
    }
    if (recovered && job.reservation_id) {
      await (await usageAuthority()).releaseAutomation(job.reservation_id, "automation_worker_recovered", { jobId: job.id, attempt: job.attempts });
    }
  }
}

async function claimNextJob() {
  return await db.transaction(async () => {
    const now = new Date().toISOString();
    const candidate = await db.prepare(
      `SELECT * FROM tiktok_automation_jobs AS candidate
       WHERE candidate.status = 'queued' AND candidate.available_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM tiktok_automation_jobs AS active
           WHERE active.user_id = candidate.user_id AND active.status = 'running'
         )
       ORDER BY candidate.created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    ).get(now) as AutomationJobRow | undefined;
    if (!candidate) return null;
    const attempt = candidate.attempts + 1;
    const reservationId = tiktokAutomationReservationId(candidate.id, attempt);
    const changed = await db.prepare(`UPDATE tiktok_automation_jobs SET
      status = 'running', stage = 'preflight', stage_label = 'Preparing the automation', progress = 1,
      attempts = ?, locked_at = ?, worker_id = ?, reservation_id = ?, error = NULL, error_code = NULL,
      http_status = NULL, result_json = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'`).run(attempt, now, workerId, reservationId, now, candidate.id);
    if (changed.changes !== 1) return null;
    return { ...candidate, status: "running" as const, attempts: attempt, reservation_id: reservationId, locked_at: now, worker_id: workerId };
  })();
}

async function updateHeartbeat(jobId: string) {
  const now = new Date().toISOString();
  await db.prepare("UPDATE tiktok_automation_jobs SET locked_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?")
    .run(now, now, jobId, workerId);
}

function scheduleDrain(delayMs: number) {
  if (shared.scenelithAutomationTimer) return;
  shared.scenelithAutomationTimer = setTimeout(() => {
    shared.scenelithAutomationTimer = undefined;
    void drainTikTokAutomationJobs();
  }, Math.max(100, delayMs));
  shared.scenelithAutomationTimer.unref?.();
}

async function processJob(job: AutomationJobRow) {
  const heartbeat = setInterval(() => {
    void updateHeartbeat(job.id).catch((error) => {
      console.error("[automation:lease-heartbeat-failed]", { jobId: job.id, error });
    });
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    const parsed = tiktokAutomationPlanSchema.safeParse(safeJson<unknown>(job.request_json));
    if (!parsed.success) {
      const now = new Date().toISOString();
      await db.prepare(`UPDATE tiktok_automation_jobs SET status = 'failed', stage = 'failed', stage_label = 'Invalid automation request',
        error = 'Choose a TikTok slideshow, adaptation mode and image model', error_code = 'INVALID_REQUEST', http_status = 400,
        locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND attempts = ?`)
        .run(now, now, job.id, workerId, job.attempts);
      return;
    }

    const result = await executeTikTokAutomationPlan({
      userId: job.user_id,
      input: parsed.data,
      reservationId: job.reservation_id!,
      async reportProgress(progress) {
        const now = new Date().toISOString();
        await db.prepare(`UPDATE tiktok_automation_jobs SET stage = ?, stage_label = ?, progress = ?, locked_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND worker_id = ?`)
          .run(progress.stage, progress.label, progress.progress, now, now, job.id, workerId);
      },
    });
    const now = new Date().toISOString();
    if (result.status === 200) {
      await db.prepare(`UPDATE tiktok_automation_jobs SET
        status = 'completed', stage = 'completed', stage_label = 'Reviewed plan is ready', progress = 100,
        result_json = ?, error = NULL, error_code = NULL, http_status = 200,
        locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ?`)
        .run(JSON.stringify(result.body), now, now, job.id, workerId);
      return;
    }

    const retryable = result.status >= 500 && job.attempts < job.max_attempts;
    if (retryable) {
      const retryAt = new Date(Date.now() + Math.min(30_000, 3_000 * 2 ** Math.max(0, job.attempts - 1))).toISOString();
      await db.prepare(`UPDATE tiktok_automation_jobs SET
        status = 'queued', stage = 'queued', stage_label = 'Retrying after a temporary planning error', progress = 0,
        result_json = NULL, error = ?, error_code = ?, http_status = ?, available_at = ?,
        locked_at = NULL, worker_id = NULL, reservation_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ?`)
        .run(errorMessage(result), errorCode(result), result.status, retryAt, now, job.id, workerId);
      scheduleDrain(Math.max(100, new Date(retryAt).getTime() - Date.now()));
      return;
    }

    await db.prepare(`UPDATE tiktok_automation_jobs SET
      status = 'failed', stage = 'failed', stage_label = ?, progress = 100,
      result_json = ?, error = ?, error_code = ?, http_status = ?,
      locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?`)
      .run(errorMessage(result), JSON.stringify(result.body), errorMessage(result), errorCode(result), result.status, now, now, job.id, workerId);
  } catch (error) {
    if (job.reservation_id) await (await usageAuthority()).releaseAutomation(job.reservation_id, "automation_worker_failed", { jobId: job.id, attempt: job.attempts });
    const message = error instanceof Error ? error.message : "TikTok automation worker failed";
    const now = new Date().toISOString();
    if (job.attempts < job.max_attempts) {
      const retryAt = new Date(Date.now() + 5_000).toISOString();
      await db.prepare(`UPDATE tiktok_automation_jobs SET status = 'queued', stage = 'queued', stage_label = 'Retrying after an interrupted worker',
        progress = 0, error = ?, error_code = 'WORKER_ERROR', http_status = 503, available_at = ?,
        locked_at = NULL, worker_id = NULL, reservation_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ?`).run(message, retryAt, now, job.id, workerId);
      scheduleDrain(5_000);
    } else {
      await db.prepare(`UPDATE tiktok_automation_jobs SET status = 'failed', stage = 'failed', stage_label = 'Automation worker failed',
        progress = 100, error = ?, error_code = 'WORKER_ERROR', http_status = 503,
        locked_at = NULL, worker_id = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ?`).run(message, now, now, job.id, workerId);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function runDrain() {
  await recoverStaleJobs();
  const active = shared.scenelithAutomationActive ?? new Set<Promise<void>>();
  shared.scenelithAutomationActive = active;

  while (true) {
    while (active.size < globalConcurrency) {
      const job = await claimNextJob();
      if (!job) break;
      const promise = processJob(job).finally(() => active.delete(promise));
      active.add(promise);
    }
    if (active.size) {
      await Promise.race(active);
      continue;
    }
    const next = await db.prepare("SELECT available_at FROM tiktok_automation_jobs WHERE status = 'queued' ORDER BY available_at ASC LIMIT 1")
      .get() as { available_at: string } | undefined;
    if (next) scheduleDrain(Math.max(100, new Date(next.available_at).getTime() - Date.now()));
    return;
  }
}

export function drainTikTokAutomationJobs() {
  if (shared.scenelithAutomationDrain) return shared.scenelithAutomationDrain;
  shared.scenelithAutomationDrain = runDrain().finally(() => {
    shared.scenelithAutomationDrain = undefined;
  });
  return shared.scenelithAutomationDrain;
}

export async function startTikTokAutomationWorkers() {
  if (shared.scenelithAutomationStarted) return;
  shared.scenelithAutomationStarted = true;
  // PostgreSQL is shared by all workers. Only expired leases may be reclaimed;
  // a lock owned by another live process must never be treated as orphaned.
  await recoverStaleJobs();
  scheduleDrain(100);
}
