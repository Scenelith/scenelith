import type { FrameEdge, FrameNode, FramePortType, GeneratorInputRole, ProjectGraph } from "./types";

const generatorInputRoles = new Set<GeneratorInputRole>([
  "reference-image",
  "start-frame",
  "end-frame",
  "motion-video",
  "reference-video",
  "reference-audio",
]);

type GeneratorInputCapacityModel = {
  mediaType?: "image" | "video";
  maxReferences?: number;
  inputPorts?: Array<{ id: string; max?: number }>;
};

export function generatorInputCapacity(
  model: GeneratorInputCapacityModel | undefined,
  role: GeneratorInputRole | undefined,
) {
  const explicitPort = model?.inputPorts?.find((port) => port.id === role);
  if (explicitPort) return Math.max(0, Math.floor(Number(explicitPort.max ?? 1)));

  // Image generators expose one synthetic reference-image port in the node UI.
  // Their capacity lives on maxReferences rather than inputPorts, so treating a
  // missing explicit port as max=1 silently disconnects the previous reference.
  if (role === "reference-image" && model?.mediaType === "image") {
    return Math.max(0, Math.floor(Number(model.maxReferences ?? 0)));
  }

  return 1;
}

/**
 * Resolve the media a connected canvas node actually exposes to a generator.
 * Generated nodes keep referenceAssetIds as provenance for their own output;
 * forwarding that hidden provenance would make one visible connection expand
 * into many unrelated inputs. Persona nodes are the deliberate exception:
 * one persona card can represent several explicitly selected identity images.
 */
export function generatorSourceAssetIds(node: Pick<FrameNode, "data">) {
  const ids = node.data.kind === "persona" && node.data.referenceAssetIds?.length
    ? node.data.referenceAssetIds
    : node.data.assetId ? [node.data.assetId] : [];
  return ids.filter((assetId, index) => Boolean(assetId) && ids.indexOf(assetId) === index);
}

function edgePortType(edge: FrameEdge, sourceNode?: FrameNode): FramePortType {
  if (edge.sourceHandle === "text-output" || edge.targetHandle === "text-input" || edge.data?.portType === "text") return "text";
  if (edge.sourceHandle === "video-output" || edge.data?.portType === "video" || sourceNode?.data.mediaType === "video") return "video";
  if (edge.sourceHandle === "audio-output" || edge.data?.portType === "audio") return "audio";
  return "image";
}

function canonicalSourceHandle(sourceNode: FrameNode | undefined, portType: FramePortType, sourceHandle?: string | null) {
  if (sourceHandle?.startsWith("segment-output:")) return sourceHandle;
  if (portType === "video" && sourceNode?.data.videoSegments?.length) return "video-output";
  // Visual outputs deliberately use one stable topology handle. The media type
  // belongs to edge data; changing a generator model must not orphan its SVG edge.
  if (portType === "text" || sourceNode?.data.kind === "assistant") return "text-output";
  return "output";
}

function generatorInputRole(edge: FrameEdge): GeneratorInputRole {
  const rawRole = String(edge.data?.inputRole || edge.targetHandle?.replace(/-input$/, "") || "reference-image");
  if (rawRole === "image" || rawRole === "input") return "reference-image";
  return generatorInputRoles.has(rawRole as GeneratorInputRole) ? rawRole as GeneratorInputRole : "reference-image";
}

function normalizedEdgeKey(edge: FrameEdge) {
  return [edge.source, edge.sourceHandle || "", edge.target, edge.targetHandle || ""].join("\u0000");
}

function mergeEdgeClassNames(left: string | undefined, right: string | undefined) {
  return Array.from(new Set(`${left || ""} ${right || ""}`.split(/\s+/).filter(Boolean))).join(" ");
}

function dedupeNormalizedEdges(edges: FrameEdge[]) {
  const byKey = new Map<string, FrameEdge>();
  for (const edge of edges) {
    const key = normalizedEdgeKey(edge);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, edge);
      continue;
    }
    byKey.set(key, {
      ...existing,
      animated: existing.animated || edge.animated,
      className: mergeEdgeClassNames(existing.className, edge.className),
      data: { ...existing.data, ...edge.data },
    });
  }
  return Array.from(byKey.values());
}

export function stableGraphNodes(graphNodes: FrameNode[]): FrameNode[] {
  return graphNodes.map((node) => {
    const {
      measured: _measured,
      selected: _selected,
      dragging: _dragging,
      resizing: _resizing,
      ...stableNode
    } = node;
    return stableNode as FrameNode;
  });
}

export function stableGraphEdges(graphEdges: FrameEdge[]): FrameEdge[] {
  return graphEdges.map((edge) => {
    const {
      selected: _selected,
      ...stableEdge
    } = edge;
    return stableEdge as FrameEdge;
  });
}

/**
 * Apply one exclusive canvas selection as a graph transaction.
 *
 * React Flow selection is view state and is stripped by `stableGraphNodes`
 * before persistence, but it still has to change atomically in the live graph.
 * Importing or creating a media editor without transferring this selection
 * leaves the previous node holding the paused media lease until another render
 * or a full hydration repairs it.
 */
export function selectGraphNode(graphNodes: FrameNode[], nodeId: string): FrameNode[] {
  if (!graphNodes.some((node) => node.id === nodeId)) return graphNodes;
  return graphNodes.map((node) => {
    const selected = node.id === nodeId;
    return node.selected === selected ? node : { ...node, selected };
  });
}

export function duplicateGraphSelection(
  graphNodes: FrameNode[],
  graphEdges: FrameEdge[],
  selectedNodeIds: string[],
  createId: (prefix: string) => string,
  offset = { x: 48, y: 48 },
): { nodes: FrameNode[]; edges: FrameEdge[]; firstNodeId: string | null } {
  const selectedIds = new Set(selectedNodeIds);
  const selectedNodes = graphNodes.filter((node) => selectedIds.has(node.id));
  if (!selectedNodes.length) return { nodes: [], edges: [], firstNodeId: null };

  const idMap = new Map(selectedNodes.map((node) => [node.id, createId(node.data.kind)]));
  const nodes = selectedNodes.map((node) => {
    const data = structuredClone(node.data);
    // A manual duplicate is a standalone canvas node. It must not inherit
    // automation lineage, otherwise graph hydration can reconnect it later.
    delete data.automationKind;
    delete data.automationSourceNodeId;
    delete data.automationSlideIndex;
    data.createdAt = new Date().toISOString();
    const stableNode = stableGraphNodes([node])[0];
    return {
      ...structuredClone(stableNode),
      id: idMap.get(node.id)!,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
      selected: true,
      data,
    } as FrameNode;
  });
  const edges = graphEdges
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .map((edge) => ({
      ...structuredClone(edge),
      id: createId("edge"),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
      selected: false,
    } as FrameEdge));

  return { nodes, edges, firstNodeId: nodes[0]?.id || null };
}

export function normalizeEdgePorts(edges: FrameEdge[], graphNodes: FrameNode[]): FrameEdge[] {
  const nodeById = new Map(graphNodes.map((node) => [node.id, node]));
  const normalized = dedupeNormalizedEdges(edges
    .filter((edge) => {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return false;
      // Video Master references are clip-local and connect to the selected
      // model's semantic ports. Older graphs also stored a second generic
      // edge, which no longer has a UI handle and rendered into empty space.
      return !(nodeById.get(edge.target)?.data.kind === "videoMaster" && edge.targetHandle === "video-master-input");
    })
    .map((edge) => {
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      const targetKind = targetNode?.data.kind;
      const automationKind = targetNode?.data.automationKind === "tiktok-slideshow" ? "tiktok-slideshow" as const : edge.data?.automationKind;
      const automationSourceNodeId = String(targetNode?.data.automationSourceNodeId || edge.data?.automationSourceNodeId || "") || undefined;
      const automationSlideIndex = Number(targetNode?.data.automationSlideIndex || edge.data?.automationSlideIndex || 0) || undefined;
      const portType = edgePortType(edge, sourceNode);
      const isText = portType === "text";
      const inputRole = generatorInputRole(edge);
      const semanticTargetHandle = `${inputRole}-input`;
      const classNames = new Set(String(edge.className || "").split(/\s+/).filter(Boolean));
      if (automationKind) classNames.add("is-automation-lineage-edge");
      return {
        ...edge,
        sourceHandle: canonicalSourceHandle(sourceNode, portType, edge.sourceHandle),
        targetHandle: isText ? "text-input" : targetKind === "prompt" ? semanticTargetHandle : edge.targetHandle || "input",
        className: Array.from(classNames).join(" "),
        data: {
          ...edge.data,
          portType,
          ...(!isText && targetKind === "prompt" ? { inputRole } : {}),
          ...(automationKind ? { automationKind, automationSourceNodeId, automationSlideIndex } : {}),
        },
      };
    }));

  // Automation nodes retain enough lineage metadata to reconstruct their
  // source connection. This repairs older/racy saves without inventing links
  // for ordinary user-created nodes.
  const sourceScenes = new Map<string, FrameNode[]>();
  for (const sourceNode of graphNodes.filter((node) => node.data.kind === "source")) {
    const scenes = normalized
      .filter((edge) => edge.source === sourceNode.id && nodeById.get(edge.target)?.data.kind === "scene")
      .map((edge) => nodeById.get(edge.target)!)
      .sort((left, right) => {
        const leftIndex = Number(String(left.data.title || "").match(/\d+/)?.[0] || 0);
        const rightIndex = Number(String(right.data.title || "").match(/\d+/)?.[0] || 0);
        return leftIndex - rightIndex || left.position.x - right.position.x;
      });
    if (scenes.length) sourceScenes.set(sourceNode.id, scenes);
  }

  for (const targetNode of graphNodes) {
    if (targetNode.data.automationKind !== "tiktok-slideshow") continue;
    const automationSourceNodeId = String(targetNode.data.automationSourceNodeId || "");
    const automationSlideIndex = Number(targetNode.data.automationSlideIndex || 0);
    const sourceScene = sourceScenes.get(automationSourceNodeId)?.[automationSlideIndex - 1];
    if (!sourceScene || normalized.some((edge) => edge.source === sourceScene.id && edge.target === targetNode.id)) continue;
    normalized.push({
      id: `automation-lineage-${sourceScene.id}-${targetNode.id}`,
      source: sourceScene.id,
      sourceHandle: "output",
      target: targetNode.id,
      targetHandle: "reference-image-input",
      animated: true,
      className: "is-automation-lineage-edge",
      data: {
        portType: "image",
        inputRole: "reference-image",
        automationKind: "tiktok-slideshow",
        automationSourceNodeId,
        automationSlideIndex,
      },
    });
  }
  return dedupeNormalizedEdges(normalized);
}

export function normalizeProjectGraph(graph: ProjectGraph): ProjectGraph {
  const nodes = stableGraphNodes(graph.nodes || []);
  return {
    ...graph,
    nodes,
    edges: normalizeEdgePorts(graph.edges || [], nodes),
  };
}

export function upsertGraphEdge(
  edges: FrameEdge[],
  graphNodes: FrameNode[],
  edge: FrameEdge,
  options: { replaceTargetInput?: boolean } = {},
) {
  const current = normalizeEdgePorts(edges, graphNodes);
  const candidate = normalizeEdgePorts([edge], graphNodes)[0];
  if (!candidate) return current;
  const withoutConflict = current.filter((existing) => {
    if (normalizedEdgeKey(existing) === normalizedEdgeKey(candidate)) return false;
    return !(options.replaceTargetInput && existing.target === candidate.target && existing.targetHandle === candidate.targetHandle);
  });
  return normalizeEdgePorts([...withoutConflict, candidate], graphNodes);
}
