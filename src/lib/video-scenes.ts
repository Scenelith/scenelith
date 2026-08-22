import type { VideoSceneSegment } from "./types";

export type DetectedVideoScene = {
  index: number;
  start: number;
  end: number;
  confidence: number;
  frame?: number;
};

export type VideoSceneCandidate = { time: number; score: number; frame?: number };

// FFmpeg's scene score also reacts to large subject motion. Values around
// 0.15-0.25 are common when a person turns inside one continuous take; a
// conservative 0.30 floor keeps those motion peaks from becoming edit cuts.
export const DEFAULT_VIDEO_SCENE_SCORE = 0.3;

const CUT_EPSILON_SECONDS = 0.0005;

function sceneOrder(segment: VideoSceneSegment, index: number) {
  return Number.isFinite(segment.sequenceIndex) ? Number(segment.sequenceIndex) : index;
}

function legacyDetectedSegments(segments: VideoSceneSegment[], duration: number) {
  const detected = segments.filter((segment) => segment.thumbnailAssetId
    && segment.id === `video-scene-${segment.thumbnailAssetId}`
    && Number.isFinite(segment.thumbnailTime));
  if (!detected.length) return [];
  return detected
    .slice()
    .sort((left, right) => Number(left.thumbnailTime) - Number(right.thumbnailTime))
    .map((segment, index, ordered) => ({
      ...segment,
      start: index === 0 ? 0 : Number(segment.thumbnailTime),
      end: index + 1 < ordered.length ? Number(ordered[index + 1].thumbnailTime) : duration,
      sequenceIndex: index,
    }));
}

export function restoreDetectedVideoSegments(current: VideoSceneSegment[], duration: number, detected?: VideoSceneSegment[]) {
  const safeDuration = Math.max(0.001, Number.isFinite(duration) ? duration : current.at(-1)?.end || 0.001);
  const baseline = (detected?.length ? detected : legacyDetectedSegments(current, safeDuration))
    .slice()
    .sort((left, right) => left.start - right.start);
  const currentById = new Map(current.map((segment) => [segment.id, segment]));
  return baseline.map((segment, index) => {
    const start = index === 0 ? 0 : segment.start;
    const end = index + 1 < baseline.length ? baseline[index + 1].start : safeDuration;
    const currentSegment = currentById.get(segment.id);
    const sameCut = Boolean(currentSegment
      && Math.abs(currentSegment.start - start) <= CUT_EPSILON_SECONDS
      && Math.abs(currentSegment.end - end) <= CUT_EPSILON_SECONDS);
    return {
      ...segment,
      index: index + 1,
      sequenceIndex: sceneOrder(segment, index),
      label: `Scene ${String(index + 1).padStart(2, "0")}`,
      role: index === 0 ? "hook" as const : index === baseline.length - 1 ? "cta" as const : "scene" as const,
      start,
      end,
      replacementAssetId: currentSegment?.replacementAssetId,
      replacementUrl: currentSegment?.replacementUrl,
      clipAssetId: sameCut ? currentSegment?.clipAssetId : undefined,
      clipUrl: sameCut ? currentSegment?.clipUrl : undefined,
    };
  }).filter((segment) => segment.end - segment.start >= 1 / 120);
}

export function videoSceneCutsMatch(current: VideoSceneSegment[], baseline: VideoSceneSegment[]) {
  if (current.length !== baseline.length) return false;
  const orderedCurrent = current.slice().sort((left, right) => left.start - right.start);
  return orderedCurrent.every((segment, index) => {
    const detected = baseline[index];
    return detected?.id === segment.id
      && Math.abs(detected.start - segment.start) <= CUT_EPSILON_SECONDS
      && Math.abs(detected.end - segment.end) <= CUT_EPSILON_SECONDS
      && sceneOrder(detected, index) === sceneOrder(segment, index);
  });
}

export function normalizeVideoSceneBoundaries(candidates: VideoSceneCandidate[], duration: number, options: {
  minimumGapSeconds?: number;
  minimumScore?: number;
  maximumScenes?: number;
} = {}): DetectedVideoScene[] {
  const safeDuration = Math.max(0.04, Number.isFinite(duration) ? duration : 0.04);
  const minimumGap = Math.max(1 / 60, options.minimumGapSeconds ?? 0.16);
  const minimumScore = Math.max(0, Math.min(1, options.minimumScore ?? DEFAULT_VIDEO_SCENE_SCORE));
  const maximumScenes = Math.max(1, options.maximumScenes ?? 80);
  const ordered = candidates
    .filter((candidate) => Number.isFinite(candidate.time)
      // Scene-score filters often emit a duplicate transition within the first
      // or final few frames. Those cuts create unusable slivers at the ends of
      // the editor, so absorb them into the adjacent real scene.
      && candidate.time >= minimumGap
      && candidate.time <= safeDuration - minimumGap
      && Number(candidate.score || 0) >= minimumScore)
    .map((candidate) => ({ time: Math.round(candidate.time * 1_000_000) / 1_000_000, score: Math.max(0, Math.min(1, candidate.score || 0)), frame: candidate.frame }))
    .sort((left, right) => left.time - right.time);

  const clustered: VideoSceneCandidate[] = [];
  for (const candidate of ordered) {
    const previous = clustered.at(-1);
    if (previous && candidate.time - previous.time < minimumGap) {
      if (candidate.score > previous.score) clustered[clustered.length - 1] = candidate;
      continue;
    }
    clustered.push(candidate);
  }
  const limited = clustered.length + 1 <= maximumScenes
    ? clustered
    : clustered
      .slice()
      .sort((left, right) => right.score - left.score)
      .slice(0, maximumScenes - 1)
      .sort((left, right) => left.time - right.time);
  const boundaries: VideoSceneCandidate[] = [{ time: 0, score: 1, frame: 0 }, ...limited];
  return boundaries.map((boundary, index) => ({
    index: index + 1,
    start: boundary.time,
    end: index + 1 < boundaries.length ? boundaries[index + 1].time : Math.round(safeDuration * 1_000_000) / 1_000_000,
    confidence: boundary.score,
    frame: boundary.frame,
  })).filter((segment) => segment.end - segment.start >= 1 / 60);
}
