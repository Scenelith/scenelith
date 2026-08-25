import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import { argument, root } from "./selfhost-operations.mjs";

const baseUrl = (argument("--url") || "http://localhost").replace(/\/$/, "");
const statePath = resolve(root, argument("--state") || ".selfhost-e2e-state.json");
const requestCount = boundedInteger("--requests", 240, 1, 20_000);
const concurrency = boundedInteger("--concurrency", 12, 1, 200);
const peerCount = boundedInteger("--peers", 6, 2, 100);
const p95BudgetMs = boundedInteger("--p95-ms", 2_000, 50, 60_000);
const state = JSON.parse(readFileSync(statePath, "utf8"));

function fail(message) {
  throw new Error(`Self-hosted load proof failed: ${message}`);
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = argument(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] || 0;
}

async function collaborationToken() {
  const response = await fetch(`${baseUrl}/api/collaboration/token`, {
    method: "POST",
    headers: { cookie: state.cookie, "content-type": "application/json" },
    body: JSON.stringify({ projectId: state.projectId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) fail(`collaboration token returned ${response.status}`);
  return body.token;
}

async function connectPeer() {
  const document = new Y.Doc();
  const token = await collaborationToken();
  let provider;
  await new Promise((resolveSync, reject) => {
    const timeout = setTimeout(() => reject(new Error("realtime peer sync timed out")), 20_000);
    provider = new HocuspocusProvider({
      url: `${baseUrl.replace(/^http/, "ws")}/collaboration`,
      name: state.projectId,
      document,
      token,
      WebSocketPolyfill: WebSocket,
      onSynced: () => {
        clearTimeout(timeout);
        resolveSync();
      },
      onAuthenticationFailed: ({ reason }) => {
        clearTimeout(timeout);
        reject(new Error(`realtime peer authentication failed: ${reason || "unknown"}`));
      },
    });
  });
  return { document, provider };
}

async function waitForFlush(provider) {
  await new Promise((resolveFlush, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("realtime acknowledgement timed out")), 20_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      provider.off("unsyncedChanges", onUnsynced);
      if (error) reject(error);
      else resolveFlush();
    };
    const onUnsynced = ({ number }) => {
      if (number !== 0) return;
      finish();
    };
    provider.on("unsyncedChanges", onUnsynced);
    provider.flushPendingUpdates();
    queueMicrotask(() => { if (!provider.hasUnsyncedChanges) finish(); });
  });
}

async function waitForConvergence(peers, markerPrefix) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const converged = peers.every(({ document }) => {
      const markers = document.getMap("scenelith-load-proof");
      return Array.from({ length: peerCount }, (_, index) => markers.get(`${markerPrefix}-${index}`) === index).every(Boolean);
    });
    if (converged) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  fail(`${peerCount} realtime peers did not converge`);
}

async function proveHttpConcurrency() {
  const durations = [];
  let cursor = 0;
  let failures = 0;
  const paths = [
    `/api/projects/${encodeURIComponent(state.projectId)}`,
    "/api/tasks",
    "/api/runtime/settings",
    "/api/health/ready",
  ];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= requestCount) return;
      const started = performance.now();
      const response = await fetch(`${baseUrl}${paths[index % paths.length]}`, { headers: { cookie: state.cookie } }).catch(() => null);
      durations.push(performance.now() - started);
      if (!response?.ok) failures += 1;
      await response?.arrayBuffer().catch(() => undefined);
    }
  }));
  const p95 = percentile(durations, 0.95);
  if (failures) fail(`${failures}/${requestCount} HTTP requests failed`);
  if (p95 > p95BudgetMs) fail(`HTTP p95 ${Math.round(p95)}ms exceeds ${p95BudgetMs}ms budget`);
  return { requests: requestCount, concurrency, p50Ms: Math.round(percentile(durations, 0.5)), p95Ms: Math.round(p95), maxMs: Math.round(Math.max(...durations)) };
}

async function proveRealtimeConcurrency() {
  const peers = await Promise.all(Array.from({ length: peerCount }, () => connectPeer()));
  const markerPrefix = `run-${crypto.randomUUID()}`;
  const started = performance.now();
  try {
    peers.forEach(({ document }, index) => document.getMap("scenelith-load-proof").set(`${markerPrefix}-${index}`, index));
    await Promise.all(peers.map(({ provider }) => waitForFlush(provider)));
    await waitForConvergence(peers, markerPrefix);
    return { peers: peerCount, convergenceMs: Math.round(performance.now() - started) };
  } finally {
    for (const { document, provider } of peers) {
      provider.destroy();
      document.destroy();
    }
  }
}

const [http, realtime] = await Promise.all([proveHttpConcurrency(), proveRealtimeConcurrency()]);
console.log(JSON.stringify({ ok: true, http, realtime }));
