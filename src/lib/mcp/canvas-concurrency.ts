import { createHash } from "node:crypto";
import type { FrameNode, ProjectGraph } from "../types";
import type { CanvasPatchOperation } from "./service";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function canvasValueRevision(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
}

// Presentation and execution progress do not change the creative instruction.
// Field-level writes still compare these fields when explicitly changing them.
const presentationFields = new Set(["nodeNumber", "nodeWidth", "nodeHeight", "status", "queueReason", "generationError", "generatedOutputs", "activeGeneratedOutputIndex", "videoMasterGeneratingClipId"]);
function nodeContent(node: FrameNode) {
  return { type: node.type, data: Object.fromEntries(Object.entries(node.data).filter(([key]) => !presentationFields.has(key))) };
}
const referenceFields = ["title", "kind", "mediaType", "assetId", "imageUrl", "outputUrl", "referenceAssetIds", "personaId", "personaVariant", "assistantOutput", "noteText", "videoSourceAssetId", "videoSourceNodeId", "videoSegmentId", "videoClipStart", "videoClipEnd", "videoOutputSelection", "videoSegments", "videoMasterClips", "videoMasterSelectedClipId", "duration", "videoDurationSeconds"];
function inputContent(graph: ProjectGraph, nodeId: string) {
  return graph.edges.filter(edge => edge.target === nodeId).map(edge => {
    const source = graph.nodes.find(node => node.id === edge.source);
    return { edge: { id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle, data: edge.data }, source: source ? Object.fromEntries(referenceFields.map(key => [key, source.data[key as keyof typeof source.data]])) : null };
  });
}
export function canvasNodeSemanticRevision(graph: ProjectGraph, nodeId: string) {
  const node = graph.nodes.find(node => node.id === nodeId);
  return canvasValueRevision(node ? { content: nodeContent(node), inputs: inputContent(graph, nodeId) } : null);
}

export type CanvasReadSet = {
  canvasId: string;
  revision: number;
  nodes: Record<string, { inputsRead: boolean; kind: string; content: string; inputs: string; position: string; fields: Record<string, string>; incident: string }>;
  edges: Record<string, string>;
  viewport: string;
  // Populated by semantic services, never trusted as a substitute for their checks.
  requiredNodeIds?: string[];
  requiredFields?: Record<string, string[]>;
};
export function canvasReadSet(canvasId: string, revision: number, graph: ProjectGraph, nodeIds?: string[], fullyReadNodeIds?: string[]): CanvasReadSet {
  const selected = nodeIds ? new Set(nodeIds) : null;
  const fullyRead = fullyReadNodeIds ? new Set(fullyReadNodeIds) : null;
  return {
    canvasId, revision,
    nodes: Object.fromEntries(graph.nodes.filter(node => !selected || selected.has(node.id)).map(node => [node.id, {
      inputsRead: !fullyRead || fullyRead.has(node.id),
      kind: canvasValueRevision({ type: node.type, kind: node.data.kind }),
      content: canvasNodeSemanticRevision(graph, node.id), inputs: canvasValueRevision(inputContent(graph, node.id)),
      position: canvasValueRevision(node.position), fields: Object.fromEntries(Object.entries(node.data).map(([key, value]) => [key, canvasValueRevision(value)])),
      incident: canvasValueRevision(graph.edges.filter(edge => edge.source === node.id || edge.target === node.id)),
    }])),
    edges: Object.fromEntries(graph.edges.filter(edge => !selected || selected.has(edge.source) || selected.has(edge.target)).map(edge => [edge.id, canvasValueRevision(edge)])),
    viewport: canvasValueRevision(graph.viewport),
  };
}
export type CanvasConflict = { nodeId?: string; edgeId?: string; fields: string[]; reason: string };
export function canvasConflict(revision: number, conflicts: CanvasConflict[]) {
  return Object.assign(new Error("The requested Canvas fields or inputs changed. Refresh only refreshNodeIds with get_canvas_nodes and reconsider the action."), {
    status: 409, code: "CANVAS_REVISION_CONFLICT", currentRevision: revision, conflicts,
    refreshNodeIds: [...new Set(conflicts.flatMap(conflict => conflict.nodeId ? [conflict.nodeId] : []))],
  });
}
function validateScope(canvasId: string, readSet: CanvasReadSet) {
  if (readSet.canvasId !== canvasId) throw Object.assign(new Error("read_set belongs to another canvas"), { status: 400, code: "INVALID_CANVAS_READ_SET" });
}

export function assertCanvasFields(canvas: { id: string; revision: number; graph: ProjectGraph }, readSet: CanvasReadSet, fields: Record<string, string[]>) {
  validateScope(canvas.id, readSet);
  const live = canvasReadSet(canvas.id, canvas.revision, canvas.graph, Object.keys(fields));
  const conflicts = Object.entries(fields).flatMap(([nodeId, keys]) => {
    const before = readSet.nodes[nodeId], after = live.nodes[nodeId];
    const changed = keys.filter(key => !before || !after || (key === "inputs" ? !before.inputsRead || before.inputs !== after.inputs : (before.fields[key] || canvasValueRevision(undefined)) !== (after.fields[key] || canvasValueRevision(undefined))));
    return changed.length ? [{ nodeId, fields: changed, reason: "Fields used to validate this action changed" }] : [];
  });
  if (conflicts.length) throw canvasConflict(canvas.revision, conflicts);
}

/** Semantic actions depend on their target/source content and actual incoming media, not layout. */
export function assertCanvasRead(canvas: { id: string; revision: number; graph: ProjectGraph }, input: {
  expectedRevision: number; readSet?: CanvasReadSet; nodeId?: string; sourceNodeId?: string; targetNodeId?: string; nodeIds?: string[];
}, fieldsOnly = false): CanvasReadSet {
  if (!input.readSet && canvas.revision !== input.expectedRevision) throw canvasConflict(canvas.revision, [{ fields: ["revision"], reason: "Legacy request requires the current revision; use read_set for concurrent work" }]);
  const readSet = input.readSet || canvasReadSet(canvas.id, canvas.revision, canvas.graph);
  validateScope(canvas.id, readSet);
  const ids = [...new Set([input.nodeId, input.sourceNodeId, input.targetNodeId, ...(input.nodeIds || [])].filter((id): id is string => Boolean(id)))];
  const conflicts: CanvasConflict[] = [];
  for (const nodeId of ids) {
    const node = canvas.graph.nodes.find(node => node.id === nodeId);
    if (!node || !readSet.nodes[nodeId]) conflicts.push({ nodeId, fields: ["node"], reason: node ? "Node was not read" : "Node was deleted" });
    else if (!fieldsOnly && !readSet.nodes[nodeId].inputsRead) conflicts.push({ nodeId, fields: ["inputs"], reason: "This node was only an input preview. Read its own inputs with get_canvas_nodes before acting" });
    else if (!fieldsOnly && readSet.nodes[nodeId].content !== canvasNodeSemanticRevision(canvas.graph, nodeId)) {
      const fields = [...new Set([...Object.keys(readSet.nodes[nodeId].fields), ...Object.keys(node.data)])].filter(key => !presentationFields.has(key) && (readSet.nodes[nodeId].fields[key] || canvasValueRevision(undefined)) !== canvasValueRevision(node.data[key as keyof typeof node.data]));
      if (readSet.nodes[nodeId].inputs !== canvasValueRevision(inputContent(canvas.graph, nodeId))) fields.push("inputs");
      conflicts.push({ nodeId, fields, reason: "Node content or connected inputs changed" });
    }
  }
  if (conflicts.length) throw canvasConflict(canvas.revision, conflicts);
  return { ...readSet, requiredNodeIds: fieldsOnly ? [] : ids };
}

/** Check only fields a patch writes. Apply it to the latest graph after this check. */
export function assertCanvasPatchRead(canvasId: string, revision: number, graph: ProjectGraph, readSet: CanvasReadSet, operations: CanvasPatchOperation[]) {
  validateScope(canvasId, readSet);
  if (readSet.requiredNodeIds?.length) assertCanvasRead({ id: canvasId, revision, graph }, { expectedRevision: revision, readSet, nodeIds: readSet.requiredNodeIds });
  if (readSet.requiredFields) assertCanvasFields({ id: canvasId, revision, graph }, readSet, readSet.requiredFields);
  const live = canvasReadSet(canvasId, revision, graph);
  const conflicts: CanvasConflict[] = [];
  const added = new Set(operations.filter(op => op.type === "add_node").map(op => op.id).filter(Boolean));
  const checkNode = (nodeId: string) => {
    if (added.has(nodeId) && !live.nodes[nodeId]) return true;
    if (!readSet.nodes[nodeId] || !live.nodes[nodeId] || readSet.nodes[nodeId].kind !== live.nodes[nodeId].kind) {
      conflicts.push({ nodeId, fields: ["node"], reason: !live.nodes[nodeId] ? "Node was deleted" : "Node was not read or changed type" }); return false;
    }
    return true;
  };
  for (const op of operations) {
    if (op.type === "update_node" || op.type === "remove_node") {
      if (!checkNode(op.nodeId) || added.has(op.nodeId)) continue;
      const before = readSet.nodes[op.nodeId], after = live.nodes[op.nodeId];
      const fields = op.type === "remove_node"
        ? [...(!before.inputsRead ? ["inputs"] : []), ...(["content", "position", "incident"] as const).filter(key => before[key] !== after[key]), ...Object.keys({ ...before.fields, ...after.fields }).filter(key => before.fields[key] !== after.fields[key]).map(key => `data.${key}`)]
        : [...Object.keys(op.data || {}).filter(key => (before.fields[key] || canvasValueRevision(undefined)) !== (after.fields[key] || canvasValueRevision(undefined))).map(key => `data.${key}`), ...(op.position && before.position !== after.position ? ["position"] : [])];
      if (fields.length) conflicts.push({ nodeId: op.nodeId, fields, reason: "Written fields changed since the read" });
    } else if (op.type === "add_edge") {
      for (const nodeId of [op.source, op.target]) if (checkNode(nodeId) && !added.has(nodeId) && readSet.nodes[nodeId].content !== live.nodes[nodeId].content) conflicts.push({ nodeId, fields: ["inputs"], reason: "Connection endpoint or inputs changed" });
      if (op.id && live.edges[op.id] && !operations.some(other => other.type === "remove_edge" && other.edgeId === op.id)) conflicts.push({ edgeId: op.id, fields: ["edge"], reason: "Edge already exists" });
    } else if (op.type === "remove_edge") {
      const edge = graph.edges.find(edge => edge.id === op.edgeId);
      if (!readSet.edges[op.edgeId] || readSet.edges[op.edgeId] !== live.edges[op.edgeId]) conflicts.push({ edgeId: op.edgeId, nodeId: edge?.target, fields: ["edge"], reason: "Edge changed or was deleted" });
    } else if (op.type === "set_viewport" && readSet.viewport !== live.viewport) conflicts.push({ fields: ["viewport"], reason: "Viewport changed" });
    else if (op.type === "add_node" && op.id && live.nodes[op.id]) conflicts.push({ nodeId: op.id, fields: ["node"], reason: "Node already exists" });
  }
  if (conflicts.length) throw canvasConflict(revision, conflicts);
}

export function canvasPatchChanges(before: ProjectGraph, after: ProjectGraph) {
  const changed = <T extends { id: string }>(old: T[], next: T[]) => {
    const previous = new Map(old.map(item => [item.id, canvasValueRevision(item)]));
    const nextIds = new Set(next.map(item => item.id));
    return { changed: next.filter(item => previous.get(item.id) !== canvasValueRevision(item)).map(item => item.id), removed: old.filter(item => !nextIds.has(item.id)).map(item => item.id) };
  };
  const nodes = changed(before.nodes, after.nodes), edges = changed(before.edges, after.edges);
  const changedEdges = new Set([...edges.changed, ...edges.removed]);
  const survivingNodes = new Set(after.nodes.map(node => node.id));
  const endpoints = [...before.edges, ...after.edges].filter(edge => changedEdges.has(edge.id)).flatMap(edge => [edge.source, edge.target]).filter(id => survivingNodes.has(id));
  return { nodeIds: [...new Set([...nodes.changed, ...endpoints])], removedNodeIds: nodes.removed, edgeIds: edges.changed, removedEdgeIds: edges.removed };
}
