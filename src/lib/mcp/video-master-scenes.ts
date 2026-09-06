import { createHash } from "node:crypto";
import { generatorSourceAssetIds } from "../canvas-graph";
import type { ProjectGraph } from "../types";

/** Generation inputs only: playback, layout, history and prepared derivatives are not edits. */
export function videoMasterSceneRevision(graph: ProjectGraph, nodeId: string, clipId: string) {
  const node = graph.nodes.find((item) => item.id === nodeId && item.data.kind === "videoMaster");
  const clip = node?.data.videoMasterClips?.find((item) => item.id === clipId);
  if (!node || !clip) throw Object.assign(new Error("Video Master scene not found"), { status: 404 });
  const source = graph.nodes.find((item) => item.id === clip.sourceNodeId);
  const segment = source?.data.videoSegments?.find((item) => item.id === clip.sourceSegmentId);
  const inputs = graph.edges.filter((edge) => edge.target === nodeId && (edge.data?.masterClipId === clipId || String(edge.targetHandle || "").startsWith(`master:${clipId}:`)) && edge.data?.portType !== "text").map((edge) => {
    const reference = graph.nodes.find((item) => item.id === edge.source);
    const scene = reference?.data.videoSegments?.find((item) => item.id === edge.data?.sourceSegmentId);
    return { source: edge.source, role: edge.data?.inputRole, port: edge.data?.portType, handle: edge.targetHandle,
      title: scene?.label || edge.data?.sourceSegmentLabel || reference?.data.title,
      assets: scene ? [reference?.data.assetId || reference?.data.videoSourceAssetId || reference?.data.outputUrl || reference?.data.imageUrl] : reference ? generatorSourceAssetIds(reference) : [],
      segmentId: edge.data?.sourceSegmentId, start: scene?.start, end: scene?.end,
      duration: scene ? scene.end - scene.start : reference?.data.videoDurationSeconds || reference?.data.duration };
  });
  const state = { nodeId, clipId, title: clip.title, origin: clip.origin, prompt: clip.prompt || node.data.prompt,
    modelId: clip.modelId || node.data.modelId, duration: clip.duration, generationDuration: clip.generationDuration,
    aspectRatio: clip.aspectRatio || node.data.aspectRatio, aspectRatioMode: clip.aspectRatioMode, sourceAspectRatio: clip.sourceAspectRatio || node.data.videoAspectRatio,
    resolution: clip.resolution || node.data.resolution, generateAudio: clip.generateAudio ?? node.data.generateAudio,
    references: clip.attachedReferences?.map(({ assetId, role, title, durationSeconds }) => ({ assetId, role, title, durationSeconds })),
    sourceNodeId: clip.sourceNodeId, sourceSegmentId: clip.sourceSegmentId, sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd,
    sourceAssetId: source?.data.assetId || source?.data.videoSourceAssetId || source?.data.outputUrl || source?.data.imageUrl || clip.sourceAssetId, sourceUrl: clip.sourceUrl,
    segment: segment ? { start: segment.start, end: segment.end } : null, inputs };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export function videoMasterSceneDirectory(graph: ProjectGraph) {
  return graph.nodes.filter((node) => node.data.kind === "videoMaster").flatMap((node) => (node.data.videoMasterClips || []).map((clip, index) => ({
    nodeId: node.id, clipId: clip.id, number: index + 1, title: clip.title,
    sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, modelId: clip.modelId,
    generationRevision: videoMasterSceneRevision(graph, node.id, clip.id),
  })));
}
