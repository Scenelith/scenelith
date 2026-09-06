import type { FrameEdge, ProjectGraph } from "./types";

/** The last explicitly connected input chooses the provider's reference mode. */
export function incompatibleReferenceRoles(modelId: string | undefined, role: string | undefined): string[] {
  const frames = ["start-frame", "end-frame"];
  const references = String(modelId).startsWith("seedance-2")
    ? ["reference-image", "reference-video", "reference-audio"]
    : modelId === "wan-2-7" ? ["reference-video"]
      : modelId === "veo-3-1-fast" ? ["reference-image"] : [];
  if (!references.length) return [];
  return frames.includes(role || "") ? references : references.includes(role || "") ? frames : [];
}

function edgeInput(edge: FrameEdge) {
  if (edge.data?.portType === "text") return null;
  const match = edge.targetHandle?.match(/^master:([^:]+):([^:]+)-input$/);
  return { nodeId: edge.target, clipId: edge.data?.masterClipId || match?.[1], role: edge.data?.inputRole || match?.[2] || edge.targetHandle?.replace(/-input$/, "") };
}

type ReferenceChange = { nodeId: string; clipId?: string; role?: string; edgeId?: string; assetId?: string };

export function generatorReferenceChanges(previous: ProjectGraph, next: ProjectGraph): ReferenceChange[] {
  const additions: ReferenceChange[] = [];
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  for (const node of next.nodes) {
    const before = previousNodes.get(node.id);
    if (before?.data === node.data) continue;
    const targets = node.data.kind === "videoMaster"
      ? (node.data.videoMasterClips || []).map((clip) => ({ clipId: clip.id, refs: clip.attachedReferences || [], old: before?.data.videoMasterClips?.find((item) => item.id === clip.id)?.attachedReferences || [] }))
      : [{ clipId: undefined, refs: node.data.attachedReferences || [], old: before?.data.attachedReferences || [] }];
    for (const target of targets) for (const ref of target.refs) {
      if (!target.old.some((old) => old.assetId === ref.assetId && (old.role || "reference-image") === (ref.role || "reference-image"))) additions.push({ nodeId: node.id, clipId: target.clipId, role: ref.role || "reference-image", assetId: ref.assetId });
    }
  }
  for (const edge of next.edges) {
    const input = edgeInput(edge);
    if (!input) continue;
    const before = previousEdges.get(edge.id);
    if (before === edge) continue;
    if (!before || before.source !== edge.source || before.sourceHandle !== edge.sourceHandle || JSON.stringify(edgeInput(before)) !== JSON.stringify(input)) additions.push({ ...input, edgeId: edge.id });
  }
  return additions;
}

/** Reconcile only explicit additions/role changes, never a read or media refresh. */
export function reconcileGeneratorReferenceChanges(previous: ProjectGraph, next: ProjectGraph, changeOrder?: ReferenceChange[]) {
  const additions = generatorReferenceChanges(previous, next);
  if (changeOrder) {
    const key = (change: ReferenceChange) => JSON.stringify([change.nodeId, change.clipId, change.role, change.edgeId, change.assetId]);
    const order = new Map(changeOrder.map((change, index) => [key(change), index]));
    additions.sort((left, right) => (order.get(key(left)) ?? -1) - (order.get(key(right)) ?? -1));
  }
  let nodes = next.nodes;
  let edges = next.edges;
  let disconnected = 0;
  const resolved = new Set<string>();
  for (const input of additions.toReversed()) {
    const node = nodes.find((item) => item.id === input.nodeId);
    if (!node || !["prompt", "videoMaster"].includes(node.data.kind)) continue;
    const clip = input.clipId ? node.data.videoMasterClips?.find((item) => item.id === input.clipId) : undefined;
    const excluded = incompatibleReferenceRoles(clip?.modelId || node.data.modelId, input.role);
    if (!excluded.length) continue;
    const targetKey = `${input.nodeId}:${input.clipId || ""}`;
    if (resolved.has(targetKey)) continue;
    resolved.add(targetKey);
    const keptEdges = edges.filter((edge) => {
      const other = edgeInput(edge);
      return !(other?.nodeId === input.nodeId && other.clipId === input.clipId && excluded.includes(other.role || ""));
    });
    disconnected += edges.length - keptEdges.length;
    edges = keptEdges;
    const refs = clip ? clip.attachedReferences : node.data.attachedReferences;
    const kept = refs?.filter((ref) => !excluded.includes(ref.role || "reference-image"));
    if (refs && kept && kept.length !== refs.length) {
      disconnected += refs.length - kept.length;
      nodes = nodes.map((item) => item.id !== node.id ? item : { ...item, data: { ...item.data,
        ...(clip ? { videoMasterClips: item.data.videoMasterClips?.map((entry) => entry.id === clip.id ? { ...entry, attachedReferences: kept } : entry) } : { attachedReferences: kept }),
      } });
    }
  }
  return { graph: { ...next, nodes, edges }, disconnected };
}
