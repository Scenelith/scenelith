import { randomUUID } from "node:crypto";
import { db } from "../postgres-db";
import { canvasReadSet, canvasValueRevision, type CanvasReadSet } from "./canvas-concurrency";
import type { ProjectGraph } from "../types";
import type { McpPrincipal } from "./oauth";

// Durable across app instances/restarts; graph values and credentials are never stored.
// Expiry bounds stale context, while a connection's newest 128 reads bound storage.
export async function issueCanvasReadReceipt(principal: McpPrincipal, readSet: CanvasReadSet) {
  const fingerprint = canvasValueRevision(readSet);
  const row = await db.prepare(`INSERT INTO mcp_canvas_reads
    (id, connection_id, user_id, project_id, fingerprint, read_set, expires_at)
    VALUES (?, ?, ?, ?, ?, ?::jsonb, now() + interval '24 hours')
    ON CONFLICT (connection_id, user_id, fingerprint) DO UPDATE SET expires_at = excluded.expires_at
    RETURNING id`).get(randomUUID(), principal.connectionId, principal.userId, readSet.canvasId, fingerprint, JSON.stringify(readSet)) as { id: string };
  await db.prepare("DELETE FROM mcp_canvas_reads WHERE id IN (SELECT id FROM mcp_canvas_reads WHERE expires_at <= now() LIMIT 1000)").run();
  await db.prepare(`DELETE FROM mcp_canvas_reads WHERE connection_id = ? AND user_id = ? AND id NOT IN (
    SELECT id FROM mcp_canvas_reads WHERE connection_id = ? AND user_id = ? ORDER BY expires_at DESC, id LIMIT 128
  )`).run(principal.connectionId, principal.userId, principal.connectionId, principal.userId);
  return `cr1_${row.id}`;
}

export async function resolveCanvasReadReceipt(principal: McpPrincipal, token?: string): Promise<CanvasReadSet | undefined> {
  if (!token) return undefined;
  const row = await db.prepare(`SELECT read_set FROM mcp_canvas_reads
    WHERE id = ? AND connection_id = ? AND user_id = ? AND expires_at > now()`)
    .get(token.slice(4), principal.connectionId, principal.userId) as { read_set: CanvasReadSet | string } | undefined;
  if (!row) throw Object.assign(new Error("This read_set expired or belongs to another connection. Use get_canvas_nodes to refresh only the nodes involved in this action."), { code: "CANVAS_READ_SET_EXPIRED", status: 409 });
  const readSet = typeof row.read_set === "string" ? JSON.parse(row.read_set) as CanvasReadSet : row.read_set;
  // Never accept internal dependency annotations from a client or an earlier action.
  return { ...readSet, requiredNodeIds: undefined, requiredFields: undefined };
}

/** Only tool response envelopes carry proofs. Never walk user node data or documents. */
export async function withCanvasReadReceipts(principal: McpPrincipal, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = { ...value };
  if (result.readSet && typeof result.readSet === "object") result.readSet = await issueCanvasReadReceipt(principal, result.readSet as CanvasReadSet);
  for (const key of ["canvas", "result"]) {
    const nested = result[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) result[key] = await withCanvasReadReceipts(principal, nested as Record<string, unknown>);
  }
  return result;
}


/** Scoped writes return their changed nodes and inputs, not the whole Canvas. */
export function compactCanvasWriteResult(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  for (const key of ["canvas", "result"]) {
    const nested = result[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) result[key] = compactCanvasWriteResult(nested as Record<string, unknown>);
  }
  const changes = result.changes as { nodeIds: string[]; removedNodeIds: string[]; edgeIds: string[]; removedEdgeIds: string[] } | undefined;
  const graph = result.graph as ProjectGraph | undefined;
  if (!changes || !graph || typeof result.id !== "string" || typeof result.revision !== "number") return result;
  const ids = new Set(changes.nodeIds);
  const edges = graph.edges.filter(edge => ids.has(edge.source) || ids.has(edge.target) || changes.edgeIds.includes(edge.id));
  const inputIds = new Set(edges.filter(edge => ids.has(edge.target)).map(edge => edge.source));
  const selected = new Set([...ids, ...inputIds]);
  return { ...result, partial: true, inputNodeIds: [...inputIds].filter(id => !ids.has(id)),
    graph: { ...graph, nodes: graph.nodes.filter(node => selected.has(node.id)), edges },
    nodeDirectory: (result.nodeDirectory as Array<{nodeId:string}>).filter(node => selected.has(node.nodeId)),
    videoMasterScenes: (result.videoMasterScenes as Array<{nodeId:string}>).filter(scene => ids.has(scene.nodeId)),
    readSet: canvasReadSet(result.id, result.revision, graph, [...selected], [...ids]),
  };
}
