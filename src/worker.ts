import { createServer } from "node:http";
import { closeRelationalPool } from "./lib/relational-db";
import { db } from "./lib/postgres-db";
import { closeKieRateLimiter } from "./lib/kie-rate-limit";
import { tickGenerationWorker } from "./lib/generation-worker";
import { drainTikTokAutomationJobs, startTikTokAutomationWorkers } from "./lib/tiktok-automation-jobs";
import { expireAllStaleGenerations } from "./lib/generation-lifecycle";
import { workerIdentity } from "./lib/worker-identity";
import { drainStorageLifecycle } from "./lib/storage-lifecycle";
import { readRuntimeConfig } from "./platform/runtime-config";
import { distributionWorker } from "./distribution/worker-extension";

const role = process.env.WORKER_ROLE || "all";
const runtimeConfig = readRuntimeConfig();
const runsGeneration = role === "all" || role === "generation";
const runsAutomation = role === "all" || role === "automation";
const runsDistribution = distributionWorker.enabled(role);
const runsStorage = role === "all" || role === "storage";
const startedAt = new Date().toISOString();
// Queue leases use role-specific worker ids. When one process runs both queues,
// publish both role heartbeats so stale recovery can still distinguish a slow
// live provider call from a dead process.
const heartbeatWorkers = [
  ...(runsGeneration ? [{ id: workerIdentity("generation"), role: "generation" }] : []),
  ...(runsAutomation ? [{ id: workerIdentity("automation"), role: "automation" }] : []),
  ...(runsDistribution ? [{ id: workerIdentity(distributionWorker.heartbeatRole), role: distributionWorker.heartbeatRole }] : []),
  ...(runsStorage ? [{ id: workerIdentity("storage"), role: "storage" }] : []),
].filter((worker, index, workers) => workers.findIndex((candidate) => candidate.id === worker.id) === index);
let stopping = false;
let lastCycleStartedAt = startedAt;
let lastCycleCompletedAt = startedAt;
let lastHeartbeatAt = startedAt;
let lastCycleError: string | null = null;
let activeCycle: Promise<void> = Promise.resolve();
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatCleanupCounter = 0;

async function heartbeat() {
  const now = new Date().toISOString();
  await Promise.all(heartbeatWorkers.map((worker) => db.prepare(`INSERT INTO worker_heartbeats (worker_id, worker_role, started_at, last_seen_at, last_error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_error = excluded.last_error`)
    .run(worker.id, worker.role, startedAt, now, lastCycleError)));
  lastHeartbeatAt = now;
  heartbeatCleanupCounter += 1;
  if (heartbeatCleanupCounter % 360 === 0) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await Promise.all([
      db.prepare("DELETE FROM worker_heartbeats WHERE last_seen_at < ?").run(sevenDaysAgo),
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now),
      runsGeneration
        ? db.prepare("DELETE FROM generation_dispatch_jobs WHERE status IN ('dispatched', 'failed') AND updated_at < ?").run(thirtyDaysAgo)
        : Promise.resolve({ changes: 0 }),
      runsAutomation
        ? db.prepare("DELETE FROM tiktok_automation_jobs WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at < ?").run(sevenDaysAgo)
        : Promise.resolve({ changes: 0 }),
      runsDistribution ? distributionWorker.cleanup(thirtyDaysAgo) : Promise.resolve(),
      runsStorage
        ? db.prepare("DELETE FROM audit_events WHERE expires_at < ?").run(now)
        : Promise.resolve({ changes: 0 }),
    ]);
    if (runsGeneration) {
      await db.prepare(`WITH candidates AS (
        SELECT project_id, revision, created_at,
          max(revision) OVER (PARTITION BY project_id) AS latest_revision,
          row_number() OVER (
            PARTITION BY project_id,
              CASE
                WHEN created_at >= now() - interval '1 day' THEN date_bin(interval '5 minutes', created_at, timestamptz '2000-01-01')
                WHEN created_at >= now() - interval '7 days' THEN date_bin(interval '1 hour', created_at, timestamptz '2000-01-01')
                ELSE date_bin(interval '1 day', created_at, timestamptz '2000-01-01')
              END
            ORDER BY created_at DESC
          ) AS bucket_rank
        FROM project_snapshot_versions
      )
      DELETE FROM project_snapshot_versions version
      USING candidates candidate
      WHERE version.project_id = candidate.project_id
        AND version.revision = candidate.revision
        AND candidate.revision <> candidate.latest_revision
        AND (candidate.created_at < now() - interval '90 days' OR candidate.bucket_rank > 1)`)
        .run();
    }
  }
}

async function cycle() {
  if (stopping) return;
  lastCycleStartedAt = new Date().toISOString();
  try {
    await Promise.all([
      runsGeneration ? tickGenerationWorker() : Promise.resolve(),
      runsAutomation ? drainTikTokAutomationJobs() : Promise.resolve(),
      runsDistribution ? distributionWorker.drain() : Promise.resolve(),
      runsStorage ? drainStorageLifecycle() : Promise.resolve(0),
      runsGeneration ? expireAllStaleGenerations() : Promise.resolve(0),
    ]);
    lastCycleCompletedAt = new Date().toISOString();
    lastCycleError = null;
  } catch (error) {
    lastCycleError = error instanceof Error ? error.message : String(error);
    await heartbeat().catch(() => undefined);
    console.error("[worker:cycle-failed]", { role, error });
  }
}

const healthServer = createServer((_request, response) => {
  const stale = Date.now() - Date.parse(lastHeartbeatAt) > 30_000;
  const healthy = !stale && !lastCycleError;
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({
    ok: healthy,
    role,
    startedAt,
    lastHeartbeatAt,
    lastCycleStartedAt,
    lastCycleCompletedAt,
    lastCycleError,
  }));
});
let cycleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleCycle(delayMs = 1_000) {
  if (stopping) return;
  cycleTimer = setTimeout(() => {
    activeCycle = cycle().finally(() => scheduleCycle());
  }, delayMs);
  cycleTimer.unref?.();
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  if (cycleTimer) clearTimeout(cycleTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  console.info("[worker:shutdown]", { role, signal });
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await Promise.allSettled([activeCycle]);
  await Promise.all(heartbeatWorkers.map((worker) =>
    db.prepare("DELETE FROM worker_heartbeats WHERE worker_id = ?").run(worker.id).catch(() => undefined),
  ));
  await Promise.allSettled([closeKieRateLimiter(), closeRelationalPool()]);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

async function main() {
  if (runsAutomation) await startTikTokAutomationWorkers();
  await heartbeat();
  heartbeatTimer = setInterval(() => void heartbeat().catch((error) => {
    console.error("[worker:heartbeat-failed]", { role, error });
  }), 10_000);
  heartbeatTimer.unref?.();
  activeCycle = cycle();
  await activeCycle;
  scheduleCycle();
  healthServer.listen(Number(process.env.WORKER_HEALTH_PORT || 3001), "0.0.0.0");
  console.info("[worker:ready]", { role, deploymentType: runtimeConfig.deploymentType });
}

void main().catch(async (error) => {
  console.error("[worker:start-failed]", error);
  await Promise.allSettled([closeKieRateLimiter(), closeRelationalPool()]);
  process.exit(1);
});
