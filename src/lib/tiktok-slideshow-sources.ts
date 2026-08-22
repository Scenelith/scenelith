import type { FrameEdge, FrameNode } from "./types";

export type TikTokSlideshowSource = {
  id: string;
  label: string;
  description: string;
  assetIds: string[];
};

function sceneNumber(node: FrameNode) {
  return Number(String(node.data.title || "").match(/\d+/)?.[0] || 0);
}

function isTikTokSource(node: FrameNode) {
  return node.data.kind === "source" && (
    Boolean(node.data.postId)
    || String(node.data.sourceUrl || "").toLowerCase().includes("tiktok.com")
  );
}

function isVideoSource(node: FrameNode) {
  return node.data.tiktokMediaType === "video"
    || node.data.mediaType === "video"
    || Boolean(node.data.videoSegments?.length)
    || Boolean(node.data.videoDurationSeconds);
}

/** Returns only imported TikTok slideshows; detected video scenes never count as slides. */
export function findTikTokSlideshowSources(nodes: FrameNode[], edges: FrameEdge[]): TikTokSlideshowSource[] {
  const outgoingTargets = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targets = outgoingTargets.get(edge.source) || new Set<string>();
    targets.add(edge.target);
    outgoingTargets.set(edge.source, targets);
  }

  return nodes
    .filter(isTikTokSource)
    .filter((source) => source.data.tiktokMediaType !== "video" && !isVideoSource(source))
    .map((source) => {
      const directTargets = outgoingTargets.get(source.id) || new Set<string>();
      const slides = nodes
        .filter((node) => node.data.kind === "scene" && Boolean(node.data.assetId))
        .filter((node) => directTargets.has(node.id) || node.data.tiktokSourceNodeId === source.id)
        .sort((left, right) => sceneNumber(left) - sceneNumber(right) || left.position.x - right.position.x);
      const explicitSlideshow = source.data.tiktokMediaType === "slideshow";
      const legacySlideshow = source.data.tiktokMediaType == null && slides.length >= 1;
      if (!explicitSlideshow && !legacySlideshow) return null;

      const assetIds = slides.map((slide) => String(slide.data.assetId));
      if (assetIds.length < 1) return null;
      return {
        id: source.id,
        label: source.data.title || "TikTok slideshow",
        description: `${assetIds.length} slides${source.data.author ? ` · @${String(source.data.author).replace(/^@/, "")}` : ""}`,
        assetIds,
      };
    })
    .filter((source): source is TikTokSlideshowSource => Boolean(source));
}

export function matchesTikTokSlideshowSource(
  nodes: FrameNode[],
  edges: FrameEdge[],
  sourceNodeId: string,
  sourceAssetIds: string[],
) {
  const source = findTikTokSlideshowSources(nodes, edges).find((candidate) => candidate.id === sourceNodeId);
  return Boolean(source
    && source.assetIds.length === sourceAssetIds.length
    && source.assetIds.every((assetId, index) => assetId === sourceAssetIds[index]));
}
