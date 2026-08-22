import * as Y from "yjs";

const ROOT_NODES = "nodes";
const ROOT_EDGES = "edges";
const ROOT_META = "meta";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fromY(value) {
  if (value instanceof Y.Map) {
    return Object.fromEntries(Array.from(value.entries(), ([key, item]) => [key, fromY(item)]));
  }
  if (value instanceof Y.Array) return value.toArray().map(fromY);
  return value;
}

function createYValue(value) {
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconcileMap(map, next) {
  for (const key of Array.from(map.keys())) {
    if (!(key in next)) map.delete(key);
  }
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

function reconcileEntityMap(entityMap, entities) {
  const ids = new Set(entities.map((entity) => String(entity.id)));
  for (const id of Array.from(entityMap.keys())) {
    if (!ids.has(id)) entityMap.delete(id);
  }
  for (const entity of entities) {
    const id = String(entity.id);
    const current = entityMap.get(id);
    if (current instanceof Y.Map) reconcileMap(current, entity);
    else entityMap.set(id, createYValue(entity));
  }
}

export function readGraph(document) {
  const nodesMap = document.getMap(ROOT_NODES);
  const edgesMap = document.getMap(ROOT_EDGES);
  const meta = document.getMap(ROOT_META);
  const nodeOrder = Array.isArray(meta.get("nodeOrder")) ? meta.get("nodeOrder") : [];
  const edgeOrder = Array.isArray(meta.get("edgeOrder")) ? meta.get("edgeOrder") : [];
  const nodesById = new Map(Array.from(nodesMap.entries(), ([id, value]) => [id, fromY(value)]));
  const edgesById = new Map(Array.from(edgesMap.entries(), ([id, value]) => [id, fromY(value)]));
  const ordered = (values, order) => [
    ...order.map((id) => values.get(id)).filter(Boolean),
    ...Array.from(values.entries()).filter(([id]) => !order.includes(id)).map(([, value]) => value),
  ];
  const viewport = meta.get("initialViewport");
  return {
    nodes: ordered(nodesById, nodeOrder),
    edges: ordered(edgesById, edgeOrder),
    ...(isObject(viewport) ? { viewport } : {}),
  };
}

export function writeGraph(document, graph, origin = "server") {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.filter((node) => node?.id) : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges.filter((edge) => edge?.id) : [];
  document.transact(() => {
    reconcileEntityMap(document.getMap(ROOT_NODES), nodes);
    reconcileEntityMap(document.getMap(ROOT_EDGES), edges);
    const meta = document.getMap(ROOT_META);
    meta.set("schemaVersion", 1);
    meta.set("nodeOrder", nodes.map((node) => String(node.id)));
    meta.set("edgeOrder", edges.map((edge) => String(edge.id)));
    if (isObject(graph?.viewport) && !meta.has("initialViewport")) meta.set("initialViewport", graph.viewport);
  }, origin);
}

export function graphSummary(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return {
    scenes: nodes.filter((node) => node?.data?.kind === "scene").length,
    prompts: nodes.filter((node) => node?.data?.kind === "prompt").length,
    outputs: nodes.filter((node) => node?.data?.kind === "generation" || Boolean(node?.data?.outputUrl)).length,
    previews: nodes
      .filter((node) => node?.data?.kind === "scene" && node?.data?.mediaType !== "video" && node?.data?.imageUrl)
      .slice(0, 3)
      .map((node) => ({ id: String(node.id), imageUrl: String(node.data.imageUrl) })),
  };
}
