import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { closeRelationalPool } from "./lib/relational-db";
import { db } from "./lib/postgres-db";
import { closeKieRateLimiter } from "./lib/kie-rate-limit";
import { tickGenerationWorker } from "./lib/generation-worker";
import { drainTikTokAutomationJobs, startTikTokAutomationWorkers } from "./lib/tiktok-automation-jobs";
import { expireAllStaleGenerations } from "./lib/generation-lifecycle";
import { workerIdentity } from "./lib/worker-identity";
import { drainStorageLifecycle } from "./lib/storage-lifecycle";
import { readRuntimeConfig } from "./platform/runtime-config";
import { editionWorker } from "./editions/current/worker";
import { metric, metricFamily, operationalCountersPrometheus, operationalLog, prometheusDocument } from "./lib/operational-telemetry";

const role = process.env.WORKER_ROLE || "all";
const runtimeConfig = readRuntimeConfig();
const runsGeneration = role === "all" || role === "generation";
const runsAutomation = role === "all" || role === "automation";
const runsDistribution = editionWorker.enabled(role);
const runsStorage = role === "all" || role === "storage";
const startedAt = new Date().toISOString();
// Queue leases use role-specific worker ids. When one process runs both queues,
// publish both role heartbeats so stale recovery can still distinguish a slow
// live provider call from a dead process.
const heartbeatWorkers = [
  ...(runsGeneration ? [{ id: workerIdentity("generation"), role: "generation" }] : []),
  ...(runsAutomation ? [{ id: workerIdentity("automation"), role: "automation" }] : []),
  ...(runsDistribution ? [{ id: workerIdentity(editionWorker.heartbeatRole), role: editionWorker.heartbeatRole }] : []),
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
let cycleRuns = 0;
let cycleFailures = 0;
let heartbeatFailures = 0;
let lastCycleDurationSeconds = 0;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

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
      runsDistribution ? editionWorker.cleanup(thirtyDaysAgo) : Promise.resolve(),
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
  const cycleStarted = performance.now();
  cycleRuns += 1;
  try {
    await Promise.all([
      runsGeneration ? tickGenerationWorker() : Promise.resolve(),
      runsAutomation ? drainTikTokAutomationJobs() : Promise.resolve(),
      runsDistribution ? editionWorker.drain() : Promise.resolve(),
      runsStorage ? drainStorageLifecycle() : Promise.resolve(0),
      runsGeneration ? expireAllStaleGenerations() : Promise.resolve(0),
    ]);
    lastCycleCompletedAt = new Date().toISOString();
    lastCycleError = null;
  } catch (error) {
    cycleFailures += 1;
    lastCycleError = error instanceof Error ? error.message : String(error);
    await heartbeat().catch(() => undefined);
    operationalLog("error", "worker_cycle_failed", { role, error: lastCycleError });
  } finally {
    lastCycleDurationSeconds = (performance.now() - cycleStarted) / 1_000;
  }
}

function metricsResponse() {
  const labels = { role };
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return `${prometheusDocument([
    metricFamily("scenelith_worker_up", "gauge", "Whether the worker process is running.", [metric("scenelith_worker_up", 1, labels)]),
    metricFamily("scenelith_worker_cycle_runs_total", "counter", "Worker cycles started since process start.", [metric("scenelith_worker_cycle_runs_total", cycleRuns, labels)]),
    metricFamily("scenelith_worker_cycle_failures_total", "counter", "Worker cycles that raised an error.", [metric("scenelith_worker_cycle_failures_total", cycleFailures, labels)]),
    metricFamily("scenelith_worker_heartbeat_failures_total", "counter", "Worker heartbeat writes that failed.", [metric("scenelith_worker_heartbeat_failures_total", heartbeatFailures, labels)]),
    metricFamily("scenelith_worker_cycle_duration_seconds", "gauge", "Duration of the latest completed worker cycle.", [metric("scenelith_worker_cycle_duration_seconds", lastCycleDurationSeconds, labels)]),
    metricFamily("scenelith_worker_last_cycle_success_unixtime", "gauge", "Unix time of the latest successful worker cycle.", [metric("scenelith_worker_last_cycle_success_unixtime", Date.parse(lastCycleCompletedAt) / 1_000, labels)]),
    metricFamily("scenelith_worker_heartbeat_age_seconds", "gauge", "Age of the latest successful database heartbeat.", [metric("scenelith_worker_heartbeat_age_seconds", Math.max(0, (Date.now() - Date.parse(lastHeartbeatAt)) / 1_000), labels)]),
    metricFamily("scenelith_worker_event_loop_delay_seconds", "gauge", "Mean and maximum event loop delay since process start.", [
      metric("scenelith_worker_event_loop_delay_seconds", eventLoopDelay.mean / 1e9, { ...labels, statistic: "mean" }),
      metric("scenelith_worker_event_loop_delay_seconds", eventLoopDelay.max / 1e9, { ...labels, statistic: "max" }),
    ]),
    metricFamily("scenelith_worker_process_resident_memory_bytes", "gauge", "Resident memory used by the worker process.", [metric("scenelith_worker_process_resident_memory_bytes", memory.rss, labels)]),
    metricFamily("scenelith_worker_process_heap_bytes", "gauge", "Heap memory used by the worker process.", [metric("scenelith_worker_process_heap_bytes", memory.heapUsed, labels)]),
    metricFamily("scenelith_worker_process_cpu_seconds_total", "counter", "CPU time consumed by the worker process.", [
      metric("scenelith_worker_process_cpu_seconds_total", cpu.user / 1e6, { ...labels, mode: "user" }),
      metric("scenelith_worker_process_cpu_seconds_total", cpu.system / 1e6, { ...labels, mode: "system" }),
    ]),
    metricFamily("scenelith_worker_process_uptime_seconds", "gauge", "Worker process uptime.", [metric("scenelith_worker_process_uptime_seconds", process.uptime(), labels)]),
  ])}${operationalCountersPrometheus()}`;
}

const healthServer = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://worker");
  if (request.method === "GET" && url.pathname === "/metrics") {
    const metricsSecret = process.env.SCENELITH_INTERNAL_METRICS_SECRET;
    if (!metricsSecret || request.headers.authorization !== `Bearer ${metricsSecret}`) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Unauthorized\n");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
    response.end(metricsResponse());
    return;
  }
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
  operationalLog("info", "worker_shutdown", { role, signal });
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
    heartbeatFailures += 1;
    operationalLog("error", "worker_heartbeat_failed", { role, error: error instanceof Error ? error.message : String(error) });
  }), 10_000);
  heartbeatTimer.unref?.();
  activeCycle = cycle();
  await activeCycle;
  scheduleCycle();
  healthServer.listen(Number(process.env.WORKER_HEALTH_PORT || 3001), "0.0.0.0");
  operationalLog("info", "worker_ready", { role, deploymentType: runtimeConfig.deploymentType });
}

void main().catch(async (error) => {
  operationalLog("error", "worker_start_failed", { role, error: error instanceof Error ? error.message : String(error) });
  await Promise.allSettled([closeKieRateLimiter(), closeRelationalPool()]);
  process.exit(1);
});
