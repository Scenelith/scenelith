import type { ProjectGraph } from "./types";
import { normalizeEdgePorts } from "./canvas-graph";
import { resolveVideoMasterSourceTarget } from "./video-master";

type AssetLineage = {
  sourceAssetId?: string;
  segmentId?: string;
};

export function parseAssetLineage(metadataJson: string | null | undefined): AssetLineage {
  try {
    const metadata = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
    return {
      sourceAssetId: typeof metadata.sourceAssetId === "string" ? metadata.sourceAssetId : undefined,
      segmentId: typeof metadata.segmentId === "string" ? metadata.segmentId : undefined,
    };
  } catch {
    return {};
  }
}

export function videoMasterTargetAcceptsAsset(
  graph: ProjectGraph,
  nodeId: string,
  clipId: string,
  candidateAssetId: string,
  candidateMetadataJson?: string | null,
) {
  const target = resolveVideoMasterSourceTarget(graph.nodes, nodeId, clipId);
  if (!target) return false;
  if (!target.sourceSegmentId) return Boolean(target.sourceAssetId && target.sourceAssetId === candidateAssetId);
  const lineage = parseAssetLineage(candidateMetadataJson);
  return Boolean(
    lineage.segmentId === target.sourceSegmentId
    && target.sourceNodeAssetId
    && lineage.sourceAssetId === target.sourceNodeAssetId,
  );
}

export function validateVideoMasterGenerationReferences(input: {
  graph: ProjectGraph;
  nodeId: string;
  clipId: string;
  targetSourceAssetId?: string;
  targetSourceMetadataJson?: string | null;
  referenceAssetIds: string[];
  referenceRoles: string[];
}) {
  const target = resolveVideoMasterSourceTarget(input.graph.nodes, input.nodeId, input.clipId);
  if (!target) return "The selected Video Master scene is no longer available";
  if (!target.sourceAssetId && !target.sourceSegmentId) return undefined;
  if (!input.targetSourceAssetId || !videoMasterTargetAcceptsAsset(input.graph, input.nodeId, input.clipId, input.targetSourceAssetId, input.targetSourceMetadataJson)) {
    return "The generation source does not match the selected Video Master scene";
  }
  const sourceIsConnected = normalizeEdgePorts(input.graph.edges, input.graph.nodes).some((edge) => edge.target === input.nodeId
    && (edge.data?.masterClipId === input.clipId || String(edge.targetHandle || "").startsWith(`master:${input.clipId}:`))
    && (edge.data?.inputRole === "reference-video" || edge.data?.inputRole === "motion-video")
    && edge.source === target.clip.sourceNodeId && edge.data?.sourceSegmentId === target.clip.sourceSegmentId)
    || Boolean(target.clip.attachedReferences?.some((reference) => (reference.role === "reference-video" || reference.role === "motion-video") && reference.assetId === target.sourceAssetId));
  const exactSourceIsSent = input.referenceAssetIds.some((assetId, index) => assetId === input.targetSourceAssetId && ["reference-video", "motion-video"].includes(input.referenceRoles[index]));
  if (sourceIsConnected && !exactSourceIsSent) return "The selected scene video is missing from generation references";
  return undefined;
}
