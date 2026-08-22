import * as Y from "yjs";
import type { FrameEdge, FrameNode, ProjectGraph } from "./types";

const LOCAL_ORIGIN = Symbol("frameflow-local-canvas-change");

type GraphEntity = FrameNode | FrameEdge;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fromY(value: unknown): unknown {
  if (value instanceof Y.Map) return Object.fromEntries(Array.from(value.entries(), ([key, item]) => [key, fromY(item)]));
  if (value instanceof Y.Array) return value.toArray().map(fromY);
  return value;
}

function createYValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const array = new Y.Array();
    if (value.length) array.insert(0, value.map(createYValue));
    return array;
  }
  if (isObject(value)) {
    const map = new Y.Map();
    for (const [key, item] of Object.entries(value)) map.set(key, createYValue(item));
    return map;
  }
  return value ?? null;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Apply only the fields that changed in the local UI. The value currently in
 * the Y.Doc is deliberately not used as the comparison baseline: it may
 * already contain a concurrent remote change that must be preserved.
 */
function patchMap(map: Y.Map<unknown>, before: Record<string, unknown>, after: Record<string, unknown>) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const existedBefore = hasOwn(before, key);
    const existsAfter = hasOwn(after, key);
    if (existedBefore && !existsAfter) {
      map.delete(key);
      continue;
    }
    if (!existsAfter || (existedBefore && sameJson(before[key], after[key]))) continue;

    const previous = before[key];
    const next = after[key];
    const current = map.get(key);
    if (isObject(previous) && isObject(next) && current instanceof Y.Map) {
      patchMap(current, previous, next);
      continue;
    }

    // Arrays are a single field in the current graph schema. Replacing only
    // that field still avoids overwriting unrelated node fields. Entity-like
    // arrays can move to keyed Y.Maps in a future schema migration without
    // changing this public mutation API.
    map.set(key, createYValue(next));
  }
}

function patchEntities<T extends GraphEntity>(map: Y.Map<unknown>, before: T[], after: T[]) {
  const beforeById = new Map(before.filter((entity) => Boolean(entity.id)).map((entity) => [entity.id, entity]));
  const afterById = new Map(after.filter((entity) => Boolean(entity.id)).map((entity) => [entity.id, entity]));

  for (const [id] of beforeById) if (!afterById.has(id)) map.delete(id);
  for (const [id, entity] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) {
      map.set(id, createYValue(entity));
      continue;
    }
    if (sameJson(previous, entity)) continue;
    const current = map.get(id);
    if (current instanceof Y.Map) patchMap(current, previous as unknown as Record<string, unknown>, entity as unknown as Record<string, unknown>);
    else map.set(id, createYValue(entity));
  }
}

function reconcileMap(map: Y.Map<unknown>, next: Record<string, unknown>) {
  for (const key of Array.from(map.keys())) if (!(key in next)) map.delete(key);
  for (const [key, value] of Object.entries(next)) {
    const current = map.get(key);
    if (isObject(value) && current instanceof Y.Map) {
      reconcileMap(current, value);
      continue;
    }
    if (Array.isArray(value) && current instanceof Y.Array) {
      if (!sameJson(fromY(current), value)) {
        if (current.length) current.delete(0, current.length);
        if (value.length) current.insert(0, value.map(createYValue));
      }
      continue;
    }
    if (!sameJson(fromY(current), value)) map.set(key, createYValue(value));
  }
}

function reconcileEntities<T extends { id: string }>(map: Y.Map<unknown>, entities: T[]) {
  const ids = new Set(entities.map((entity) => entity.id));
  for (const id of Array.from(map.keys())) if (!ids.has(id)) map.delete(id);
  for (const entity of entities) {
    const current = map.get(entity.id);
    if (current instanceof Y.Map) reconcileMap(current, entity as unknown as Record<string, unknown>);
    else map.set(entity.id, createYValue(entity));
  }
}

export function readGraphFromYDoc(document: Y.Doc): ProjectGraph {
  const nodesMap = document.getMap("nodes");
  const edgesMap = document.getMap("edges");
  const meta = document.getMap("meta");
  const nodeOrder = Array.isArray(meta.get("nodeOrder")) ? meta.get("nodeOrder") as string[] : [];
  const edgeOrder = Array.isArray(meta.get("edgeOrder")) ? meta.get("edgeOrder") as string[] : [];
  const nodesById = new Map(Array.from(nodesMap.entries(), ([id, value]) => [id, fromY(value) as FrameNode]));
  const edgesById = new Map(Array.from(edgesMap.entries(), ([id, value]) => [id, fromY(value) as FrameEdge]));
  const ordered = <T>(values: Map<string, T>, order: string[]) => [
    ...order.map((id) => values.get(id)).filter((value): value is T => Boolean(value)),
    ...Array.from(values.entries()).filter(([id]) => !order.includes(id)).map(([, value]) => value),
  ];
  const viewport = meta.get("initialViewport");
  return {
    nodes: ordered(nodesById, nodeOrder),
    edges: ordered(edgesById, edgeOrder),
    ...(isObject(viewport) ? { viewport: viewport as ProjectGraph["viewport"] } : {}),
  };
}

export function writeGraphToYDoc(document: Y.Doc, graph: ProjectGraph) {
  const nodes = (graph.nodes || []).filter((node) => Boolean(node.id));
  const edges = (graph.edges || []).filter((edge) => Boolean(edge.id));
  document.transact(() => {
    reconcileEntities(document.getMap("nodes"), nodes);
    reconcileEntities(document.getMap("edges"), edges);
    const meta = document.getMap("meta");
    meta.set("schemaVersion", 1);
    meta.set("nodeOrder", nodes.map((node) => node.id));
    meta.set("edgeOrder", edges.map((edge) => edge.id));
  }, LOCAL_ORIGIN);
}

export function patchGraphInYDoc(document: Y.Doc, before: ProjectGraph, after: ProjectGraph) {
  const beforeNodes = (before.nodes || []).filter((node) => Boolean(node.id));
  const afterNodes = (after.nodes || []).filter((node) => Boolean(node.id));
  const beforeEdges = (before.edges || []).filter((edge) => Boolean(edge.id));
  const afterEdges = (after.edges || []).filter((edge) => Boolean(edge.id));
  document.transact(() => {
    patchEntities(document.getMap("nodes"), beforeNodes, afterNodes);
    patchEntities(document.getMap("edges"), beforeEdges, afterEdges);
    const meta = document.getMap("meta");
    meta.set("schemaVersion", 1);
    if (!sameJson(beforeNodes.map((node) => node.id), afterNodes.map((node) => node.id))) meta.set("nodeOrder", afterNodes.map((node) => node.id));
    if (!sameJson(beforeEdges.map((edge) => edge.id), afterEdges.map((edge) => edge.id))) meta.set("edgeOrder", afterEdges.map((edge) => edge.id));
  }, LOCAL_ORIGIN);
}

export function isLocalCanvasOrigin(origin: unknown) {
  return origin === LOCAL_ORIGIN;
}
