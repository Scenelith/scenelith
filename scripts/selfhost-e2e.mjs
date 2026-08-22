import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import { argument, root } from "./selfhost-operations.mjs";

const baseUrl = (argument("--url") || "http://localhost").replace(/\/$/, "");
const phase = argument("--phase") || "seed";
const statePath = resolve(root, argument("--state") || ".selfhost-e2e-state.json");

function fail(message) {
  throw new Error(`Self-hosted E2E failed: ${message}`);
}

async function jsonRequest(path, options = {}, expected = [200]) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) fail(`${options.method || "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

function authenticated(cookie, options = {}) {
  return {
    ...options,
    headers: {
      cookie,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  };
}

async function collaborationToken(cookie, projectId) {
  const { body } = await jsonRequest("/api/collaboration/token", authenticated(cookie, {
    method: "POST",
    body: JSON.stringify({ projectId }),
  }));
  if (!body.token) fail("collaboration token is missing");
  return body.token;
}

async function connectDocument(cookie, projectId) {
  const document = new Y.Doc();
  const token = await collaborationToken(cookie, projectId);
  let provider;
  const synced = new Promise((resolveSynced, reject) => {
    const timeout = setTimeout(() => reject(new Error("collaboration sync timed out")), 15_000);
    provider = new HocuspocusProvider({
      url: `${baseUrl.replace(/^http/, "ws")}/collaboration`,
      name: projectId,
      document,
      token,
      WebSocketPolyfill: WebSocket,
      onSynced: () => {
        clearTimeout(timeout);
        resolveSynced();
      },
      onAuthenticationFailed: ({ reason }) => {
        clearTimeout(timeout);
        reject(new Error(`collaboration authentication failed: ${reason || "unknown"}`));
      },
    });
  });
  await synced;
  return { document, provider };
}

async function waitForFlush(provider) {
  provider.flushPendingUpdates();
  if (!provider.hasUnsyncedChanges) return;
  await new Promise((resolveFlush, reject) => {
    const timeout = setTimeout(() => {
      provider.off("unsyncedChanges", onUnsynced);
      reject(new Error("collaboration update acknowledgement timed out"));
    }, 15_000);
    function onUnsynced({ number }) {
      if (number !== 0) return;
      clearTimeout(timeout);
      provider.off("unsyncedChanges", onUnsynced);
      resolveFlush();
    }
    provider.on("unsyncedChanges", onUnsynced);
  });
}

async function assertRealtimeMarker(cookie, projectId, marker, write) {
  const { document, provider } = await connectDocument(cookie, projectId);
  try {
    const state = document.getMap("scenelith-selfhost-e2e");
    if (write) {
      state.set("marker", marker);
      await waitForFlush(provider);
    } else if (state.get("marker") !== marker) {
      fail("collaboration document did not survive reconnect/restart");
    }
  } finally {
    provider.destroy();
    document.destroy();
  }
}

async function seed() {
  const suffix = crypto.randomUUID();
  const registration = await jsonRequest("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      name: "Self-hosted Owner",
      email: `owner-${suffix}@example.test`,
      password: "Scenelith-E2E-Password-2026!",
      confirmPassword: "Scenelith-E2E-Password-2026!",
    }),
  });
  if (!registration.body.user?.isAdmin) fail("first self-hosted account is not the instance administrator");
  const sessionHeader = registration.response.headers.get("set-cookie") || "";
  const session = sessionHeader.match(/frameflow_session=([^;]+)/)?.[1];
  if (!session) fail("registration did not issue a session cookie");
  const cookie = `frameflow_session=${session}`;

  await jsonRequest("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      name: "Unexpected second owner",
      email: `second-${suffix}@example.test`,
      password: "Scenelith-E2E-Password-2026!",
      confirmPassword: "Scenelith-E2E-Password-2026!",
    }),
  }, [403]);

  const projectName = `Persistence ${suffix}`;
  const created = await jsonRequest("/api/projects", authenticated(cookie, {
    method: "POST",
    body: JSON.stringify({ name: projectName }),
  }));
  const projectId = created.body.project?.id;
  if (!projectId) fail("project creation returned no project id");
  const graphMarker = `graph-${suffix}`;
  const updated = await jsonRequest(`/api/projects/${projectId}`, authenticated(cookie, {
    method: "PATCH",
    body: JSON.stringify({
      revision: created.body.project.revision,
      graph: { nodes: [], edges: [], viewport: { x: 17, y: 29, zoom: 0.83 } },
      sourceUrl: `https://example.test/${graphMarker}`,
    }),
  }));
  if (updated.body.project?.sourceUrl !== `https://example.test/${graphMarker}`) fail("project graph metadata was not saved");

  const realtimeMarker = `realtime-${suffix}`;
  await assertRealtimeMarker(cookie, projectId, realtimeMarker, true);
  await assertRealtimeMarker(cookie, projectId, realtimeMarker, false);

  const support = await jsonRequest("/api/support", authenticated(cookie, {
    method: "POST",
    headers: { origin: baseUrl },
    body: JSON.stringify({
      subject: `Self-hosted support ${suffix}`,
      category: "account",
      body: "Verify the public support queue on this self-hosted instance.",
    }),
  }), [201]);
  if (support.body.ticket?.supportTier !== "community" || support.body.ticket?.supportTierName !== "Community") {
    fail("support queue did not use the self-hosted support tier");
  }
  const supportId = support.body.ticket?.id;
  if (!supportId) fail("support ticket creation returned no id");

  writeFileSync(statePath, `${JSON.stringify({ cookie, projectId, projectName, graphMarker, realtimeMarker, supportId }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Seeded and verified self-hosted state: ${projectId}`);
}

async function verify() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const { body } = await jsonRequest(`/api/projects/${state.projectId}`, authenticated(state.cookie));
  if (body.project?.name !== state.projectName) fail("project identity did not survive restart/restore");
  if (body.project?.sourceUrl !== `https://example.test/${state.graphMarker}`) fail("project data did not survive restart/restore");
  await assertRealtimeMarker(state.cookie, state.projectId, state.realtimeMarker, false);
  const support = await jsonRequest(`/api/support/${state.supportId}`, authenticated(state.cookie));
  if (support.body.ticket?.planSlug !== "selfhost") fail("self-hosted support ticket did not survive restart/restore");
  console.log(`Verified persisted self-hosted state: ${state.projectId}`);
}

async function mutate() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const mutatedName = `MUTATED-${state.projectName}`;
  const { body } = await jsonRequest(`/api/projects/${state.projectId}`, authenticated(state.cookie, {
    method: "PATCH",
    body: JSON.stringify({ name: mutatedName }),
  }));
  if (body.project?.name !== mutatedName) fail("restore rehearsal mutation was not applied");
  console.log(`Mutated self-hosted state before restore: ${state.projectId}`);
}

if (phase === "seed") await seed();
else if (phase === "verify") await verify();
else if (phase === "mutate") await mutate();
else fail(`unknown phase ${phase}`);
