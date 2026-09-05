import { createHash, randomUUID } from "node:crypto";
import { jwtVerify } from "jose";
import { Pool } from "pg";
import RedisClient from "ioredis";
import * as Y from "yjs";
import { Server } from "@hocuspocus/server";
import { Redis } from "@hocuspocus/extension-redis";
import { graphSummary, numberDocumentNodes, readGraph, writeGraph } from "./document-codec.mjs";
import { assertCollaborationMigrationsCurrent } from "./migration-runner.mjs";

const required = [
  "COLLABORATION_DATABASE_URL",
  "COLLABORATION_INTERNAL_SECRET",
  "COLLABORATION_JWT_SECRET",
  "FRAMEFLOW_INTERNAL_URL",
  "SCENELITH_INTERNAL_METRICS_SECRET",
];
if (process.env.COLLABORATION_DISABLE_REDIS !== "true") required.push("REDIS_URL");
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const pool = new Pool({
  connectionString: process.env.COLLABORATION_DATABASE_URL,
  max: Number(process.env.COLLABORATION_DB_POOL_SIZE || 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
const jwtSecret = new TextEncoder().encode(process.env.COLLABORATION_JWT_SECRET);
const internalSecret = process.env.COLLABORATION_INTERNAL_SECRET;
const metricsSecret = process.env.SCENELITH_INTERNAL_METRICS_SECRET;
const bootstrapUrl = new URL(process.env.FRAMEFLOW_INTERNAL_URL);
const tokenRefreshIntervals = new Map();
const tokenRefreshDeadlines = new Map();
const liveConnections = new Map();
const numberedDocuments = new WeakMap();
const liveConnectionsBySocket = new Map();
const syncRateWindows = new Map();
const maxConnectionsPerUserDocument = Number(process.env.COLLABORATION_MAX_CONNECTIONS_PER_USER_DOCUMENT || 6);
const maxSyncUpdateBytes = Number(process.env.COLLABORATION_MAX_UPDATE_BYTES || 8 * 1024 * 1024);
const journalRetentionDays = Math.max(1, Number(process.env.COLLABORATION_JOURNAL_RETENTION_DAYS || 7));
const versionRetentionDays = Math.max(journalRetentionDays, Number(process.env.COLLABORATION_VERSION_RETENTION_DAYS || 90));
const mirrorWorkerId = `${process.env.HOSTNAME || "collaboration"}:${process.pid}:${randomUUID()}`;
const collaborationControlChannel = "frameflow-collaboration-control-v1";
const telemetry = {
  authenticationAttempts: 0,
  authenticationFailures: 0,
  connectionsAccepted: 0,
  connectionsRejected: 0,
  syncUpdates: 0,
  syncBytes: 0,
  syncFailures: 0,
  documentStoreFailures: 0,
  projectionFailures: 0,
};

function operationalLog(level, event, attributes = {}) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...attributes });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
}

async function verifyCollaborationToken(token, documentName) {
  const verified = await jwtVerify(token, jwtSecret, {
    issuer: "frameflow-web",
    audience: "frameflow-collaboration",
  });
  if (verified.payload.projectId !== documentName || !verified.payload.sub) throw new Error("Not authorized");
  const stored = await pool.query(
    `SELECT document.epoch, document.compacting,
       EXISTS (SELECT 1 FROM collaboration_document_tombstones WHERE document_name = $1) AS deleted
     FROM (SELECT $1::text AS document_name) requested
     LEFT JOIN collaboration_documents document ON document.document_name = requested.document_name`,
    [documentName],
  );
  if (stored.rows[0]?.deleted) throw new Error("Canvas was deleted");
  const documentEpoch = Math.max(1, Number(stored.rows[0]?.epoch || 1));
  if (stored.rows[0]?.compacting || Number(verified.payload.documentEpoch || 1) !== documentEpoch) {
    throw new Error("Canvas checkpoint changed");
  }
  return {
    userId: String(verified.payload.sub),
    workspaceId: String(verified.payload.workspaceId || ""),
    permission: String(verified.payload.permission || "write"),
    role: String(verified.payload.role || "member"),
    name: String(verified.payload.name || "Teammate").slice(0, 120),
    documentEpoch,
  };
}

function collaboratorColor(userId) {
  const colors = ["#6fdbb5", "#75a7ff", "#efb663", "#db8cff", "#ff7d8d", "#70cedb"];
  let hash = 0;
  for (const character of userId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function accessConnectionKey(userId, documentName) {
  return `${userId}:${documentName}`;
}

function registerLiveConnection(context, documentName, socketId, connection) {
  const key = accessConnectionKey(context.userId, documentName);
  const connections = liveConnections.get(key) || new Set();
  if (connections.size >= maxConnectionsPerUserDocument) return false;
  connections.add(connection);
  liveConnections.set(key, connections);
  liveConnectionsBySocket.set(connectionKey(socketId, documentName), { context, documentName, connection });
  return true;
}

function unregisterLiveConnection(context, documentName, connection) {
  if (!context?.userId) return;
  const key = accessConnectionKey(context.userId, documentName);
  const connections = liveConnections.get(key);
  if (!connections) return;
  connections.delete(connection);
  if (!connections.size) liveConnections.delete(key);
}

function unregisterLiveConnectionBySocket(socketId, documentName) {
  const key = connectionKey(socketId, documentName);
  const registered = liveConnectionsBySocket.get(key);
  if (!registered) return;
  liveConnectionsBySocket.delete(key);
  syncRateWindows.delete(key);
  unregisterLiveConnection(registered.context, registered.documentName, registered.connection);
}

function consumeSyncRate(socketId, documentName, bytes) {
  const key = connectionKey(socketId, documentName);
  const now = Date.now();
  const current = syncRateWindows.get(key);
  const window = !current || now - current.startedAt >= 10_000
    ? { startedAt: now, messages: 0, bytes: 0 }
    : current;
  window.messages += 1;
  window.bytes += bytes;
  syncRateWindows.set(key, window);
  if (window.messages > 600 || window.bytes > 32 * 1024 * 1024) throw new Error("Canvas update rate exceeded");
}

async function journalDocumentUpdate(documentName, update, actorUserId) {
  const hash = createHash("sha256").update(update).digest("hex");
  const inserted = await pool.query(
    `INSERT INTO collaboration_document_updates (document_name, update_hash, update, actor_user_id)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM collaboration_document_tombstones WHERE document_name = $1)
     ON CONFLICT DO NOTHING RETURNING id`,
    [documentName, hash, Buffer.from(update), actorUserId || null],
  );
  if (!inserted.rowCount) return false;
  const measured = await pool.query(
    `UPDATE collaboration_documents
     SET update_bytes_since_checkpoint = update_bytes_since_checkpoint + $2
     WHERE document_name = $1
     RETURNING state_bytes, update_bytes_since_checkpoint`,
    [documentName, update.byteLength],
  );
  const stateBytes = Number(measured.rows[0]?.state_bytes || 0);
  const journalBytes = Number(measured.rows[0]?.update_bytes_since_checkpoint || 0);
  if (stateBytes >= 32 * 1024 * 1024 || journalBytes >= 64 * 1024 * 1024) {
    console.warn(JSON.stringify({ event: "collaboration_document_size_warning", documentName, stateBytes, journalBytes }));
  }
  return true;
}

function revokeLiveAccess(userId, documentNames) {
  const allowedDocuments = documentNames?.length ? new Set(documentNames) : null;
  let closed = 0;
  for (const [key, connections] of liveConnections) {
    const separator = key.indexOf(":");
    const keyUserId = key.slice(0, separator);
    const documentName = key.slice(separator + 1);
    if (keyUserId !== userId || (allowedDocuments && !allowedDocuments.has(documentName))) continue;
    for (const connection of connections) {
      liveConnectionsBySocket.delete(connectionKey(connection.socketId, documentName));
      connection.close({ code: 4403, reason: "Canvas access changed" });
      closed += 1;
    }
    liveConnections.delete(key);
  }
  return closed;
}

function closeDocumentConnections(documentName, reason = "Canvas checkpoint changed") {
  let closed = 0;
  for (const [key, registered] of liveConnectionsBySocket) {
    if (registered.documentName !== documentName) continue;
    liveConnectionsBySocket.delete(key);
    registered.connection.close({ code: 4412, reason });
    unregisterLiveConnection(registered.context, documentName, registered.connection);
    closed += 1;
  }
  return closed;
}

function connectionKey(socketId, documentName) {
  return `${socketId}:${documentName}`;
}

function clearTokenRefresh(key) {
  const interval = tokenRefreshIntervals.get(key);
  const deadline = tokenRefreshDeadlines.get(key);
  if (interval) clearInterval(interval);
  if (deadline) clearTimeout(deadline);
  tokenRefreshIntervals.delete(key);
  tokenRefreshDeadlines.delete(key);
}

async function bootstrapDocument(documentName) {
  const response = await fetch(new URL(`/api/internal/collaboration/bootstrap/${encodeURIComponent(documentName)}`, bootstrapUrl), {
    headers: { authorization: `Bearer ${internalSecret}` },
  });
  if (!response.ok) throw new Error(`Canvas bootstrap failed (${response.status})`);
  const body = await response.json();
  return {
    graph: body.graph || { nodes: [], edges: [] },
    revision: Math.max(1, Number(body.revision || 1)),
    updatedAt: body.updatedAt || new Date().toISOString(),
  };
}

async function loadDocumentState(documentName) {
  const deleted = await pool.query(
    "SELECT 1 FROM collaboration_document_tombstones WHERE document_name = $1",
    [documentName],
  );
  if (deleted.rowCount) throw new Error("Canvas was deleted");
  const existing = await pool.query(
    "SELECT state, last_update_id FROM collaboration_documents WHERE document_name = $1",
    [documentName],
  );
  let state;
  let lastUpdateId = 0;
  if (existing.rowCount) {
    state = new Uint8Array(existing.rows[0].state);
    lastUpdateId = Number(existing.rows[0].last_update_id || 0);
  } else {
    const legacy = await bootstrapDocument(documentName);
    const seed = new Y.Doc();
    writeGraph(seed, legacy.graph, "bootstrap");
    state = Y.encodeStateAsUpdate(seed);
    const summary = graphSummary(legacy.graph);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO collaboration_documents
          (document_name, state, graph, summary, revision, state_bytes, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
         ON CONFLICT (document_name) DO NOTHING`,
        [documentName, Buffer.from(state), JSON.stringify(legacy.graph), JSON.stringify(summary), legacy.revision, state.byteLength, legacy.updatedAt],
      );
      await client.query(
        `INSERT INTO collaboration_projection_outbox (document_name, revision, graph)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (document_name) DO UPDATE SET
           revision = EXCLUDED.revision,
           graph = EXCLUDED.graph,
           attempts = 0,
           available_at = now(),
           locked_at = NULL,
           locked_by = NULL`,
        [documentName, legacy.revision, JSON.stringify(legacy.graph)],
      );
      await client.query(
        `INSERT INTO collaboration_document_versions
          (document_name, revision, state, graph, summary, last_update_id, actor_user_id, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 0, 'legacy-bootstrap', $6)
         ON CONFLICT DO NOTHING`,
        [documentName, legacy.revision, Buffer.from(state), JSON.stringify(legacy.graph), JSON.stringify(summary), legacy.updatedAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const winner = await pool.query(
      "SELECT state, last_update_id FROM collaboration_documents WHERE document_name = $1",
      [documentName],
    );
    state = new Uint8Array(winner.rows[0].state);
    lastUpdateId = Number(winner.rows[0].last_update_id || 0);
  }
  const pending = await pool.query(
    "SELECT update FROM collaboration_document_updates WHERE document_name = $1 AND id > $2 ORDER BY id ASC",
    [documentName, lastUpdateId],
  );
  if (!pending.rowCount) return state;
  const replay = new Y.Doc();
  Y.applyUpdate(replay, state, "snapshot");
  for (const row of pending.rows) Y.applyUpdate(replay, new Uint8Array(row.update), "journal-replay");
  return Y.encodeStateAsUpdate(replay);
}

async function persistDocument(documentName, document, actorUserId = null, expectedEpoch = null) {
  const state = Y.encodeStateAsUpdate(document);
  const graph = readGraph(document);
  const summary = graphSummary(graph);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [documentName]);
    const deleted = await client.query(
      "SELECT 1 FROM collaboration_document_tombstones WHERE document_name = $1",
      [documentName],
    );
    if (deleted.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const current = await client.query(
      "SELECT revision, state, graph, summary, last_update_id, epoch, compacting FROM collaboration_documents WHERE document_name = $1 FOR UPDATE",
      [documentName],
    );
    if (current.rowCount && (current.rows[0].compacting || (expectedEpoch != null && Number(current.rows[0].epoch || 1) !== Number(expectedEpoch)))) {
      await client.query("COMMIT");
      return {
        graph: current.rows[0].graph,
        summary: current.rows[0].summary,
        revision: Number(current.rows[0].revision),
        lastUpdateId: Number(current.rows[0].last_update_id || 0),
      };
    }
    const maxUpdate = await client.query(
      "SELECT COALESCE(MAX(id), 0) AS id FROM collaboration_document_updates WHERE document_name = $1",
      [documentName],
    );
    const lastUpdateId = Number(maxUpdate.rows[0].id || 0);
    if (current.rowCount && Buffer.from(current.rows[0].state).equals(Buffer.from(state))) {
      if (lastUpdateId > Number(current.rows[0].last_update_id || 0)) {
        await client.query(
          "UPDATE collaboration_documents SET last_update_id = $2 WHERE document_name = $1",
          [documentName, lastUpdateId],
        );
      }
      await client.query("COMMIT");
      return { graph, summary, revision: Number(current.rows[0].revision), lastUpdateId };
    }
    const revision = Math.max(1, Number(current.rows[0]?.revision || 0) + 1);
    await client.query(
      `INSERT INTO collaboration_documents
        (document_name, state, graph, summary, revision, last_update_id, state_bytes, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, now())
       ON CONFLICT (document_name) DO UPDATE SET
         state = EXCLUDED.state,
         graph = EXCLUDED.graph,
         summary = EXCLUDED.summary,
         revision = EXCLUDED.revision,
         last_update_id = EXCLUDED.last_update_id,
         state_bytes = EXCLUDED.state_bytes,
         updated_at = EXCLUDED.updated_at`,
      [documentName, Buffer.from(state), JSON.stringify(graph), JSON.stringify(summary), revision, lastUpdateId, state.byteLength],
    );
    await client.query(
      `INSERT INTO collaboration_document_versions
        (document_name, revision, state, graph, summary, last_update_id, actor_user_id, version_kind, epoch)
       SELECT $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'automatic', $8
       WHERE NOT EXISTS (
         SELECT 1 FROM collaboration_document_versions
         WHERE document_name = $1 AND created_at >= now() - interval '5 minutes'
       )
       ON CONFLICT DO NOTHING`,
      [documentName, revision, Buffer.from(state), JSON.stringify(graph), JSON.stringify(summary), lastUpdateId, actorUserId, Math.max(1, Number(current.rows[0]?.epoch || 1))],
    );
    await client.query(
      `INSERT INTO collaboration_projection_outbox (document_name, revision, graph)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (document_name) DO UPDATE SET
         revision = EXCLUDED.revision,
         graph = EXCLUDED.graph,
         attempts = 0,
         available_at = now(),
         locked_at = NULL,
         locked_by = NULL`,
      [documentName, revision, JSON.stringify(graph)],
    );
    await client.query("COMMIT");
    return { graph, summary, revision, lastUpdateId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let mirrorFlushRunning = false;
async function flushMirrorOutbox() {
  if (mirrorFlushRunning) return;
  mirrorFlushRunning = true;
  try {
    const pending = await pool.query(
      `WITH candidates AS (
         SELECT document_name
         FROM collaboration_projection_outbox
         WHERE available_at <= now()
           AND (locked_at IS NULL OR locked_at < now() - interval '1 minute')
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 20
       )
       UPDATE collaboration_projection_outbox outbox
       SET locked_at = now(), locked_by = $1
       FROM candidates
       WHERE outbox.document_name = candidates.document_name
       RETURNING outbox.document_name, outbox.revision, outbox.graph, outbox.attempts`,
      [mirrorWorkerId],
    );
    for (const item of pending.rows) {
      try {
        const response = await fetch(new URL(`/api/internal/collaboration/mirror/${encodeURIComponent(item.document_name)}`, bootstrapUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${internalSecret}`, "content-type": "application/json" },
          body: JSON.stringify({ graph: item.graph, sourceRevision: Number(item.revision) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Mirror rejected (${response.status})`);
        await pool.query(
          `DELETE FROM collaboration_projection_outbox
           WHERE document_name = $1 AND revision = $2 AND locked_by = $3`,
          [item.document_name, item.revision, mirrorWorkerId],
        );
      } catch (error) {
        telemetry.projectionFailures += 1;
        const attempts = Number(item.attempts || 0) + 1;
        const delaySeconds = Math.min(300, 2 ** Math.min(8, attempts));
        await pool.query(
          `UPDATE collaboration_projection_outbox
           SET attempts = $2,
             available_at = now() + ($3 * interval '1 second'),
             locked_at = NULL,
             locked_by = NULL
           WHERE document_name = $1 AND revision = $4 AND locked_by = $5`,
          [item.document_name, attempts, delaySeconds, item.revision, mirrorWorkerId],
        );
        console.error("Canvas recovery projection failed", { documentName: item.document_name, attempts, error });
      }
    }
  } finally {
    mirrorFlushRunning = false;
  }
}

let historyPruneRunning = false;
async function pruneCollaborationHistory() {
  if (historyPruneRunning) return;
  historyPruneRunning = true;
  try {
    await pool.query(
      `DELETE FROM collaboration_document_updates update_row
       USING collaboration_documents document
       WHERE update_row.document_name = document.document_name
         AND update_row.id <= document.last_update_id
         AND update_row.created_at < now() - ($1 * interval '1 day')`,
      [journalRetentionDays],
    );
    await pool.query(
      `WITH candidates AS (
         SELECT document_name, revision, version_kind, created_at,
           max(revision) OVER (PARTITION BY document_name) AS latest_revision,
           row_number() OVER (
             PARTITION BY document_name,
               CASE
                 WHEN created_at >= now() - interval '1 day' THEN date_bin(interval '5 minutes', created_at, timestamptz '2000-01-01')
                 WHEN created_at >= now() - interval '7 days' THEN date_bin(interval '1 hour', created_at, timestamptz '2000-01-01')
                 ELSE date_bin(interval '1 day', created_at, timestamptz '2000-01-01')
               END
             ORDER BY created_at DESC
           ) AS bucket_rank
         FROM collaboration_document_versions
       )
       DELETE FROM collaboration_document_versions version
       USING candidates candidate
       WHERE version.document_name = candidate.document_name
         AND version.revision = candidate.revision
         AND candidate.version_kind = 'automatic'
         AND candidate.revision <> candidate.latest_revision
         AND (candidate.created_at < now() - ($1 * interval '1 day') OR candidate.bucket_rank > 1)`,
      [versionRetentionDays],
    );
  } catch (error) {
    console.error("Collaboration history pruning failed", error);
  } finally {
    historyPruneRunning = false;
  }
}

async function compactCollaborationDocument(documentName, actorUserId = "internal-service") {
  const marked = await pool.query(
    "UPDATE collaboration_documents SET compacting = true WHERE document_name = $1 AND compacting = false RETURNING epoch",
    [documentName],
  );
  if (!marked.rowCount) throw new Error("Canvas is already checkpointing or does not exist");
  closeDocumentConnections(documentName);
  if (redisHealth) {
    await redisHealth.publish(collaborationControlChannel, JSON.stringify({ type: "close-document", documentName }));
    // Give every collaboration replica a chance to flush and close the old
    // epoch before the checkpoint transaction replaces its binary state.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [documentName]);
    const current = await client.query(
      "SELECT state, graph, summary, revision, last_update_id, epoch, compacting FROM collaboration_documents WHERE document_name = $1 FOR UPDATE",
      [documentName],
    );
    if (!current.rowCount || !current.rows[0].compacting) throw new Error("Canvas checkpoint lock was lost");
    const pending = await client.query(
      "SELECT id, update FROM collaboration_document_updates WHERE document_name = $1 AND id > $2 ORDER BY id ASC",
      [documentName, Number(current.rows[0].last_update_id || 0)],
    );
    const source = new Y.Doc();
    Y.applyUpdate(source, new Uint8Array(current.rows[0].state), "checkpoint-source");
    for (const row of pending.rows) Y.applyUpdate(source, new Uint8Array(row.update), "checkpoint-journal");
    const graph = readGraph(source);
    const summary = graphSummary(graph);
    const fresh = new Y.Doc();
    writeGraph(fresh, graph, "checkpoint");
    const compactedState = Y.encodeStateAsUpdate(fresh);
    const revision = Number(current.rows[0].revision || 0) + 1;
    const epoch = Number(current.rows[0].epoch || 1) + 1;
    const lastUpdateId = pending.rows.length
      ? Number(pending.rows[pending.rows.length - 1].id)
      : Number(current.rows[0].last_update_id || 0);
    await client.query(
      `INSERT INTO collaboration_document_versions
        (document_name, revision, state, graph, summary, last_update_id, actor_user_id, version_kind, epoch)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'checkpoint', $8)
       ON CONFLICT DO NOTHING`,
      [documentName, Number(current.rows[0].revision), current.rows[0].state, JSON.stringify(current.rows[0].graph),
        JSON.stringify(current.rows[0].summary), Number(current.rows[0].last_update_id || 0), actorUserId, Number(current.rows[0].epoch || 1)],
    );
    await client.query(
      `UPDATE collaboration_documents SET state = $2, graph = $3::jsonb, summary = $4::jsonb,
        revision = $5, last_update_id = $6, epoch = $7, compacting = false, state_bytes = $8,
        update_bytes_since_checkpoint = 0, updated_at = now() WHERE document_name = $1`,
      [documentName, Buffer.from(compactedState), JSON.stringify(graph), JSON.stringify(summary), revision, lastUpdateId, epoch, compactedState.byteLength],
    );
    await client.query("DELETE FROM collaboration_document_updates WHERE document_name = $1 AND id <= $2", [documentName, lastUpdateId]);
    await client.query(
      `INSERT INTO collaboration_projection_outbox (document_name, revision, graph)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT(document_name) DO UPDATE SET revision = EXCLUDED.revision, graph = EXCLUDED.graph,
         attempts = 0, available_at = now(), locked_at = NULL, locked_by = NULL`,
      [documentName, revision, JSON.stringify(graph)],
    );
    await client.query("COMMIT");
    return { revision, epoch, stateBytes: compactedState.byteLength, graphBytes: Buffer.byteLength(JSON.stringify(graph)) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await pool.query("UPDATE collaboration_documents SET compacting = false WHERE document_name = $1", [documentName]).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function authorizedInternal(request) {
  return request.headers.authorization === `Bearer ${internalSecret}`;
}

function authorizedMetrics(request) {
  return request.headers.authorization === `Bearer ${metricsSecret}`;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function text(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 25 * 1024 * 1024) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const redisUrl = process.env.COLLABORATION_DISABLE_REDIS === "true" ? null : process.env.REDIS_URL;
const redisHealth = redisUrl
  ? new RedisClient(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  : null;
if (redisHealth) await redisHealth.connect();
const redisControl = redisUrl
  ? new RedisClient(redisUrl, { maxRetriesPerRequest: null })
  : null;
if (redisControl) {
  await redisControl.subscribe(collaborationControlChannel);
  redisControl.on("message", (channel, raw) => {
    if (channel !== collaborationControlChannel) return;
    try {
      const message = JSON.parse(raw);
      if (message.type === "close-document" && message.documentName) closeDocumentConnections(String(message.documentName));
    } catch (error) {
      console.error("Collaboration control message was invalid", error);
    }
  });
}
await assertCollaborationMigrationsCurrent(pool);

const server = new Server({
  port: Number(process.env.COLLABORATION_PORT || 1234),
  address: "0.0.0.0",
  quiet: process.env.NODE_ENV === "production",
  debounce: 900,
  maxDebounce: 5000,
  unloadImmediately: true,
  timeout: 30_000,
  stopOnSignals: false,
  websocketOptions: { maxPayload: maxSyncUpdateBytes + 64 * 1024 },
  maxUnauthenticatedQueueSize: 1024 * 1024,
  maxUnauthenticatedQueueMessages: 128,
  maxPendingDocuments: 8,
  flushDelay: 0,
  flushMaxBytes: 512 * 1024,
  // Hocuspocus needs an independent publisher and subscriber. Let the Redis
  // extension create both clients: reusing a lazily connected client can race
  // ioredis' ready check with SUBSCRIBE and put INFO on a subscriber socket.
  extensions: redisUrl ? [new Redis({
    createClient: () => new RedisClient(redisUrl, { maxRetriesPerRequest: null }),
    identifier: process.env.HOSTNAME || crypto.randomUUID(),
    prefix: "frameflow-collaboration",
  })] : [],
  async onAuthenticate({ token, documentName, connectionConfig }) {
    telemetry.authenticationAttempts += 1;
    try {
      const context = await verifyCollaborationToken(token, documentName);
      connectionConfig.readOnly = context.permission !== "write";
      return context;
    } catch (error) {
      telemetry.authenticationFailures += 1;
      operationalLog("warn", "collaboration_authentication_failed", { documentName, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
  async connected({ connection, socketId, documentName, context }) {
    const key = connectionKey(socketId, documentName);
    clearTokenRefresh(key);
    const current = await pool.query("SELECT epoch, compacting FROM collaboration_documents WHERE document_name = $1", [documentName]);
    if (current.rows[0]?.compacting || Math.max(1, Number(current.rows[0]?.epoch || 1)) !== context.documentEpoch) {
      connection.close({ code: 4412, reason: "Canvas checkpoint changed" });
      return;
    }
    if (!registerLiveConnection(context, documentName, socketId, connection)) {
      telemetry.connectionsRejected += 1;
      connection.close({ code: 4429, reason: "Too many canvas sessions" });
      return;
    }
    telemetry.connectionsAccepted += 1;
    const requestFreshToken = () => {
      connection.requestToken();
      const oldDeadline = tokenRefreshDeadlines.get(key);
      if (oldDeadline) clearTimeout(oldDeadline);
      tokenRefreshDeadlines.set(key, setTimeout(() => {
        connection.close({ code: 4401, reason: "Authorization refresh timed out" });
        clearTokenRefresh(key);
      }, 20_000));
    };
    tokenRefreshIntervals.set(key, setInterval(requestFreshToken, 4 * 60 * 1000));
  },
  async onTokenSync({ token, documentName, socketId, connection }) {
    const context = await verifyCollaborationToken(token, documentName);
    connection.readOnly = context.permission !== "write";
    const key = connectionKey(socketId, documentName);
    const deadline = tokenRefreshDeadlines.get(key);
    if (deadline) clearTimeout(deadline);
    tokenRefreshDeadlines.delete(key);
    return context;
  },
  async onDisconnect({ socketId, documentName }) {
    clearTokenRefresh(connectionKey(socketId, documentName));
    unregisterLiveConnectionBySocket(socketId, documentName);
  },
  async onLoadDocument({ document, documentName }) {
    const state = await loadDocumentState(documentName);
    Y.applyUpdate(document, state, "postgres-load");
    const changed = numberDocumentNodes(document);
    numberedDocuments.set(document, readGraph(document).nodes);
    if (changed) await persistDocument(documentName, document, "node-number-backfill");
    return document;
  },
  async beforeSync({ documentName, type, payload, context, connection }) {
    // The journal write is awaited before the update is applied and acknowledged.
    // A process crash can therefore lose an in-memory snapshot, but not an
    // accepted user operation; onLoadDocument replays everything after it.
    if (type !== 1 && type !== 2) return;
    if (context?.permission !== "write") throw new Error("Canvas is read only");
    if (payload.byteLength > maxSyncUpdateBytes) throw new Error("Canvas update is too large");
    consumeSyncRate(connection.socketId, documentName, payload.byteLength);
    try {
      await journalDocumentUpdate(documentName, payload, context?.userId);
      telemetry.syncUpdates += 1;
      telemetry.syncBytes += payload.byteLength;
    } catch (error) {
      telemetry.syncFailures += 1;
      operationalLog("error", "collaboration_sync_journal_failed", { documentName, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
  async beforeHandleAwareness({ states, context }) {
    if (!context?.userId) return;
    if (states.size > 16 || JSON.stringify([...states.values()]).length > 64 * 1024) {
      throw new Error("Awareness update is too large");
    }
    for (const [clientId, state] of states) {
      states.set(clientId, {
        ...state,
        user: {
          userId: context.userId,
          name: context.name,
          role: context.role,
          color: collaboratorColor(context.userId),
        },
      });
    }
  },
  async onChange({ document, documentName, update, context, transactionOrigin }) {
    const source = transactionOrigin && typeof transactionOrigin === "object" ? transactionOrigin.source : transactionOrigin;
    if (["postgres-load", "journal-replay", "snapshot"].includes(String(source))) return;
    if (source !== "node-numbering" && numberedDocuments.has(document)) {
      // Accept another replica's resolved slots; restoring our stale cache here
      // would make Redis peers repeatedly undo each other's assignments.
      numberDocumentNodes(document, source === "redis" ? undefined : numberedDocuments.get(document));
      numberedDocuments.set(document, readGraph(document).nodes);
    }
    await journalDocumentUpdate(documentName, update, context?.userId);
  },
  async onStoreDocument({ document, documentName, lastContext }) {
    try {
      await persistDocument(documentName, document, lastContext?.userId || null, lastContext?.documentEpoch ?? null);
    } catch (error) {
      telemetry.documentStoreFailures += 1;
      operationalLog("error", "collaboration_document_store_failed", { documentName, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
  async onRequest({ request, response, instance }) {
    const url = new URL(request.url || "/", "http://collaboration");
    if (request.method === "GET" && url.pathname === "/healthz") {
      await pool.query("SELECT 1");
      if (redisHealth) await redisHealth.ping();
      json(response, 200, { ok: true });
      throw null;
    }
    if (!url.pathname.startsWith("/internal/")) return;
    if (request.method === "GET" && url.pathname === "/internal/metrics") {
      if (!authorizedMetrics(request)) {
        json(response, 401, { error: "Unauthorized" });
        throw null;
      }
      const measured = await pool.query(`SELECT
        COUNT(*) AS documents,
        COUNT(*) FILTER (WHERE compacting) AS compacting,
        COALESCE(MAX(state_bytes), 0) AS largest_state_bytes,
        COALESCE(SUM(update_bytes_since_checkpoint), 0) AS journal_bytes,
        (SELECT COUNT(*) FROM collaboration_projection_outbox) AS projection_pending
        FROM collaboration_documents`);
      const row = measured.rows[0];
      text(response, 200, [
        `scenelith_collaboration_live_connections ${liveConnectionsBySocket.size}`,
        `scenelith_collaboration_loaded_documents ${instance.documents?.size || 0}`,
        `scenelith_collaboration_documents ${Number(row.documents || 0)}`,
        `scenelith_collaboration_compacting ${Number(row.compacting || 0)}`,
        `scenelith_collaboration_largest_state_bytes ${Number(row.largest_state_bytes || 0)}`,
        `scenelith_collaboration_journal_bytes ${Number(row.journal_bytes || 0)}`,
        `scenelith_collaboration_projection_pending ${Number(row.projection_pending || 0)}`,
        `scenelith_collaboration_authentication_attempts_total ${telemetry.authenticationAttempts}`,
        `scenelith_collaboration_authentication_failures_total ${telemetry.authenticationFailures}`,
        `scenelith_collaboration_connections_accepted_total ${telemetry.connectionsAccepted}`,
        `scenelith_collaboration_connections_rejected_total ${telemetry.connectionsRejected}`,
        `scenelith_collaboration_sync_updates_total ${telemetry.syncUpdates}`,
        `scenelith_collaboration_sync_bytes_total ${telemetry.syncBytes}`,
        `scenelith_collaboration_sync_failures_total ${telemetry.syncFailures}`,
        `scenelith_collaboration_document_store_failures_total ${telemetry.documentStoreFailures}`,
        `scenelith_collaboration_projection_failures_total ${telemetry.projectionFailures}`,
        `scenelith_collaboration_database_pool_total ${pool.totalCount}`,
        `scenelith_collaboration_database_pool_idle ${pool.idleCount}`,
        `scenelith_collaboration_database_pool_waiting ${pool.waitingCount}`,
        "",
      ].join("\n"));
      throw null;
    }
    if (!authorizedInternal(request)) {
      json(response, 401, { error: "Unauthorized" });
      throw null;
    }
    if (request.method === "POST" && url.pathname === "/internal/access/revoke") {
      const body = await readJsonBody(request);
      const userId = String(body.userId || "");
      const documentNames = Array.isArray(body.documentNames)
        ? body.documentNames.map(String).filter(Boolean).slice(0, 500)
        : null;
      if (!userId) {
        json(response, 400, { error: "User is required" });
        throw null;
      }
      json(response, 200, { ok: true, closed: revokeLiveAccess(userId, documentNames) });
      throw null;
    }
    if (request.method === "POST" && url.pathname === "/internal/documents/query") {
      const body = await readJsonBody(request);
      const documentNames = Array.isArray(body.documentNames)
        ? body.documentNames.map(String).filter(Boolean).slice(0, 500)
        : [];
      const result = documentNames.length ? await pool.query(
        `SELECT document_name, revision, epoch, state_bytes, update_bytes_since_checkpoint, summary, updated_at
         FROM collaboration_documents WHERE document_name = ANY($1::text[])`,
        [documentNames],
      ) : { rows: [] };
      json(response, 200, { documents: result.rows.map((row) => ({
        projectId: row.document_name,
        revision: Number(row.revision),
        epoch: Number(row.epoch || 1),
        stateBytes: Number(row.state_bytes || 0),
        journalBytes: Number(row.update_bytes_since_checkpoint || 0),
        summary: row.summary,
        updatedAt: row.updated_at,
      })) });
      throw null;
    }
    const compactMatch = url.pathname.match(/^\/internal\/documents\/([^/]+)\/compact$/);
    if (compactMatch) {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed" });
        throw null;
      }
      const documentName = decodeURIComponent(compactMatch[1]);
      try {
        const result = await compactCollaborationDocument(documentName);
        json(response, 200, { ok: true, ...result });
      } catch (error) {
        json(response, 409, { error: error instanceof Error ? error.message : "Canvas checkpoint failed" });
      }
      throw null;
    }
    const projectionMatch = url.pathname.match(/^\/internal\/documents\/([^/]+)\/projection$/);
    if (projectionMatch) {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed" });
        throw null;
      }
      const documentName = decodeURIComponent(projectionMatch[1]);
      let stored = await pool.query(
        "SELECT state, graph, revision, updated_at FROM collaboration_documents WHERE document_name = $1",
        [documentName],
      );
      if (!stored.rowCount) {
        await loadDocumentState(documentName);
        stored = await pool.query(
          "SELECT state, graph, revision, updated_at FROM collaboration_documents WHERE document_name = $1",
          [documentName],
        );
      }
      const row = stored.rows[0];
      json(response, 200, {
        graph: row.graph,
        revision: Math.max(1, Number(row.revision || 1)),
        stateVector: Buffer.from(Y.encodeStateVectorFromUpdate(new Uint8Array(row.state))).toString("base64url"),
        updatedAt: row.updated_at,
      });
      throw null;
    }
    const match = url.pathname.match(/^\/internal\/documents\/([^/]+)$/);
    if (!match) {
      json(response, 404, { error: "Not found" });
      throw null;
    }
    const documentName = decodeURIComponent(match[1]);
    if (request.method === "DELETE") {
      closeDocumentConnections(documentName, "Canvas was deleted");
      if (redisHealth) {
        await redisHealth.publish(collaborationControlChannel, JSON.stringify({ type: "close-document", documentName }));
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [documentName]);
        await client.query(
          `INSERT INTO collaboration_document_tombstones (document_name, reason)
           VALUES ($1, 'project-deleted') ON CONFLICT (document_name) DO NOTHING`,
          [documentName],
        );
        await client.query("DELETE FROM collaboration_projection_outbox WHERE document_name = $1", [documentName]);
        await client.query("DELETE FROM collaboration_document_updates WHERE document_name = $1", [documentName]);
        await client.query("DELETE FROM collaboration_document_versions WHERE document_name = $1", [documentName]);
        await client.query("DELETE FROM collaboration_documents WHERE document_name = $1", [documentName]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      json(response, 200, { ok: true });
      throw null;
    }
    const connection = await instance.openDirectConnection(documentName, { userId: "internal-service" });
    try {
      if (request.method === "GET") {
        const row = await pool.query(
          "SELECT revision, updated_at FROM collaboration_documents WHERE document_name = $1",
          [documentName],
        );
        json(response, 200, {
          graph: readGraph(connection.document),
          revision: Math.max(1, Number(row.rows[0]?.revision || 1)),
          stateVector: Buffer.from(Y.encodeStateVector(connection.document)).toString("base64url"),
          updatedAt: row.rows[0]?.updated_at || new Date().toISOString(),
        });
        throw null;
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request);
        const current = await pool.query(
          "SELECT revision FROM collaboration_documents WHERE document_name = $1",
          [documentName],
        );
        const revision = Math.max(1, Number(current.rows[0]?.revision || 1));
        const stateVector = Buffer.from(Y.encodeStateVector(connection.document)).toString("base64url");
        if (Number(body.expectedRevision) !== revision || body.expectedStateVector !== stateVector) {
          json(response, 409, { error: "Canvas changed", revision, stateVector, graph: readGraph(connection.document) });
          throw null;
        }
        await connection.transact((document) => writeGraph(document, body.graph, "internal-command"));
        await connection.disconnect({ unloadImmediately: true });
        const stored = await pool.query(
          "SELECT graph, revision, updated_at FROM collaboration_documents WHERE document_name = $1",
          [documentName],
        );
        json(response, 200, { graph: stored.rows[0].graph, revision: Number(stored.rows[0].revision), updatedAt: stored.rows[0].updated_at });
        throw null;
      }
      json(response, 405, { error: "Method not allowed" });
      throw null;
    } finally {
      if (connection.document) await connection.disconnect({ unloadImmediately: request.method !== "GET" });
    }
    throw null;
  },
});

await server.listen();
// Hydrate older documents through the normal live-document path. This updates
// the Yjs state, journal, revisions and projection without bypassing live peers.
async function backfillCanvasNodeNumbers() {
  let cursor = "";
  let count = 0;
  for (;;) {
    const batch = await pool.query(`SELECT document_name FROM collaboration_documents
      WHERE document_name > $1 AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(graph->'nodes') node
        WHERE NOT (node->'data' ? 'nodeNumber')
      ) ORDER BY document_name LIMIT 50`, [cursor]);
    if (!batch.rowCount) {
      operationalLog("info", "canvas_node_number_backfill_complete", { count });
      return;
    }
    for (const row of batch.rows) {
      cursor = row.document_name;
      const connection = await server.hocuspocus.openDirectConnection(cursor, { userId: "node-number-backfill" });
      await connection.disconnect({ unloadImmediately: true });
      count++;
    }
  }
}
void backfillCanvasNodeNumbers().catch((error) => operationalLog("error", "canvas_node_number_backfill_failed", { error: error instanceof Error ? error.message : String(error) }));
const mirrorInterval = setInterval(() => void flushMirrorOutbox(), 2_000);
mirrorInterval.unref();
const historyPruneInterval = setInterval(() => void pruneCollaborationHistory(), 60 * 60 * 1000);
historyPruneInterval.unref();
void flushMirrorOutbox();
void pruneCollaborationHistory();
console.log(`Collaboration service listening on ${server.URL}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Collaboration service shutting down (${signal})`);
  clearInterval(mirrorInterval);
  clearInterval(historyPruneInterval);
  for (const key of tokenRefreshIntervals.keys()) clearTokenRefresh(key);
  await server.destroy().catch((error) => console.error("Collaboration server shutdown failed", error));
  if (redisHealth) await redisHealth.quit().catch(() => undefined);
  if (redisControl) await redisControl.quit().catch(() => undefined);
  await pool.end();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}
