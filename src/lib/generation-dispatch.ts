import { usageAuthority } from "@/modules/usage";
import { generationProvider, type GenerationProviderWorkflow } from "@/platform/providers/registry";
import { db } from "./postgres-db";
import { workerIdentity } from "./worker-identity";

export type GenerationDispatchPayload = {
  modelId: string;
  prompt: string;
  references: Array<{ path: string; mimeType: string; label: string; role?: string }>;
  aspectRatio: string;
  resolution: string;
  duration: string;
  generateAudio?: boolean;
  providerWorkflow?: GenerationProviderWorkflow;
  targetClipId?: string;
  targetSourceAssetId?: string;
};

type DispatchJob = {
  generation_id: string;
  payload_json: string;
  attempts: number;
};

type DispatchGlobal = typeof globalThis & {
  scenelithDispatchPromise?: Promise<void>;
  scenelithDispatchTimer?: ReturnType<typeof setTimeout>;
};

const shared = globalThis as DispatchGlobal;
const recoveryAgeMs = 5 * 60 * 1000;
const batchSize = 24;
const dispatchWorkerId = workerIdentity("generation");

function scheduleDrain(delayMs: number) {
  if (shared.scenelithDispatchTimer) return;
  shared.scenelithDispatchTimer = setTimeout(() => {
    shared.scenelithDispatchTimer = undefined;
    void drainGenerationDispatchQueue();
  }, Math.max(50, delayMs));
  shared.scenelithDispatchTimer.unref?.();
}

async function claimReadyJobs() {
  const now = new Date().toISOString();
  return await db.transaction(async () => {
    const candidates = await db.prepare(
      `SELECT generation_id, payload_json, attempts
       FROM generation_dispatch_jobs
       WHERE status = 'queued' AND available_at <= ?
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ?`,
    ).all(now, batchSize) as DispatchJob[];
    if (!candidates.length) return [];
    const placeholders = candidates.map(() => "?").join(", ");
    await db.prepare(
      `UPDATE generation_dispatch_jobs
       SET status = 'dispatching', attempts = attempts + 1, locked_at = ?, locked_by = ?, updated_at = ?
       WHERE generation_id IN (${placeholders})`,
    ).run(now, dispatchWorkerId, now, ...candidates.map((job) => job.generation_id));
    return candidates.map((job) => ({ ...job, attempts: job.attempts + 1 }));
  })();
}

async function dispatchJob(job: DispatchJob) {
  const leaseHeartbeat = setInterval(() => {
    void db.prepare(`UPDATE generation_dispatch_jobs SET locked_at = ?, updated_at = ?
      WHERE generation_id = ? AND status = 'dispatching' AND locked_by = ? AND attempts = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), job.generation_id, dispatchWorkerId, job.attempts)
      .catch((error) => console.error("[generation:lease-heartbeat-failed]", { generationId: job.generation_id, error }));
  }, 30_000);
  leaseHeartbeat.unref?.();
  let payload: GenerationDispatchPayload;
  try {
    payload = JSON.parse(job.payload_json) as GenerationDispatchPayload;
  } catch {
    const message = "Invalid queued generation payload";
    const now = new Date().toISOString();
    const changed = await db.prepare(`UPDATE generation_dispatch_jobs SET status = 'failed', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ?
      WHERE generation_id = ? AND status = 'dispatching' AND locked_by = ? AND attempts = ?`)
      .run(message, now, job.generation_id, dispatchWorkerId, job.attempts);
    if (changed.changes === 1) {
      await db.prepare("UPDATE generations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(message, now, job.generation_id);
      await (await usageAuthority()).releaseGeneration(job.generation_id, "invalid_dispatch_payload");
    }
    clearInterval(leaseHeartbeat);
    return;
  }

  try {
    const task = await generationProvider().start(payload);
    const now = new Date().toISOString();
    await db.transaction(async () => {
      const lease = await db.prepare(`SELECT status FROM generation_dispatch_jobs
        WHERE generation_id = ? AND status = 'dispatching' AND locked_by = ? AND attempts = ? FOR UPDATE`)
        .get(job.generation_id, dispatchWorkerId, job.attempts);
      if (!lease) return;
      const current = await db.prepare("SELECT status FROM generations WHERE id = ?").get(job.generation_id) as { status: string } | undefined;
      const terminal = current && ["failed", "fail", "error", "cancelled", "canceled", "completed", "complete", "succeeded", "success"].includes(current.status.toLowerCase());
      if (terminal) {
        // Keep the provider id for observability and webhook matching, but never
        // let a late create response revive a task already timed out/refunded.
        await db.prepare("UPDATE generations SET provider_task_id = COALESCE(provider_task_id, ?) WHERE id = ?").run(task.task_id, job.generation_id);
        await db.prepare("UPDATE generation_dispatch_jobs SET status = 'failed', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE generation_id = ? AND locked_by = ? AND attempts = ?")
          .run("Generation became terminal before provider dispatch completed", now, job.generation_id, dispatchWorkerId, job.attempts);
      } else {
        await db.prepare(
          "UPDATE generations SET provider_task_id = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?",
        ).run(task.task_id, String(task.status || "created").toLowerCase(), now, job.generation_id);
        await db.prepare(
          "UPDATE generation_dispatch_jobs SET status = 'dispatched', last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE generation_id = ? AND locked_by = ? AND attempts = ?",
        ).run(now, job.generation_id, dispatchWorkerId, job.attempts);
      }
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation dispatch failed";
    const nowMs = Date.now();
    const retryAfterMs = generationProvider().rateLimitRetryAfter(error);
    if (retryAfterMs !== null) {
      const retryAt = new Date(nowMs + Math.max(1_000, retryAfterMs)).toISOString();
      const now = new Date(nowMs).toISOString();
      await db.transaction(async () => {
        const changed = await db.prepare(
          "UPDATE generation_dispatch_jobs SET status = 'queued', available_at = ?, last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE generation_id = ? AND status = 'dispatching' AND locked_by = ? AND attempts = ?",
        ).run(retryAt, message, now, job.generation_id, dispatchWorkerId, job.attempts);
        if (changed.changes === 1) await db.prepare("UPDATE generations SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?").run(now, job.generation_id);
      })();
      scheduleDrain(Math.max(1_000, retryAfterMs));
      return;
    }
    const now = new Date(nowMs).toISOString();
    const leaseFailed = await db.transaction(async () => {
      const changed = await db.prepare("UPDATE generation_dispatch_jobs SET status = 'failed', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE generation_id = ? AND status = 'dispatching' AND locked_by = ? AND attempts = ?")
        .run(message, now, job.generation_id, dispatchWorkerId, job.attempts);
      if (changed.changes === 1) await db.prepare("UPDATE generations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(message, now, job.generation_id);
      return changed.changes === 1;
    })();
    // Only the worker that still owns this exact lease may refund. A late
    // provider response from an expired attempt must not affect a newer one.
    if (leaseFailed) await (await usageAuthority()).releaseGeneration(job.generation_id, "provider_start_failed");
  } finally {
    clearInterval(leaseHeartbeat);
  }
}

async function runDrain() {
  const recoveredAt = new Date(Date.now() - recoveryAgeMs).toISOString();
  await db.prepare(
    `UPDATE generation_dispatch_jobs
     SET status = 'queued', available_at = ?, locked_at = NULL, locked_by = NULL, updated_at = ?
     WHERE status = 'dispatching' AND locked_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM worker_heartbeats worker
         WHERE worker.worker_id = generation_dispatch_jobs.locked_by
           AND worker.last_seen_at >= ?
       )`,
  ).run(new Date().toISOString(), new Date().toISOString(), recoveredAt, recoveredAt);

  while (true) {
    const jobs = await claimReadyJobs();
    if (!jobs.length) {
      const nextQueued = await db.prepare(
        "SELECT available_at FROM generation_dispatch_jobs WHERE status = 'queued' ORDER BY available_at ASC LIMIT 1",
      ).get() as { available_at: string } | undefined;
      const oldestDispatching = await db.prepare(
        "SELECT updated_at FROM generation_dispatch_jobs WHERE status = 'dispatching' ORDER BY updated_at ASC LIMIT 1",
      ).get() as { updated_at: string } | undefined;
      const nextWakeAt = [
        nextQueued ? new Date(nextQueued.available_at).getTime() : Number.POSITIVE_INFINITY,
        oldestDispatching ? new Date(oldestDispatching.updated_at).getTime() + recoveryAgeMs : Number.POSITIVE_INFINITY,
      ].reduce((earliest, value) => Math.min(earliest, value), Number.POSITIVE_INFINITY);
      if (Number.isFinite(nextWakeAt)) scheduleDrain(Math.max(50, nextWakeAt - Date.now()));
      return;
    }
    await Promise.allSettled(jobs.map(dispatchJob));
  }
}

export function drainGenerationDispatchQueue() {
  if (shared.scenelithDispatchPromise) return shared.scenelithDispatchPromise;
  shared.scenelithDispatchPromise = runDrain().finally(() => {
    shared.scenelithDispatchPromise = undefined;
  });
  return shared.scenelithDispatchPromise;
}

const providerWorkflowCompletedStatuses = new Set(["completed", "complete", "succeeded", "success"]);

/**
 * Grok Image 2 edits are a provider-level two-step workflow. Kie first needs
 * a segment-map task for an arbitrary source image, then the edit task uses
 * that task id. Both steps stay inside one Scenelith generation/job so users
 * see one operation, one charge and one final output.
 */
export async function advanceGenerationProviderWorkflow(input: {
  generationId: string;
  providerTaskId: string;
  providerStatus: string;
}) {
  let shouldDrain = false;
  const handled = await db.transaction(async () => {
    const job = await db.prepare(
      "SELECT payload_json FROM generation_dispatch_jobs WHERE generation_id = ? FOR UPDATE",
    ).get(input.generationId) as { payload_json: string } | undefined;
    if (!job) return false;
    let payload: GenerationDispatchPayload;
    try {
      payload = JSON.parse(job.payload_json) as GenerationDispatchPayload;
    } catch {
      return false;
    }
    const workflow = payload.providerWorkflow;
    if (workflow?.kind !== "grok-image-edit") return false;

    // Kie can retry the segment callback after the edit stage has already
    // started. Never let that old task overwrite the current provider task.
    if (workflow.stage === "image-edit" && workflow.segmentTaskId === input.providerTaskId) return true;
    if (workflow.stage !== "segment-map" || !providerWorkflowCompletedStatuses.has(input.providerStatus.toLowerCase())) return false;

    const generation = await db.prepare("SELECT provider_task_id FROM generations WHERE id = ? FOR UPDATE")
      .get(input.generationId) as { provider_task_id: string | null } | undefined;
    if (!generation || generation.provider_task_id !== input.providerTaskId) return false;

    const now = new Date().toISOString();
    const nextPayload: GenerationDispatchPayload = {
      ...payload,
      providerWorkflow: {
        kind: "grok-image-edit",
        stage: "image-edit",
        segmentTaskId: input.providerTaskId,
      },
    };
    await db.prepare(
      `UPDATE generation_dispatch_jobs
       SET payload_json = ?, status = 'queued', available_at = ?, last_error = NULL,
           locked_at = NULL, locked_by = NULL, updated_at = ?
       WHERE generation_id = ?`,
    ).run(JSON.stringify(nextPayload), now, now, input.generationId);
    await db.prepare(
      "UPDATE generations SET status = 'queued', output_url = NULL, error = NULL, updated_at = ? WHERE id = ?",
    ).run(now, input.generationId);
    shouldDrain = true;
    return true;
  })();
  if (shouldDrain) void drainGenerationDispatchQueue();
  return handled;
}

export async function queuedGenerationPosition(generationId: string) {
  const job = await db.prepare("SELECT status, created_at FROM generation_dispatch_jobs WHERE generation_id = ?").get(generationId) as
    | { status: string; created_at: string }
    | undefined;
  if (!job || job.status !== "queued") return null;
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM generation_dispatch_jobs
     WHERE status IN ('queued', 'dispatching') AND created_at <= ?`,
  ).get(job.created_at) as { count: number };
  return Math.max(1, row.count);
}
