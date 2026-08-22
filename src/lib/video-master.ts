import type { FrameNode, VideoMasterClip } from "./types";
import { editorThumbnailUrl } from "./editor-media";

type VideoReferenceModel = {
  mediaType: "image" | "video";
  durations?: string[];
  defaultDuration?: string;
  durationSource?: "select" | "reference-video";
  ratios?: string[];
  defaultRatio?: string;
  inputPorts?: Array<{ id: string; kind: "image" | "video" | "audio" }>;
};

type VideoReference = { role?: string };
type VideoMasterLane = "output" | "original";
type VideoMasterLaneVisibility = { output: boolean; original: boolean };
export type VideoMasterDownloadLane = "output" | "original";

export type MasterClipOriginalReference = {
  id: string;
  url: string;
  title: string;
  assetId?: string;
  thumbnailUrl?: string;
  role: "reference-video";
  durationSeconds: number;
};

export type VideoMasterSourceTarget = {
  clip: VideoMasterClip;
  sourceAssetId?: string;
  sourceSegmentId?: string;
  sourceNodeAssetId?: string;
};

export type VideoMasterGeneratedOutput = NonNullable<VideoMasterClip["generatedOutputs"]>[number];

/**
 * Keep legacy current outputs visible alongside the explicit per-scene
 * history, while never treating an uploaded ORIGINAL clip as a generation.
 */
export function videoMasterGeneratedOutputs(clip: VideoMasterClip | undefined): VideoMasterGeneratedOutput[] {
  if (!clip) return [];
  return [...(clip.generatedOutputs || [])]
    .filter((output) => Boolean(output?.url))
    .filter((output, index, items) => items.findIndex((candidate) => candidate.url === output.url) === index)
    .slice(-20);
}

/** Select or copy one saved generation into a scene without losing history. */
export function useVideoMasterGeneratedOutput(
  clips: VideoMasterClip[],
  targetClipId: string,
  output: VideoMasterGeneratedOutput,
) {
  return clips.map((clip) => {
    if (clip.id !== targetClipId) return clip;
    const generatedOutputs = [...videoMasterGeneratedOutputs(clip), output]
      .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
      .slice(-20);
    return {
      ...clip,
      origin: "generated" as const,
      outputUrl: output.url,
      outputAssetId: output.assetId,
      generatedDuration: output.durationSeconds || clip.generatedDuration,
      generatedOutputs,
      modelId: output.modelId || clip.modelId,
    };
  });
}

const videoReferenceRoles = new Set(["reference-video", "motion-video"]);
const frameReferenceRoles = new Set(["start-frame", "end-frame"]);

/**
 * Some providers expose both frame animation and multimodal reference inputs
 * in one model, but require callers to choose one mode per request. ORIGINAL
 * is implicit in Video Master, so an explicit frame connection must win.
 */
export function shouldIncludeAutomaticMasterVideoReference(modelId: string | undefined, roles: Array<string | undefined>) {
  if (roles.some((role) => videoReferenceRoles.has(String(role || "")))) return false;
  if (String(modelId || "").startsWith("seedance-2") && roles.some((role) => frameReferenceRoles.has(String(role || "")))) return false;
  return true;
}

export function compatibleMasterReferences<T extends { role?: string }>(modelId: string | undefined, references: T[]) {
  const id = String(modelId || "");
  const hasFrames = references.some((reference) => frameReferenceRoles.has(String(reference.role || "")));
  if (!hasFrames) return references;
  if (id.startsWith("seedance-2")) return references.filter((reference) => frameReferenceRoles.has(String(reference.role || "")));
  if (id === "wan-2-7") return references.filter((reference) => reference.role !== "reference-video");
  if (id === "veo-3-1-fast") return references.filter((reference) => reference.role !== "reference-image");
  return references;
}

export function videoMasterProviderAspectRatio(modelId: string | undefined, requestedRatio: string, references: VideoReference[]) {
  const usesFrameMode = references.some((reference) => frameReferenceRoles.has(String(reference.role || "")));
  return String(modelId || "").startsWith("seedance-2") && usesFrameMode ? "adaptive" : requestedRatio;
}

export function modelSupportsVideoReference(model: VideoReferenceModel | undefined) {
  return Boolean(model?.mediaType === "video" && model.inputPorts?.some((port) => port.kind === "video" || videoReferenceRoles.has(port.id)));
}

export function masterClipHasVideoReference(clip: VideoMasterClip | undefined, references: VideoReference[] = []) {
  const hasOriginalLaneVideo = Boolean(clip?.origin !== "upload" && clip?.sourceUrl);
  return hasOriginalLaneVideo || references.some((reference) => videoReferenceRoles.has(String(reference.role || "")));
}

export function videoMasterModelsForScene<T extends VideoReferenceModel>(models: T[], clip: VideoMasterClip | undefined, references: VideoReference[] = []) {
  const videoModels = models.filter((model) => model.mediaType === "video");
  return masterClipHasVideoReference(clip, references)
    ? videoModels.filter(modelSupportsVideoReference)
    : videoModels;
}

export function videoMasterTimelineDuration(clip: VideoMasterClip | undefined) {
  const sourceStart = Number(clip?.sourceStart);
  const sourceEnd = Number(clip?.sourceEnd);
  if (clip?.sourceSegmentId && Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd > sourceStart) {
    return Math.max(.1, sourceEnd - sourceStart);
  }
  return Math.max(.1, Number(clip?.duration || 5));
}

export function videoMasterGenerationDuration(model: VideoReferenceModel | undefined, clip: VideoMasterClip | undefined) {
  const timelineDuration = videoMasterTimelineDuration(clip);
  const requested = Number(clip?.generationDuration || 0);
  // Motion-control providers derive duration from the uploaded driving video.
  // The selected timeline scene is the driving clip; there is no separate
  // provider duration control for this model family.
  if (model?.durationSource === "reference-video") {
    return timelineDuration;
  }
  const supported = (model?.durations || []).map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
  if (!supported.length) return Math.max(1, requested || Number(model?.defaultDuration || Math.ceil(timelineDuration)));
  // An untouched scene gets the cheapest provider duration that can cover the
  // complete timeline range. Once the user chooses a supported duration, keep
  // that exact choice even when it is shorter: generation then intentionally
  // uses only the beginning of the scene reference.
  if (supported.includes(requested)) return requested;
  return supported.find((value) => value >= timelineDuration) || supported[supported.length - 1];
}

export function videoMasterGenerationDurationChoices(model: VideoReferenceModel | undefined, clip: VideoMasterClip | undefined) {
  if (model?.durationSource === "reference-video") return [];
  return (model?.durations || []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
}

export function videoMasterSourceRatio(clip: VideoMasterClip | undefined, masterRatio: number | undefined) {
  const ratio = Number(clip?.sourceAspectRatio || masterRatio || 0);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 9 / 16;
}

export function nearestVideoMasterRatio(sourceRatio: number, ratios: string[]) {
  const numeric = ratios.filter((ratio) => /^\d+:\d+$/.test(ratio));
  if (!numeric.length) return "9:16";
  return numeric.reduce((best, ratio) => {
    const [width, height] = ratio.split(":").map(Number);
    const [bestWidth, bestHeight] = best.split(":").map(Number);
    return Math.abs(Math.log((width / height) / sourceRatio)) < Math.abs(Math.log((bestWidth / bestHeight) / sourceRatio)) ? ratio : best;
  }, numeric[0]);
}

export function assetIdFromAssetUrl(url: string | undefined) {
  if (!url) return undefined;
  const match = url.match(/(?:^|\/)api\/assets\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export function masterClipOriginalReference(clip: VideoMasterClip | undefined): MasterClipOriginalReference | undefined {
  if (!clip || clip.origin === "upload" || !clip.sourceUrl) return undefined;
  const hasSourceSegmentLineage = Boolean(clip.sourceNodeId && clip.sourceSegmentId);
  const url = String(hasSourceSegmentLineage ? clip.sourceClipUrl || clip.sourceUrl : clip.sourceUrl);
  return {
    id: `master-original-${clip.id}`,
    url,
    title: clip.title,
    assetId: (hasSourceSegmentLineage ? clip.sourceClipAssetId : undefined) || clip.sourceAssetId || assetIdFromAssetUrl(url),
    thumbnailUrl: clip.thumbnailUrl,
    role: "reference-video",
    durationSeconds: videoMasterClipPlaybackMedia(clip, "original", { output: false, original: true }).duration,
  };
}

/** Resolve the immutable ORIGINAL media that belongs to one exact Master scene. */
export function resolveVideoMasterSourceTarget(nodes: FrameNode[], masterNodeId: string, clipId: string): VideoMasterSourceTarget | undefined {
  const master = nodes.find((node) => node.id === masterNodeId && node.data.kind === "videoMaster");
  const clip = master?.data.videoMasterClips?.find((item) => item.id === clipId);
  if (!clip) return undefined;
  if (clip.sourceNodeId && clip.sourceSegmentId) {
    const sourceNode = nodes.find((node) => node.id === clip.sourceNodeId);
    const segment = sourceNode?.data.videoSegments?.find((item) => item.id === clip.sourceSegmentId);
    return {
      clip,
      sourceAssetId: segment?.clipAssetId || clip.sourceClipAssetId,
      sourceSegmentId: clip.sourceSegmentId,
      sourceNodeAssetId: sourceNode?.data.assetId || sourceNode?.data.videoSourceAssetId || clip.sourceAssetId,
    };
  }
  return {
    clip,
    sourceAssetId: assetIdFromAssetUrl(clip.sourceUrl) || clip.sourceAssetId,
  };
}

export function videoMasterClipPlaybackMedia(
  clip: VideoMasterClip | undefined,
  preferredLane: VideoMasterLane,
  laneVisibility: VideoMasterLaneVisibility = { output: true, original: true },
) {
  const outputUrl = String(clip?.outputUrl || (clip?.origin === "upload" ? clip.sourceUrl : "") || "");
  const materializedSourceUrl = clip?.origin === "upload" ? "" : String(clip?.sourceClipUrl || "");
  // Keep adjacent source scenes on the original media element. Switching the
  // foreground player between materialized per-scene MP4s forces a decoder
  // restart and creates a visible seam. Materialized clips remain available
  // for generation references and exact single-scene downloads.
  const originalUrl = clip?.origin === "upload" ? "" : String(clip?.sourceUrl || materializedSourceUrl || "");
  const preferredUrl = preferredLane === "original"
    ? (laneVisibility.original ? originalUrl : "")
    : (laneVisibility.output ? outputUrl : "");
  const fallbackUrl = preferredLane === "original"
    ? (laneVisibility.output ? outputUrl : "")
    : (laneVisibility.original ? originalUrl : "");
  const url = preferredUrl || fallbackUrl;
  const usesOutput = Boolean(url && outputUrl && url === outputUrl);
  const usesMaterializedSource = Boolean(url && materializedSourceUrl && !clip?.sourceUrl && url === materializedSourceUrl);
  const configuredDuration = videoMasterTimelineDuration(clip);
  const generatedDuration = Number(clip?.generatedDuration || 0);
  const outputDuration = Number.isFinite(generatedDuration) && generatedDuration > 0
    ? Math.min(configuredDuration, generatedDuration)
    : configuredDuration;
  const sourceStart = Math.max(0, Number(clip?.sourceStart || 0));
  const requestedSourceEnd = Number(clip?.sourceEnd);
  const sourceEnd = Number.isFinite(requestedSourceEnd) && requestedSourceEnd > sourceStart
    ? requestedSourceEnd
    : sourceStart + configuredDuration;
  const start = usesOutput || usesMaterializedSource ? 0 : sourceStart;
  const end = usesOutput
    ? outputDuration
    : usesMaterializedSource
      ? Math.max(.1, sourceEnd - sourceStart)
      : Math.max(start + .1, sourceEnd);
  return { url, outputUrl, originalUrl, usesOutput, start, end, duration: Math.max(.1, end - start) };
}

export function reconciledVideoMasterClipDuration(
  clip: VideoMasterClip,
  playback: ReturnType<typeof videoMasterClipPlaybackMedia>,
  physicalDuration: number,
) {
  if (!Number.isFinite(physicalDuration) || physicalDuration <= 0) return undefined;
  if (clip.origin === "upload") return Math.max(.1, physicalDuration);
  // Some legacy standalone uploads were saved as `source` clips with a
  // provisional five-second range but without source-segment lineage. Repair
  // only a range that overruns the physical file. A real source edit whose
  // media is longer than its selected range must keep that intentional trim.
  if (clip.sourceSegmentId || playback.start > .02 || physicalDuration >= playback.end - .02) return undefined;
  return Math.max(.1, physicalDuration - playback.start);
}

export function reconciledVideoMasterGeneratedDuration(
  clip: VideoMasterClip,
  playback: ReturnType<typeof videoMasterClipPlaybackMedia>,
  physicalDuration: number,
) {
  if (!playback.usesOutput || !Number.isFinite(physicalDuration) || physicalDuration <= 0) return undefined;
  return Math.max(.1, physicalDuration - playback.start);
}

export function videoMasterClipExportMedia(
  clip: VideoMasterClip,
  lane: VideoMasterDownloadLane,
  sourceNode?: FrameNode,
) {
  const playback = videoMasterClipPlaybackMedia(clip, lane, {
    output: lane === "output",
    original: lane === "original",
  });
  let source = videoMasterClipDownloadSource(clip, lane);
  let start = playback.start;
  let end = playback.end;

  // The source timeline is authoritative. Master clips intentionally copy
  // their timing for persistence, but that copy can become stale after scene
  // edits or legacy hydration. Resolving the live source segment here prevents
  // a full export from repeating the wrong range or omitting a scene.
  if (lane === "original" && sourceNode && clip.sourceSegmentId) {
    const segment = sourceNode.data.videoSegments?.find((item) => item.id === clip.sourceSegmentId);
    const sourceUrl = String(sourceNode.data.outputUrl || sourceNode.data.imageUrl || clip.sourceUrl || "");
    const sourceAssetId = sourceNode.data.assetId || assetIdFromAssetUrl(sourceUrl);
    if (segment && sourceUrl && sourceAssetId) {
      source = { url: sourceUrl, assetId: sourceAssetId };
      start = Math.max(0, segment.start);
      end = Math.max(start + .001, segment.end);
    }
  }

  return { source, start, end };
}

/**
 * Source imports already materialize frame-accurate per-scene MP4s. Reattach
 * those assets to legacy Video Master clips for generation references and
 * exact scene downloads. Sequence playback and full export keep the original
 * source URL so adjacent scenes remain one continuous stream.
 */
export function hydrateVideoMasterSourceClips(graphNodes: FrameNode[]): FrameNode[] {
  const nodeById = new Map(graphNodes.map((node) => [node.id, node]));
  return graphNodes.map((node) => {
    if (node.data.kind !== "videoMaster" || !node.data.videoMasterClips?.length) return node;
    let changed = false;
    const clips = node.data.videoMasterClips.map((clip, index) => {
      // A standalone uploaded clip moved to ORIGINAL has its own source asset.
      // Never hydrate it by sequence index from the Master node's TikTok source:
      // that can silently attach Scene 01/02 media to an unrelated later scene.
      if (!clip.sourceNodeId && !clip.sourceSegmentId) {
        if (!clip.sourceClipUrl && !clip.sourceClipAssetId) return clip;
        changed = true;
        return { ...clip, sourceClipUrl: undefined, sourceClipAssetId: undefined };
      }
      const sourceNode = nodeById.get(clip.sourceNodeId || node.data.videoMasterSourceNodeId || "");
      const orderedSegments = [...(sourceNode?.data.videoSegments || [])].sort((left, right) =>
        Number(left.sequenceIndex ?? left.index) - Number(right.sequenceIndex ?? right.index) || left.start - right.start);
      const segment = orderedSegments.find((item) => item.id === clip.sourceSegmentId) || orderedSegments[index];
      if (!segment) return clip;
      const nextSourceClipUrl = segment.clipUrl || clip.sourceClipUrl;
      const nextSourceClipAssetId = segment.clipAssetId || clip.sourceClipAssetId;
      const nextThumbnailUrl = segment.thumbnailUrl || clip.thumbnailUrl;
      if (clip.sourceClipUrl === nextSourceClipUrl && clip.sourceClipAssetId === nextSourceClipAssetId && clip.thumbnailUrl === nextThumbnailUrl) return clip;
      changed = true;
      return { ...clip, sourceClipUrl: nextSourceClipUrl, sourceClipAssetId: nextSourceClipAssetId, thumbnailUrl: nextThumbnailUrl };
    });
    return changed ? { ...node, data: { ...node.data, videoMasterClips: clips } } : node;
  });
}

export function videoMasterClipThumbnail(clip: VideoMasterClip | undefined, lane?: VideoMasterLane) {
  if (!clip) return "";
  const outputUrl = String(clip.outputUrl || (clip.origin === "upload" ? clip.sourceUrl : "") || "");
  const originalUrl = clip.origin === "upload" ? "" : String(clip.sourceUrl || "");
  const savedOutputThumbnail = videoMasterGeneratedOutputs(clip).find((output) =>
    output.url === outputUrl || Boolean(output.assetId && output.assetId === clip.outputAssetId)
  )?.thumbnailUrl;
  if (lane === "output" && outputUrl) return editorThumbnailUrl(String(savedOutputThumbnail || (clip.origin === "upload" ? clip.thumbnailUrl : "") || outputUrl));
  if (lane === "original" && originalUrl) return editorThumbnailUrl(String(clip.thumbnailUrl || originalUrl));
  return editorThumbnailUrl(String(clip.thumbnailUrl || outputUrl || originalUrl || clip.sourceUrl || ""));
}

export function videoMasterClipDownloadSource(clip: VideoMasterClip | undefined, lane: VideoMasterDownloadLane) {
  if (!clip) return undefined;
  if (lane === "output") {
    const url = String(clip.outputUrl || (clip.origin === "upload" ? clip.sourceUrl : "") || "");
    const assetId = clip.outputAssetId || (clip.origin === "upload" ? clip.sourceAssetId : undefined) || assetIdFromAssetUrl(url);
    return url && assetId ? { url, assetId } : undefined;
  }
  if (clip.origin === "upload") return undefined;
  const url = String(clip.sourceUrl || "");
  const assetId = clip.sourceAssetId || assetIdFromAssetUrl(url);
  return url && assetId ? { url, assetId } : undefined;
}

export function videoMasterDownloadAvailability(clips: VideoMasterClip[], lane: VideoMasterDownloadLane, selectedClipId?: string) {
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) || clips[0];
  const isAvailable = (clip: VideoMasterClip | undefined) => Boolean(clip && (
    videoMasterClipDownloadSource(clip, lane)
    || (lane === "original" && clip.sourceNodeId && clip.sourceSegmentId)
  ));
  const availableCount = clips.filter(isAvailable).length;
  return {
    selected: isAvailable(selectedClip),
    all: clips.length > 0 && availableCount === clips.length,
    availableCount,
    totalCount: clips.length,
  };
}

export function moveUploadedMasterClipToLane(clip: VideoMasterClip, lane: "output" | "original") {
  if (clip.sourceNodeId || !clip.sourceUrl) return clip;
  const sourceAssetId = clip.sourceAssetId || assetIdFromAssetUrl(clip.sourceUrl);
  const attachedReferences = (clip.attachedReferences || []).filter((reference) => !(
    reference.assetId === sourceAssetId
    && reference.url === clip.sourceUrl
    && videoReferenceRoles.has(String(reference.role || ""))
  ));
  const timing = {
    sourceStart: 0,
    sourceEnd: Math.max(.1, Number(clip.duration || 5)),
  };
  if (lane === "output") return {
    ...clip,
    ...timing,
    origin: "upload" as const,
    attachedReferences,
  };
  return {
    ...clip,
    sourceAssetId,
    sourceClipUrl: undefined,
    sourceClipAssetId: undefined,
    ...timing,
    origin: "source" as const,
    outputUrl: undefined,
    outputAssetId: undefined,
    attachedReferences: sourceAssetId ? [...attachedReferences, {
      assetId: sourceAssetId,
      url: clip.sourceUrl,
      title: clip.title,
      thumbnailUrl: clip.thumbnailUrl,
      role: "reference-video" as const,
      durationSeconds: Math.max(.1, Number(clip.duration || 5)),
    }] : attachedReferences,
  };
}
