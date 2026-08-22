export type VideoPlaybackIntent = "manual" | "hover" | null;
export type PendingSeekResolution = "idle" | "settled" | "waiting" | "retry";
export type VideoPlaybackToggleAction = "start" | "pause";

/**
 * Seek a decoder only after it has metadata.
 *
 * Assigning currentTime while a freshly mounted video is still HAVE_NOTHING
 * throws in Chromium. A timeline pointer-down must never be aborted by that
 * browser exception because pointer-up is what issues the durable Play
 * command and attaches the decoder.
 */
export function setVideoPlaybackTime(
  media: { readyState: number; currentTime: number } | null,
  time: number,
) {
  if (!media || media.readyState < 1 || !Number.isFinite(time)) return false;
  try {
    media.currentTime = Math.max(0, time);
    return true;
  } catch {
    return false;
  }
}

/** A completed clip must replay from its start; a paused clip resumes in place. */
export function videoPlaybackReplayTime(relativeTime: number, duration: number, endTolerance = .05) {
  const safeDuration = Math.max(0, Number(duration || 0));
  const safeTime = Math.min(safeDuration, Math.max(0, Number(relativeTime || 0)));
  return safeDuration > 0 && safeTime >= safeDuration - Math.max(.001, endTolerance) ? 0 : safeTime;
}

/** Resume inside one source scene, or restart at that scene's own boundary. */
export function videoSegmentReplayTime(currentTime: number, start: number, end: number, endTolerance = .05) {
  const safeStart = Math.max(0, Number(start || 0));
  const duration = Math.max(0, Number(end || 0) - safeStart);
  return safeStart + videoPlaybackReplayTime(Number(currentTime || 0) - safeStart, duration, endTolerance);
}

export function isCurrentVideoPlaybackSession(input: {
  sessionKey: string;
  desiredSessionKey: string;
  configuredSessionKey: string;
  currentSource: string;
  expectedSource: string;
}) {
  return Boolean(input.sessionKey
    && input.sessionKey === input.desiredSessionKey
    && input.sessionKey === input.configuredSessionKey
    && input.currentSource
    && input.currentSource === input.expectedSource);
}

export function shouldApplyVideoPlaybackRequest(input: {
  requestToken: number;
  handledToken?: number;
  targetKey?: string;
  currentKey?: string;
}) {
  if (input.requestToken === input.handledToken) return false;
  return !input.targetKey || input.targetKey === input.currentKey;
}

export function resolveVideoPlaybackIntent(input: {
  manualRequested: boolean;
  autoPlay: boolean;
  hovered: boolean;
  hoverSuppressed: boolean;
}): VideoPlaybackIntent {
  if (input.manualRequested || input.autoPlay) return "manual";
  if (input.hovered && !input.hoverSuppressed) return "hover";
  return null;
}

export function shouldPreserveContinuousPlayback(input: {
  sourceUnchanged: boolean;
  intent: VideoPlaybackIntent;
  paused: boolean;
  currentTime: number;
  clipStart: number;
  clipEnd: number;
}) {
  return Boolean(input.sourceUnchanged
    && input.intent
    && !input.paused
    && input.currentTime >= input.clipStart - .12
    && input.currentTime <= input.clipEnd + .12);
}

export function resolvePendingSeek(input: {
  pendingTime: number | null;
  currentTime: number;
  seeking: boolean;
  tolerance?: number;
}): PendingSeekResolution {
  if (input.pendingTime === null || !Number.isFinite(input.pendingTime)) return "idle";
  const tolerance = Math.max(.01, Number(input.tolerance ?? .12));
  if (!input.seeking && Math.abs(input.pendingTime - input.currentTime) <= tolerance) return "settled";
  return input.seeking ? "waiting" : "retry";
}

export function resolveVideoPlaybackToggle(input: {
  paused: boolean;
  manualRequested: boolean;
}): VideoPlaybackToggleAction {
  if (input.paused) return "start";
  return "pause";
}
