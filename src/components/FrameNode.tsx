"use client";

/* eslint-disable @next/next/no-img-element */

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type Dispatch, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { Handle, NodeToolbar, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { ArrowRightLeft, Check, ChevronDown, Clapperboard, Copy, Download, Expand, Eye, EyeOff, FileText, ImageIcon, Images, MousePointer2, Pause, Play, Plus, Quote, Settings2, Sparkles, StickyNote, Trash2, Upload, UserRound, Video, Volume2, VolumeX, WandSparkles, Workflow, X } from "lucide-react";
import type { FrameNode, GeneratorInputRole, PersonaRecord, VideoMasterClip, VideoSceneSegment } from "@/lib/types";
import { referenceMentionToken } from "@/lib/reference-mentions";
import { ImageGeneration } from "@/components/ui/ai-chat-image-generation-1";
import { generationCreditCost } from "@/lib/generation-pricing";
import { MAX_GENERATION_BATCH } from "@/lib/generation-queue";
import { assistantModelCreditDescription, assistantModels, normalizeAssistantModelId } from "@/lib/assistant-models";
import { VideoSceneTimeline } from "@/components/VideoSceneTimeline";
import { masterClipHasVideoReference, masterClipOriginalReference, modelSupportsVideoReference, moveUploadedMasterClipToLane, nearestVideoMasterRatio, reconciledVideoMasterClipDuration, reconciledVideoMasterGeneratedDuration, useVideoMasterGeneratedOutput as applyVideoMasterGeneratedOutput, videoMasterClipPlaybackMedia, videoMasterClipThumbnail, videoMasterDownloadAvailability, videoMasterGeneratedOutputs, videoMasterGenerationDuration, videoMasterGenerationDurationChoices, videoMasterModelsForScene, videoMasterSourceRatio, videoMasterTimelineDuration, type VideoMasterDownloadLane, type VideoMasterGeneratedOutput } from "@/lib/video-master";
import { isCurrentVideoPlaybackSession, resolvePendingSeek, resolveVideoPlaybackIntent, resolveVideoPlaybackToggle, shouldApplyVideoPlaybackRequest, shouldPreserveContinuousPlayback, videoPlaybackReplayTime } from "@/lib/video-playback";
import { claimVideoPlayback, subscribeToVideoPlaybackClaims, videoPlaybackManager } from "@/lib/video-playback-owner";
import { CanvasVideoPlayer, type CanvasVideoPlaybackRequest } from "@/components/CanvasVideoPlayer";
import { VideoMasterPlayer } from "@/components/VideoMasterPlayer";
import { editorPlaybackUrl } from "@/lib/editor-media";
import { AddToIdentityPopover } from "@/components/AddToIdentityPopover";

export { CanvasVideoPlayer, type CanvasVideoPlaybackRequest } from "@/components/CanvasVideoPlayer";

export type GeneratorModelOption = { id: string; label: string; mediaType: "image" | "video"; description: string; maxReferences: number; ratios?: string[]; ratiosByResolution?: Record<string, string[]>; referenceRatiosByResolution?: Record<string, string[]>; referenceOnlyRatios?: string[]; resolutions?: string[]; videoInputOnlyResolutions?: string[]; durations?: string[]; defaultRatio?: string; defaultResolution?: string; defaultDuration?: string; defaultGenerateAudio?: boolean; durationSource?: "select" | "reference-video"; inputPorts?: Array<{ id: string; label: string; kind: "image" | "video" | "audio"; required?: boolean; max?: number }>; supportsAudio?: boolean };
type GeneratorReference = { id: string; edgeId?: string; url: string; title: string; thumbnailUrl?: string; assetId?: string; sourceNodeId?: string; personaId?: string; removable?: boolean; variant?: "reference" | "before" | "after"; role?: string; durationSeconds?: number; aspectRatio?: number };

export function generatorRatiosFor(model: GeneratorModelOption | undefined, resolution: string | undefined, hasReferences: boolean) {
  if (!model) return ["1:1", "4:5", "9:16", "16:9"];
  const resolutionKey = String(resolution || model.defaultResolution || model.resolutions?.[0] || "1K").toUpperCase();
  const resolutionMap = hasReferences && model.referenceRatiosByResolution ? model.referenceRatiosByResolution : model.ratiosByResolution;
  const ratios = resolutionMap?.[resolutionKey] || model.ratios || ["1:1"];
  return hasReferences || !model.referenceOnlyRatios?.length ? ratios : ratios.filter((ratio) => !model.referenceOnlyRatios?.includes(ratio));
}

export function generatorResolutionsFor(model: GeneratorModelOption | undefined, hasVideoInput: boolean) {
  const resolutions = model?.resolutions?.length ? model.resolutions : [model?.defaultResolution || "1K"];
  if (hasVideoInput || !model?.videoInputOnlyResolutions?.length) return resolutions;
  const videoOnly = new Set(model.videoInputOnlyResolutions.map((resolution) => resolution.toUpperCase()));
  return resolutions.filter((resolution) => !videoOnly.has(resolution.toUpperCase()));
}

export function generatorSettingsForModel(model: GeneratorModelOption | undefined, current: { aspectRatio?: string; resolution?: string; duration?: string }, hasReferences: boolean, hasVideoInput = false) {
  const resolutions = generatorResolutionsFor(model, hasVideoInput);
  const currentResolution = String(current.resolution || "");
  let resolution = resolutions.includes(currentResolution)
    ? currentResolution
    : model?.defaultResolution || resolutions[0] || currentResolution || "1K";
  const currentRatio = String(current.aspectRatio || "");
  if (currentRatio && !generatorRatiosFor(model, resolution, hasReferences).includes(currentRatio)) {
    const compatibleResolution = resolutions.find((candidate) => generatorRatiosFor(model, candidate, hasReferences).includes(currentRatio));
    if (compatibleResolution) resolution = compatibleResolution;
  }
  const ratios = generatorRatiosFor(model, resolution, hasReferences).filter((ratio) => ratio !== "source");
  const aspectRatio = currentRatio && ratios.includes(currentRatio)
    ? currentRatio
    : ratios.includes(model?.defaultRatio || "") ? model!.defaultRatio! : ratios[0] || currentRatio || "1:1";
  const duration = model?.durations?.includes(String(current.duration || ""))
    ? String(current.duration)
    : model?.defaultDuration || model?.durations?.[0] || current.duration || "5";
  return { aspectRatio, resolution, duration, preservedAspectRatio: aspectRatio === currentRatio };
}

export function generatorModelCreditDescription(model: GeneratorModelOption, input: {
  resolution?: string;
  duration?: string;
  referenceCount?: number;
  generateAudio?: boolean;
  hasVideoInput?: boolean;
  inputVideoDurationSeconds?: number;
} = {}) {
  const resolutions = generatorResolutionsFor(model, Boolean(input.hasVideoInput));
  const resolution = resolutions.includes(String(input.resolution || "").toUpperCase())
    ? String(input.resolution).toUpperCase()
    : resolutions.includes(model.defaultResolution || "") ? model.defaultResolution! : resolutions[0] || "1K";
  const duration = model.durations?.includes(String(input.duration || ""))
    ? String(input.duration)
    : model.defaultDuration || model.durations?.[0] || "5";
  const credits = generationCreditCost(model.id, resolution, duration, Math.min(model.maxReferences, Math.max(0, input.referenceCount || 0)), {
    generateAudio: input.generateAudio ?? model.defaultGenerateAudio,
    hasVideoInput: input.hasVideoInput,
    inputVideoDurationSeconds: input.inputVideoDurationSeconds,
  });
  return `≈ ${credits.toLocaleString("en-US")} credit${credits === 1 ? "" : "s"}`;
}

export function assetDownloadUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export function assetThumbnailUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.set("variant", "thumbnail");
  // Let object storage serve many restored previews concurrently. Proxying
  // every image stream through the application makes a large canvas exhaust
  // the browser's origin connection pool while those streams stay open.
  parsed.searchParams.set("delivery", "direct");
  parsed.searchParams.set("v", "4");
  return `${parsed.pathname}${parsed.search}`;
}

export function assetDirectUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.delete("variant");
  parsed.searchParams.delete("v");
  parsed.searchParams.set("delivery", "direct");
  return `${parsed.pathname}${parsed.search}`;
}

function formatVideoTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function formatPreciseVideoTime(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(value / 60);
  const wholeSeconds = Math.floor(value % 60);
  const milliseconds = Math.floor((value - Math.floor(value)) * 1000);
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function formatTimelineRulerTime(seconds: number) {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
  return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))}s`;
}

type LegacyCanvasVideoPlaybackRequest = {
  token: number;
  playing: boolean;
  targetKey?: string;
  relativeTime?: number;
};

type PendingVideoSeek = {
  sessionKey: string;
  time: number;
};

function LegacyCanvasVideoPlayer({ src, variant, controlsPlacement = "overlay", controlsPortal, clipStart = 0, clipEnd, backdropUrl, blurBackdrop = false, autoPlay = false, hoverActive, hoverSession, selectionActive, clickToToggle = false, keyboardActive = false, seamlessClipEnd = false, preloadSrc, preloadStart = 0, playbackKey, requestedRelativeTime, requestedSeekToken, requestedPlayback, externalCurrentTime, externalDuration, externalActions, onExternalSeek, onAspectRatio, onDoubleClick, onPlaybackChange, onTimeChange, onClipEnded }: {
  src: string;
  variant: "generator" | "scene" | "card";
  controlsPlacement?: "overlay" | "dock" | "external";
  controlsPortal?: HTMLElement | null;
  clipStart?: number;
  clipEnd?: number;
  backdropUrl?: string;
  blurBackdrop?: boolean;
  autoPlay?: boolean;
  hoverActive?: boolean;
  hoverSession?: number;
  selectionActive?: boolean;
  clickToToggle?: boolean;
  keyboardActive?: boolean;
  seamlessClipEnd?: boolean;
  preloadSrc?: string;
  preloadStart?: number;
  playbackKey?: string;
  requestedRelativeTime?: number;
  requestedSeekToken?: number;
  requestedPlayback?: LegacyCanvasVideoPlaybackRequest;
  externalCurrentTime?: number;
  externalDuration?: number;
  externalActions?: ReactNode;
  onExternalSeek?: (time: number) => void;
  onAspectRatio?: (ratio: number) => void;
  onDoubleClick?: () => void;
  onPlaybackChange?: (playing: boolean) => void;
  onTimeChange?: (relativeTime: number, duration: number) => void;
  onClipEnded?: (playback: "manual" | "hover") => void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadedSourceRef = useRef("");
  const manualPlaybackRef = useRef(false);
  const hoverPreviewRef = useRef(false);
  const previousAutoPlayRef = useRef(autoPlay);
  const hoverSessionRef = useRef(hoverSession);
  const hoverSuppressedRef = useRef(false);
  const clipEndedRef = useRef("");
  const externalScrubRef = useRef(false);
  const pendingSeekRef = useRef<PendingVideoSeek | null>(null);
  const mediaGenerationRef = useRef(0);
  const playbackBlockedRef = useRef(false);
  const externalScrubReleaseTimerRef = useRef<number | null>(null);
  const playRetryTimerRef = useRef<number | null>(null);
  const playRetryCountRef = useRef(0);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const previousSelectionActiveRef = useRef(selectionActive);
  const requestedPlaybackTokenRef = useRef<number | undefined>(requestedPlayback?.token === 0 ? 0 : undefined);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [externalScrubTime, setExternalScrubTime] = useState<number | null>(null);
  const safeClipStart = Number.isFinite(clipStart) ? Math.max(0, clipStart) : 0;
  const requestedClipEnd = Number.isFinite(clipEnd) ? Number(clipEnd) : duration;
  const safeClipEnd = requestedClipEnd > safeClipStart ? requestedClipEnd : Math.max(safeClipStart + .1, duration);
  const clipDuration = Math.max(.1, safeClipEnd - safeClipStart);
  const playbackSessionKey = `${playbackKey || "media"}|${src}|${safeClipStart.toFixed(6)}|${safeClipEnd.toFixed(6)}`;
  const desiredSessionKeyRef = useRef(playbackSessionKey);
  const relativeTime = Math.min(clipDuration, Math.max(0, currentTime - safeClipStart));
  const displayedDuration = controlsPlacement === "external" && Number.isFinite(externalDuration) ? Math.max(.1, Number(externalDuration)) : clipDuration;
  const controlledExternalTime = Number.isFinite(externalCurrentTime) ? Math.min(displayedDuration, Math.max(0, Number(externalCurrentTime))) : relativeTime;
  const displayedTime = controlsPlacement === "external"
    ? Math.min(displayedDuration, Math.max(0, externalScrubTime ?? controlledExternalTime))
    : relativeTime;
  const progress = displayedDuration > 0 ? Math.min(100, Math.max(0, displayedTime / displayedDuration * 100)) : 0;
  const playbackConfigRef = useRef({ sessionKey: playbackSessionKey, src, clipStart: safeClipStart, clipEnd: safeClipEnd, clipDuration, autoPlay, hoverActive, controlledHoverFallback: hoverSession !== undefined, seamlessClipEnd, hasNext: Boolean(preloadSrc) });
  useLayoutEffect(() => {
    desiredSessionKeyRef.current = playbackSessionKey;
    playbackConfigRef.current = { sessionKey: playbackSessionKey, src, clipStart: safeClipStart, clipEnd: safeClipEnd, clipDuration, autoPlay, hoverActive, controlledHoverFallback: hoverSession !== undefined, seamlessClipEnd, hasNext: Boolean(preloadSrc) };
  }, [autoPlay, clipDuration, hoverActive, hoverSession, playbackSessionKey, preloadSrc, safeClipEnd, safeClipStart, seamlessClipEnd, src]);
  const playbackCallbacksRef = useRef({ onPlaybackChange, onTimeChange, onClipEnded });
  useEffect(() => {
    playbackCallbacksRef.current = { onPlaybackChange, onTimeChange, onClipEnded };
  }, [onClipEnded, onPlaybackChange, onTimeChange]);

  const mediaMatchesSession = (video: HTMLVideoElement, sessionKey = desiredSessionKeyRef.current) => {
    const config = playbackConfigRef.current;
    if (!config.src || !video.currentSrc) return false;
    try {
      return isCurrentVideoPlaybackSession({
        sessionKey,
        desiredSessionKey: desiredSessionKeyRef.current,
        configuredSessionKey: config.sessionKey,
        currentSource: new URL(video.currentSrc, document.baseURI).href,
        expectedSource: new URL(assetDirectUrl(config.src), document.baseURI).href,
      });
    } catch {
      return isCurrentVideoPlaybackSession({
        sessionKey,
        desiredSessionKey: desiredSessionKeyRef.current,
        configuredSessionKey: config.sessionKey,
        currentSource: video.currentSrc,
        expectedSource: assetDirectUrl(config.src),
      });
    }
  };

  const positionMedia = (media: HTMLVideoElement | null, targetTime: number) => {
    if (!media || media.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(targetTime)) return false;
    const mediaDuration = Number.isFinite(media.duration) ? Math.max(0, media.duration) : 0;
    const boundedTime = mediaDuration > 0 ? Math.min(Math.max(0, targetTime), Math.max(0, mediaDuration - .001)) : Math.max(0, targetTime);
    if (Math.abs(media.currentTime - boundedTime) <= .015) return !media.seeking;
    try {
      media.currentTime = boundedTime;
    } catch {
      return false;
    }
    return false;
  };

  const clearPlayRetry = () => {
    if (playRetryTimerRef.current !== null) window.clearTimeout(playRetryTimerRef.current);
    playRetryTimerRef.current = null;
    playRetryCountRef.current = 0;
  };

  const cancelVideoFrameMonitor = () => {
    const video = videoRef.current;
    if (video && videoFrameCallbackRef.current !== null && "cancelVideoFrameCallback" in video) video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
    videoFrameCallbackRef.current = null;
  };

  const requestSeek = (targetTime: number, sessionKey = desiredSessionKeyRef.current) => {
    const video = videoRef.current;
    if (!playbackConfigRef.current.src || playbackConfigRef.current.sessionKey !== sessionKey || !Number.isFinite(targetTime)) return;
    pendingSeekRef.current = { sessionKey, time: targetTime };
    const mainSettled = video && mediaMatchesSession(video, sessionKey) ? positionMedia(video, targetTime) : false;
    if (mainSettled) pendingSeekRef.current = null;
    setCurrentTime(targetTime);
  };

  useEffect(() => () => {
    if (externalScrubReleaseTimerRef.current !== null) window.clearTimeout(externalScrubReleaseTimerRef.current);
    clearPlayRetry();
    cancelVideoFrameMonitor();
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }, []);

  const loadedMediaTarget = (video: HTMLVideoElement, sessionKey = desiredSessionKeyRef.current) => {
    const config = playbackConfigRef.current;
    const pendingSeek = pendingSeekRef.current;
    if (pendingSeek?.sessionKey === sessionKey) return pendingSeek.time;
    if (video.currentTime >= config.clipStart - .01 && video.currentTime <= config.clipEnd + .01) return video.currentTime;
    return config.clipStart;
  };

  useEffect(() => {
    if (!Number.isFinite(requestedRelativeTime)) return;
    const nextTime = safeClipStart + Math.min(clipDuration, Math.max(0, Number(requestedRelativeTime)));
    requestSeek(nextTime);
    // `requestSeek` always targets the current media elements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipDuration, requestedRelativeTime, requestedSeekToken, safeClipStart]);

  const desiredPlaybackIntent = (): "manual" | "hover" | null => {
    const config = playbackConfigRef.current;
    // A controlled `hoverActive={false}` means manual playback only. This is
    // what keeps the fullscreen editor from starting whenever the pointer
    // merely crosses the video.
    const controlledHoverOwner = playerRef.current?.closest(".frame-node--video-master");
    const controlledOwnerIsHovered = Boolean(controlledHoverOwner?.matches(":hover"));
    const pointerIsOverPlayer = typeof config.hoverActive === "boolean"
      ? Boolean((config.hoverActive && controlledOwnerIsHovered) || (config.controlledHoverFallback && hoverPreviewRef.current))
      : hoverPreviewRef.current || Boolean(playerRef.current?.matches(":hover"));
    return resolveVideoPlaybackIntent({
      manualRequested: manualPlaybackRef.current,
      autoPlay: config.autoPlay,
      hovered: pointerIsOverPlayer,
      hoverSuppressed: hoverSuppressedRef.current,
    });
  };

  const schedulePlayRetry = (generation = mediaGenerationRef.current, sessionKey = desiredSessionKeyRef.current) => {
    if (playRetryTimerRef.current !== null) return;
    playRetryCountRef.current += 1;
    playRetryTimerRef.current = window.setTimeout(() => {
      playRetryTimerRef.current = null;
      if (generation === mediaGenerationRef.current && sessionKey === desiredSessionKeyRef.current) reconcilePlayback(generation, sessionKey);
    }, Math.min(360, 60 + playRetryCountRef.current * 30));
  };

  const reconcilePlayback = (generation = mediaGenerationRef.current, sessionKey = desiredSessionKeyRef.current) => {
    const video = videoRef.current;
    const config = playbackConfigRef.current;
    if (!video || !config.src || playbackBlockedRef.current || generation !== mediaGenerationRef.current || sessionKey !== desiredSessionKeyRef.current || config.sessionKey !== sessionKey) return;
    const intent = desiredPlaybackIntent();
    if (!intent) {
      clearPlayRetry();
      video.pause();
      return;
    }
    if (intent === "hover") {
      video.muted = true;
      setMuted(true);
    }
    if (externalScrubRef.current) return;
    if (!mediaMatchesSession(video, sessionKey)) {
      schedulePlayRetry(generation, sessionKey);
      return;
    }
    if (video.ended || video.currentTime < config.clipStart - .05 || video.currentTime >= config.clipEnd - .01) {
      requestSeek(config.clipStart, sessionKey);
    }
    const pendingSeek = pendingSeekRef.current;
    if (pendingSeek?.sessionKey === sessionKey) {
      const pendingResolution = resolvePendingSeek({ pendingTime: pendingSeek.time, currentTime: video.currentTime, seeking: video.seeking });
      if (pendingResolution === "settled") {
        pendingSeekRef.current = null;
        playRetryCountRef.current = 0;
      }
      else {
        if (pendingResolution === "retry") positionMedia(video, pendingSeek.time);
        schedulePlayRetry(generation, sessionKey);
        return;
      }
    }
    if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      schedulePlayRetry(generation, sessionKey);
      return;
    }
    void video.play().catch(() => {
      if (generation !== mediaGenerationRef.current || sessionKey !== desiredSessionKeyRef.current || desiredPlaybackIntent() !== intent) return;
      setPlaying(false);
      schedulePlayRetry(generation, sessionKey);
    });
  };

  const finishCurrentClip = (video: HTMLVideoElement) => {
    const sessionKey = desiredSessionKeyRef.current;
    const config = playbackConfigRef.current;
    const pendingSeek = pendingSeekRef.current;
    if (!mediaMatchesSession(video, sessionKey) || pendingSeek?.sessionKey === sessionKey || video.seeking) return;
    if (!video.ended && video.currentTime < config.clipEnd - .02) return;
    if (clipEndedRef.current === sessionKey) return;
    const playback = desiredPlaybackIntent() === "manual" ? "manual" : "hover";
    clipEndedRef.current = sessionKey;
    pendingSeekRef.current = null;
    setCurrentTime(config.clipEnd);
    playbackCallbacksRef.current.onTimeChange?.(config.clipDuration, config.clipDuration);
    if (!config.seamlessClipEnd) video.pause();
    if (playback === "manual" && !config.hasNext) manualPlaybackRef.current = false;
    if (playbackCallbacksRef.current.onClipEnded) playbackCallbacksRef.current.onClipEnded(playback);
    else {
      manualPlaybackRef.current = false;
      playbackCallbacksRef.current.onPlaybackChange?.(false);
      requestSeek(config.clipStart);
    }
  };

  const updateMediaProgress = (video: HTMLVideoElement) => {
    const sessionKey = desiredSessionKeyRef.current;
    if (!mediaMatchesSession(video, sessionKey) || pendingSeekRef.current?.sessionKey === sessionKey) return;
    const config = playbackConfigRef.current;
    if (video.currentTime >= config.clipEnd - .004 || video.ended) {
      finishCurrentClip(video);
      return;
    }
    setCurrentTime(video.currentTime);
    if (!externalScrubRef.current) playbackCallbacksRef.current.onTimeChange?.(Math.max(0, video.currentTime - config.clipStart), config.clipDuration);
  };

  const monitorVideoFrames = (sessionKey = desiredSessionKeyRef.current) => {
    const video = videoRef.current;
    if (!video || sessionKey !== desiredSessionKeyRef.current || !mediaMatchesSession(video, sessionKey) || video.paused || clipEndedRef.current === sessionKey || !("requestVideoFrameCallback" in video)) {
      videoFrameCallbackRef.current = null;
      return;
    }
    updateMediaProgress(video);
    if (video.paused || clipEndedRef.current === sessionKey) {
      videoFrameCallbackRef.current = null;
      return;
    }
    videoFrameCallbackRef.current = video.requestVideoFrameCallback(() => monitorVideoFrames(sessionKey));
  };

  useEffect(() => {
    const video = videoRef.current;
    const sourceUnchanged = loadedSourceRef.current === src && Boolean(src);
    const transitionIntent = desiredPlaybackIntent();
    const generation = mediaGenerationRef.current + 1;
    mediaGenerationRef.current = generation;
    loadedSourceRef.current = src;
    const sessionKey = playbackSessionKey;
    clipEndedRef.current = "";
    clearPlayRetry();
    cancelVideoFrameMonitor();
    const preserveContinuousPlayback = Boolean(video && shouldPreserveContinuousPlayback({
      sourceUnchanged,
      intent: transitionIntent,
      paused: video.paused,
      currentTime: video.currentTime,
      clipStart: safeClipStart,
      clipEnd: safeClipEnd,
    }));
    if (preserveContinuousPlayback && video) {
      pendingSeekRef.current = null;
      setPlaying(true);
      setCurrentTime(video.currentTime);
      monitorVideoFrames(sessionKey);
      return;
    }
    video?.pause();
    setPlaying(false);
    setCurrentTime(safeClipStart);
    pendingSeekRef.current = { sessionKey, time: safeClipStart };
    if (!sourceUnchanged) setDuration(0);
    if (!video || !src) return;
    if (!sourceUnchanged) video.load();
    if (mediaMatchesSession(video, sessionKey) && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      const settled = positionMedia(video, safeClipStart);
      if (settled) {
        pendingSeekRef.current = null;
        window.requestAnimationFrame(() => reconcilePlayback(generation, sessionKey));
      }
    }
    else window.requestAnimationFrame(() => reconcilePlayback(generation, sessionKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackSessionKey, src, safeClipStart, safeClipEnd]);

  const stopPlayback = (suppressHover = true) => {
    playbackBlockedRef.current = true;
    manualPlaybackRef.current = false;
    hoverPreviewRef.current = false;
    hoverSuppressedRef.current = suppressHover;
    clearPlayRetry();
    cancelVideoFrameMonitor();
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
    setPlaying(false);
    playbackCallbacksRef.current.onPlaybackChange?.(false);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const unsubscribe = subscribeToVideoPlaybackClaims(video, () => stopPlayback(true));
    return () => {
      unsubscribe();
      video.pause();
    };
    // Each physical asset owns one foreground element. Adjacent scenes from
    // the same asset continue to share it; changing assets replaces it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const wasActive = previousSelectionActiveRef.current;
    previousSelectionActiveRef.current = selectionActive;
    if (wasActive === true && selectionActive === false) stopPlayback(true);
    // Selection loss is an explicit boundary between canvas playback sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionActive]);

  useEffect(() => {
    const autoPlayStarted = !previousAutoPlayRef.current && autoPlay;
    const stoppedExternally = previousAutoPlayRef.current && !autoPlay;
    let controlledHoverStarted = false;
    previousAutoPlayRef.current = autoPlay;
    if (autoPlay) hoverSuppressedRef.current = false;
    else if (stoppedExternally) {
      manualPlaybackRef.current = false;
    }
    if (typeof hoverActive === "boolean") {
      const entering = hoverActive && !hoverPreviewRef.current;
      controlledHoverStarted = entering;
      hoverPreviewRef.current = hoverActive;
      if (!hoverActive || entering) hoverSuppressedRef.current = false;
    }
    if (hoverSession !== undefined && hoverSessionRef.current !== hoverSession) {
      hoverSessionRef.current = hoverSession;
      hoverSuppressedRef.current = false;
      hoverPreviewRef.current = Boolean(hoverActive) || Boolean(playerRef.current?.matches(":hover"));
    }
    if (autoPlayStarted || controlledHoverStarted) playbackBlockedRef.current = false;
    const frame = window.requestAnimationFrame(reconcilePlayback);
    return () => window.cancelAnimationFrame(frame);
    // Every media readiness event also reconciles the same playback intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, hoverActive, hoverSession, src, safeClipStart, safeClipEnd]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    const action = resolveVideoPlaybackToggle({ paused: video.paused, manualRequested: manualPlaybackRef.current });
    if (action === "start") {
      playbackBlockedRef.current = false;
      hoverSuppressedRef.current = false;
      manualPlaybackRef.current = true;
      clearPlayRetry();
      playbackCallbacksRef.current.onPlaybackChange?.(true);
      reconcilePlayback();
    }
    else {
      manualPlaybackRef.current = false;
      hoverSuppressedRef.current = true;
      playbackCallbacksRef.current.onPlaybackChange?.(false);
      video.pause();
    }
  };

  useEffect(() => {
    if (!requestedPlayback || !shouldApplyVideoPlaybackRequest({
      requestToken: requestedPlayback.token,
      handledToken: requestedPlaybackTokenRef.current,
      targetKey: requestedPlayback.targetKey,
      currentKey: playbackKey,
    })) return;
    // A scene selection updates the node record, lane and player intent in
    // separate React owners. Never let the old scene consume a command that
    // belongs to the media session that is about to replace it.
    const video = videoRef.current;
    if (!video) return;
    requestedPlaybackTokenRef.current = requestedPlayback.token;
    if (Number.isFinite(requestedPlayback.relativeTime)) {
      const nextTime = safeClipStart + Math.min(clipDuration, Math.max(0, Number(requestedPlayback.relativeTime)));
      requestSeek(nextTime);
    }
    if (requestedPlayback.playing) {
      playbackBlockedRef.current = false;
      hoverSuppressedRef.current = false;
      manualPlaybackRef.current = true;
      clearPlayRetry();
      playbackCallbacksRef.current.onPlaybackChange?.(true);
      reconcilePlayback();
    } else {
      manualPlaybackRef.current = false;
      hoverSuppressedRef.current = true;
      playbackCallbacksRef.current.onPlaybackChange?.(false);
      video.pause();
    }
    // The request is an explicit edge-triggered command from the owning stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackKey, requestedPlayback]);

  useEffect(() => {
    if (!keyboardActive) return;
    const toggleWithSpace = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      togglePlayback();
    };
    window.addEventListener("keydown", toggleWithSpace, true);
    return () => window.removeEventListener("keydown", toggleWithSpace, true);
    // The listener always belongs to this mounted playback session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardActive]);

  const controls = <div className={`${controlsPlacement === "external" ? "video-scene-transport" : `inline-video-controls inline-video-controls-${controlsPlacement}`} ${src ? "" : "is-media-empty"} nodrag nopan nowheel`} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button type="button" aria-label={playing ? "Pause video" : "Play video"} disabled={!src} onClick={(event) => { event.preventDefault(); event.stopPropagation(); togglePlayback(); }}>{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</button>
    <input
      className={controlsPlacement === "external" ? "video-scene-position-slider" : undefined}
      type="range"
      min="0"
      max={Math.max(displayedDuration, 0.01)}
      step={controlsPlacement === "external" ? "any" : "0.01"}
      value={Math.min(displayedTime, Math.max(displayedDuration, 0.01))}
      aria-label="Video position"
      aria-valuetext={`${formatVideoTime(displayedTime)} of ${formatVideoTime(displayedDuration)}`}
      style={{ "--video-progress": `${progress}%` } as CSSProperties}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (controlsPlacement !== "external") return;
        externalScrubRef.current = true;
        if (externalScrubReleaseTimerRef.current !== null) window.clearTimeout(externalScrubReleaseTimerRef.current);
        externalScrubReleaseTimerRef.current = null;
        setExternalScrubTime(displayedTime);
        event.currentTarget.setPointerCapture(event.pointerId);
        videoRef.current?.pause();
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        externalScrubRef.current = false;
        reconcilePlayback();
        externalScrubReleaseTimerRef.current = window.setTimeout(() => {
          externalScrubReleaseTimerRef.current = null;
          setExternalScrubTime(null);
        }, 80);
      }}
      onPointerCancel={(event) => {
        event.stopPropagation();
        externalScrubRef.current = false;
        setExternalScrubTime(null);
      }}
      onBlur={() => {
        if (!externalScrubRef.current) return;
        externalScrubRef.current = false;
        setExternalScrubTime(null);
      }}
      onInput={(event) => {
        const nextTime = Number(event.currentTarget.value);
        if (!Number.isFinite(nextTime)) return;
        if (controlsPlacement === "external" && onExternalSeek) {
          if (externalScrubRef.current) setExternalScrubTime(nextTime);
          onExternalSeek(nextTime);
        }
        else {
          requestSeek(safeClipStart + nextTime);
        }
      }}
    />
    {controlsPlacement === "external"
      ? <code>{formatPreciseVideoTime(displayedTime)} <i>/</i> {formatPreciseVideoTime(displayedDuration)}</code>
      : <span>{formatVideoTime(relativeTime)} <i>/</i> {formatVideoTime(clipDuration)}</span>}
    <button type="button" aria-label={muted ? "Unmute video" : "Mute video"} disabled={!src} onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextMuted = !muted;
      setMuted(nextMuted);
      if (videoRef.current) videoRef.current.muted = nextMuted;
    }}>{muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
    {controlsPlacement === "external" && externalActions}
  </div>;

  return <div
    ref={playerRef}
    className={`inline-video-player inline-video-${variant} controls-${controlsPlacement} ${playing ? "is-playing" : "is-paused"}`}
    onMouseEnter={(event) => {
      if (!event.currentTarget.contains(event.target as Node)) return;
      const localHoverCanStart = typeof hoverActive !== "boolean" || hoverSession !== undefined;
      hoverPreviewRef.current = localHoverCanStart;
      if (localHoverCanStart) hoverSuppressedRef.current = false;
      reconcilePlayback();
    }}
    onMouseLeave={(event) => {
      if (!event.currentTarget.contains(event.target as Node)) return;
      hoverPreviewRef.current = false;
      if (typeof hoverActive !== "boolean") hoverSuppressedRef.current = false;
      reconcilePlayback();
    }}
    onClick={(event) => {
      if (!clickToToggle) return;
      const target = event.target as HTMLElement;
      if (target.closest("button,input,textarea,select,a,[role='slider']")) return;
      event.preventDefault();
      event.stopPropagation();
      togglePlayback();
    }}
    onDoubleClick={(event) => { event.stopPropagation(); onDoubleClick?.(); }}
  >
    {blurBackdrop && backdropUrl && <span className="inline-video-backdrop" style={{ backgroundImage: `url("${assetThumbnailUrl(backdropUrl)}")` }} aria-hidden="true" />}
    <video
      key={src}
      ref={videoRef}
      src={src ? assetDirectUrl(src) : undefined}
      muted={muted}
      playsInline
      preload="metadata"
      draggable={false}
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        const sessionKey = desiredSessionKeyRef.current;
        if (!mediaMatchesSession(video, sessionKey)) return;
        const sourceDuration = Number.isFinite(video.duration) ? video.duration : 0;
        setDuration(sourceDuration);
        const targetTime = loadedMediaTarget(video, sessionKey);
        const settled = positionMedia(video, targetTime);
        const pendingSeek = pendingSeekRef.current;
        if (settled && pendingSeek?.sessionKey === sessionKey && Math.abs(pendingSeek.time - video.currentTime) <= .12) {
          pendingSeekRef.current = null;
          reconcilePlayback(mediaGenerationRef.current, sessionKey);
        }
        if (video.videoWidth > 0 && video.videoHeight > 0) onAspectRatio?.(video.videoWidth / video.videoHeight);
      }}
      onLoadedData={(event) => {
        const video = event.currentTarget;
        const sessionKey = desiredSessionKeyRef.current;
        if (!mediaMatchesSession(video, sessionKey)) return;
        const targetTime = loadedMediaTarget(video, sessionKey);
        const settled = positionMedia(video, targetTime);
        if (settled) {
          const pendingSeek = pendingSeekRef.current;
          if (pendingSeek?.sessionKey === sessionKey && Math.abs(pendingSeek.time - video.currentTime) <= .12) pendingSeekRef.current = null;
          reconcilePlayback(mediaGenerationRef.current, sessionKey);
        }
      }}
      onCanPlay={(event) => {
        const video = event.currentTarget;
        const sessionKey = desiredSessionKeyRef.current;
        if (!mediaMatchesSession(video, sessionKey)) return;
        const targetTime = loadedMediaTarget(video, sessionKey);
        const settled = positionMedia(video, targetTime);
        if (settled) {
          const pendingSeek = pendingSeekRef.current;
          if (pendingSeek?.sessionKey === sessionKey && Math.abs(pendingSeek.time - video.currentTime) <= .12) pendingSeekRef.current = null;
          reconcilePlayback(mediaGenerationRef.current, sessionKey);
        }
      }}
      onSeeked={(event) => {
        const video = event.currentTarget;
        const sessionKey = desiredSessionKeyRef.current;
        if (!mediaMatchesSession(video, sessionKey)) return;
        const pendingSeek = pendingSeekRef.current;
        if (pendingSeek?.sessionKey !== sessionKey) return;
        if (resolvePendingSeek({ pendingTime: pendingSeek.time, currentTime: video.currentTime, seeking: video.seeking }) === "retry") {
          positionMedia(video, pendingSeek.time);
          return;
        }
        pendingSeekRef.current = null;
        clearPlayRetry();
        setCurrentTime(video.currentTime);
        const config = playbackConfigRef.current;
        if (!externalScrubRef.current) playbackCallbacksRef.current.onTimeChange?.(Math.max(0, video.currentTime - config.clipStart), config.clipDuration);
        reconcilePlayback(mediaGenerationRef.current, sessionKey);
      }}
      onDurationChange={(event) => {
        if (!mediaMatchesSession(event.currentTarget)) return;
        setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
      }}
      onTimeUpdate={(event) => updateMediaProgress(event.currentTarget)}
      onPlay={(event) => {
        const video = event.currentTarget;
        const sessionKey = desiredSessionKeyRef.current;
        if (playbackBlockedRef.current || !desiredPlaybackIntent() || !mediaMatchesSession(video, sessionKey)) {
          video.pause();
          return;
        }
        const pendingSeek = pendingSeekRef.current;
        if (pendingSeek?.sessionKey === sessionKey) {
          const resolution = resolvePendingSeek({ pendingTime: pendingSeek.time, currentTime: video.currentTime, seeking: video.seeking });
          if (resolution === "settled") pendingSeekRef.current = null;
          else {
            video.pause();
            reconcilePlayback(mediaGenerationRef.current, sessionKey);
            return;
          }
        }
        claimVideoPlayback(event.currentTarget);
        clipEndedRef.current = "";
        clearPlayRetry();
        setPlaying(true);
        cancelVideoFrameMonitor();
        monitorVideoFrames(sessionKey);
      }}
      onPause={(event) => {
        cancelVideoFrameMonitor();
        if (mediaMatchesSession(event.currentTarget)) setPlaying(false);
      }}
      onEnded={(event) => finishCurrentClip(event.currentTarget)}
    />
    {preloadSrc && preloadSrc !== src && <video
      className="inline-video-preload"
      src={assetDirectUrl(preloadSrc)}
      muted
      playsInline
      preload="none"
      draggable={false}
      aria-hidden="true"
      onLoadedMetadata={(event) => {
        const target = Math.max(0, Number(preloadStart || 0));
        if (Math.abs(event.currentTarget.currentTime - target) > .01) event.currentTarget.currentTime = target;
      }}
    />}
    <div className="inline-video-shade" aria-hidden="true" />
    {controlsPlacement === "external" ? (controlsPortal ? createPortal(controls, controlsPortal) : null) : controls}
  </div>;
}

export function VideoMasterTimeline({ clips, selectedClipId, selectedLane, currentTime, laneVisibility, onToggleLane, onSelect, onSeek, onReorder, onMoveLane, onCopyOutput, onAddGenerated, onUpload }: {
  clips: VideoMasterClip[];
  selectedClipId?: string;
  selectedLane: "output" | "original";
  currentTime: number;
  laneVisibility: { output: boolean; original: boolean };
  onToggleLane: (lane: "output" | "original") => void;
  onSelect: (clip: VideoMasterClip, lane: "output" | "original") => void;
  onSeek: (time: number) => void;
  onReorder: (clips: VideoMasterClip[]) => void;
  onMoveLane: (clip: VideoMasterClip, lane: "output" | "original") => void;
  onCopyOutput: (sourceClip: VideoMasterClip, targetClipId: string) => void;
  onAddGenerated: () => void;
  onUpload: (files: File[]) => void;
}) {
  const [draggedClip, setDraggedClip] = useState<{ id: string; lane: "output" | "original" } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; lane: "output" | "original" } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dragPreviewTime, setDragPreviewTime] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const playheadSurfaceRef = useRef<HTMLDivElement>(null);
  const playheadDragRef = useRef<number | null>(null);
  const playheadSeekFrameRef = useRef<number | null>(null);
  const playheadSeekXRef = useRef(0);
  const zoomRef = useRef(1);
  const playbackDurations = clips.map((clip) => videoMasterClipPlaybackMedia(clip, selectedLane, laneVisibility).duration);
  const totalDuration = Math.max(.1, playbackDurations.reduce((sum, duration) => sum + duration, 0));
  const playheadTime = Math.min(totalDuration, Math.max(0, dragPreviewTime ?? currentTime));
  const playheadProgress = Math.min(100, Math.max(0, playheadTime / totalDuration * 100));
  const rulerTickCount = Math.max(7, Math.min(145, Math.ceil(6 * zoom) + 1));
  const rulerTicks = Array.from({ length: rulerTickCount }, (_, index) => ({
    left: index / Math.max(1, rulerTickCount - 1) * 100,
    time: index / Math.max(1, rulerTickCount - 1) * totalDuration,
  }));

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const cursorX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
        const currentWidth = Math.max(1, viewport.scrollWidth);
        const anchor = (viewport.scrollLeft + cursorX) / currentWidth;
        const factor = Math.max(.82, Math.min(1.22, Math.exp(-event.deltaY * .0025)));
        const nextZoom = Math.max(1, Math.min(24, zoomRef.current * factor));
        if (Math.abs(nextZoom - zoomRef.current) < .001) return;
        zoomRef.current = nextZoom;
        setZoom(nextZoom);
        requestAnimationFrame(() => { viewport.scrollLeft = Math.max(0, anchor * viewport.scrollWidth - cursorX); });
        return;
      }
      if (zoomRef.current > 1) {
        event.preventDefault();
        viewport.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => () => {
    if (playheadSeekFrameRef.current !== null) window.cancelAnimationFrame(playheadSeekFrameRef.current);
  }, []);

  const beginDrag = (clip: VideoMasterClip, lane: "output" | "original", event: ReactDragEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setDraggedClip({ id: clip.id, lane });
    setDropTarget({ id: clip.id, lane });
    onSelect(clip, lane);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("application/x-scenelith-master-clip", clip.id);
    event.dataTransfer.setData("application/x-scenelith-master-lane", lane);
    event.dataTransfer.setData("text/plain", clip.id);
  };
  const drop = (targetClipId: string, targetLane: "output" | "original", event: ReactDragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceClipId = event.dataTransfer.getData("application/x-scenelith-master-clip") || draggedClip?.id;
    const sourceLane = (event.dataTransfer.getData("application/x-scenelith-master-lane") || draggedClip?.lane) as "output" | "original" | undefined;
    if (!sourceClipId) {
      setDraggedClip(null);
      setDropTarget(null);
      return;
    }
    const sourceClip = clips.find((clip) => clip.id === sourceClipId);
    if (sourceClip && sourceLane === "output" && targetLane === "output" && sourceClipId !== targetClipId) {
      onCopyOutput(sourceClip, targetClipId);
      setDraggedClip(null);
      setDropTarget(null);
      return;
    }
    if (sourceClip && sourceClipId === targetClipId && sourceLane && sourceLane !== targetLane) {
      onMoveLane(sourceClip, targetLane);
      onSelect(sourceClip, targetLane);
      setDraggedClip(null);
      setDropTarget(null);
      return;
    }
    if (sourceClipId === targetClipId) {
      setDraggedClip(null);
      setDropTarget(null);
      return;
    }
    const sourceIndex = clips.findIndex((clip) => clip.id === sourceClipId);
    const targetIndex = clips.findIndex((clip) => clip.id === targetClipId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...clips];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    onReorder(next);
    setDraggedClip(null);
    setDropTarget(null);
  };
  const finishDrag = () => {
    setDraggedClip(null);
    setDropTarget(null);
  };
  const playheadTimeAt = (clientX: number) => {
    const surface = playheadSurfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))) * totalDuration;
  };
  const seekPlayheadAt = (clientX: number) => {
    const nextTime = playheadTimeAt(clientX);
    if (nextTime === null) return;
    setDragPreviewTime(nextTime);
    onSeek(nextTime);
  };
  const queuePlayheadSeek = (clientX: number) => {
    playheadSeekXRef.current = clientX;
    if (playheadSeekFrameRef.current !== null) return;
    playheadSeekFrameRef.current = window.requestAnimationFrame(() => {
      playheadSeekFrameRef.current = null;
      seekPlayheadAt(playheadSeekXRef.current);
    });
  };
  const beginPlayheadDrag = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    playheadDragRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const nextTime = playheadTimeAt(event.clientX);
    if (nextTime !== null) setDragPreviewTime(nextTime);
    queuePlayheadSeek(event.clientX);
  };
  const movePlayhead = (event: ReactPointerEvent<HTMLElement>) => {
    if (playheadDragRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    queuePlayheadSeek(event.clientX);
  };
  const finishPlayheadDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (playheadDragRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (playheadSeekFrameRef.current !== null) {
      window.cancelAnimationFrame(playheadSeekFrameRef.current);
      playheadSeekFrameRef.current = null;
    }
    seekPlayheadAt(event.clientX);
    playheadDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    window.requestAnimationFrame(() => setDragPreviewTime(null));
  };
  const media = (clip: VideoMasterClip, lane: "output" | "original") => {
    const outputUrl = String(clip.outputUrl || (clip.origin === "upload" ? clip.sourceUrl : "") || "");
    const url = lane === "output" ? outputUrl : clip.origin === "upload" ? "" : String(clip.sourceUrl || "");
    const thumbnail = url ? videoMasterClipThumbnail(clip, lane) : undefined;
    if (thumbnail) {
      const thumbnailUrl = assetThumbnailUrl(thumbnail);
      const frames = Math.max(2, Math.min(14, Math.ceil(Math.max(.1, Number(clip.duration || 0)) * 1.55)));
      return <span className="video-scene-filmstrip video-master-clip-filmstrip" aria-hidden="true">{Array.from({ length: frames }, (_, frameIndex) => <i key={frameIndex} style={{ backgroundImage: `url("${thumbnailUrl}")` }} />)}</span>;
    }
    if (url) return <span className="video-scene-filmstrip video-master-clip-filmstrip is-video-placeholder" aria-hidden="true"><Video size={15} /></span>;
    return <span className="video-master-lane-empty">{lane === "output" ? "Not generated" : "No source"}</span>;
  };
  const clipButton = (clip: VideoMasterClip, index: number, lane: "output" | "original") => {
    const start = playbackDurations.slice(0, index).reduce((sum, duration) => sum + duration, 0);
    const clipDuration = playbackDurations[index] || Math.max(.1, Number(clip.duration || 0));
    return <button
      type="button"
      key={`${lane}:${clip.id}`}
      className={`video-master-lane-clip nodrag nopan is-${lane} ${selectedClipId === clip.id && selectedLane === lane ? "is-selected" : ""} ${draggedClip?.id === clip.id && draggedClip.lane === lane ? "is-dragging" : ""} ${dropTarget?.id === clip.id && dropTarget.lane === lane && (draggedClip?.id !== clip.id || draggedClip.lane !== lane) ? "is-drop-target" : ""}`}
      data-master-clip-id={clip.id}
      style={{ left: `${start / totalDuration * 100}%`, width: `${clipDuration / totalDuration * 100}%` }}
      aria-pressed={selectedClipId === clip.id && selectedLane === lane}
      draggable
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        // Select before a draggable button can turn the gesture into a drag and
        // suppress `click`. This is also what makes a single tap deterministic
        // inside the transformed canvas and the fullscreen timeline.
        event.preventDefault();
        onSelect(clip, lane);
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // Pointer selection already happened on pointerdown. Keep keyboard
        // activation accessible without issuing a second playback command.
        if (event.detail === 0) onSelect(clip, lane);
      }}
      onDragStart={(event) => beginDrag(clip, lane, event)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = draggedClip?.lane === "output" && lane === "output" && draggedClip.id !== clip.id ? "copy" : "move";
        setDropTarget({ id: clip.id, lane });
      }}
      onDragEnter={(event) => { event.preventDefault(); setDropTarget({ id: clip.id, lane }); }}
      onDrop={(event) => drop(clip.id, lane, event)}
      onDragEnd={finishDrag}
      title={lane === "output" && clip.outputUrl
        ? `Scene ${String(index + 1).padStart(2, "0")} · drag onto another output scene to use this clip there`
        : clip.origin === "upload" && lane === "output"
          ? `Scene ${String(index + 1).padStart(2, "0")} · drag down to use as reference`
          : `Scene ${String(index + 1).padStart(2, "0")} · drag to reorder`}
    >
      {media(clip, lane)}
      <span className="video-master-lane-meta"><strong>{String(index + 1).padStart(2, "0")}</strong><small>{clipDuration.toFixed(1)}s</small></span>
    </button>;
  };

  return <div className="video-master-timeline video-scene-timeline-surface nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()}>
    <div
      ref={viewportRef}
      className="video-master-timeline-viewport video-scene-timeline-viewport"
    >
      <div
        className="video-master-timeline-canvas video-scene-timeline-canvas"
        style={{ width: `${zoom * 100}%` }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest(".video-master-lane-clip,.video-master-lane-label,.video-master-playhead")) return;
          beginPlayheadDrag(event);
        }}
        onPointerMove={movePlayhead}
        onPointerUp={finishPlayheadDrag}
        onPointerCancel={finishPlayheadDrag}
      >
        <div className="video-master-ruler video-scene-ruler" aria-hidden="true">
          {rulerTicks.map((tick) => <span key={tick.left} style={{ left: `${tick.left}%` }}><i />{formatTimelineRulerTime(tick.time)}</span>)}
        </div>
        <div className={`video-master-lane-row ${laneVisibility.output ? "is-visible" : "is-hidden"}`}>
          <button type="button" className="video-master-lane-label" aria-label={`${laneVisibility.output ? "Hide" : "Show"} output track`} aria-pressed={laneVisibility.output} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggleLane("output"); }}>{laneVisibility.output ? <Eye size={11} /> : <EyeOff size={11} />}<span>OUTPUT</span></button>
          <div className="video-master-lane-track video-scene-track">{clips.map((clip, index) => clipButton(clip, index, "output"))}</div>
        </div>
        <div className={`video-master-lane-row ${laneVisibility.original ? "is-visible" : "is-hidden"}`}>
          <button type="button" className="video-master-lane-label" aria-label={`${laneVisibility.original ? "Hide" : "Show"} original track`} aria-pressed={laneVisibility.original} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggleLane("original"); }}>{laneVisibility.original ? <Eye size={11} /> : <EyeOff size={11} />}<span>ORIGINAL</span></button>
          <div className="video-master-lane-track video-scene-track">{clips.map((clip, index) => clipButton(clip, index, "original"))}</div>
        </div>
        <div ref={playheadSurfaceRef} className="video-master-playhead-surface">
          <button
            type="button"
            role="slider"
            className={`video-master-playhead nodrag nopan ${playheadProgress <= .001 ? "is-start" : ""} ${playheadProgress >= 99.999 ? "is-end" : ""}`}
            style={{ "--master-playhead": `${playheadProgress}%` } as CSSProperties}
            aria-label="Timeline playhead"
            aria-valuemin={0}
            aria-valuemax={totalDuration}
            aria-valuenow={playheadTime}
            aria-valuetext={`${formatPreciseVideoTime(playheadTime)} of ${formatPreciseVideoTime(totalDuration)}`}
            title="Drag to seek"
            onPointerDown={beginPlayheadDrag}
            onPointerMove={movePlayhead}
            onPointerUp={finishPlayheadDrag}
            onPointerCancel={finishPlayheadDrag}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Home") onSeek(0);
              else if (event.key === "End") onSeek(totalDuration);
              else onSeek(playheadTime + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? .001 : 1 / 30));
            }}
          />
        </div>
      </div>
    </div>
    <div className="video-master-add-actions"><button type="button" onClick={onAddGenerated}><Plus size={13} />New scene</button><label><Upload size={13} />Add video<input type="file" accept=".mp4,.mov,.webm,.m4v,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; if (files.length) onUpload(files); }} /></label><small>⌘ + wheel zoom · wheel scroll <b>{Math.round(zoom * 100)}%</b></small></div>
  </div>;
}

function videoMasterLegacyOrder(clip: VideoMasterClip, fallback: number) {
  const match = clip.title.match(/(?:scene|slide)\s*0*(\d+)/i);
  return match ? Math.max(0, Number(match[1]) - 1) : fallback;
}

export const generatorReferenceRoleLabels: Record<string, string> = {
  "start-frame": "Start image",
  "end-frame": "End image",
  "reference-image": "Reference image",
  "reference-video": "Reference video",
  "motion-video": "Reference video",
  "reference-audio": "Audio input",
};

export function AssistantGlyph({ size = 14 }: { size?: number }) {
  return <svg className="assistant-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M8.2 1.8c.45 3.72 2.18 5.45 5.9 5.9-3.72.45-5.45 2.18-5.9 5.9-.45-3.72-2.18-5.45-5.9-5.9 3.72-.45 5.45-2.18 5.9-5.9Z" />
    <path fill="currentColor" d="M17.15 11.45c.3 2.55 1.5 3.75 4.05 4.05-2.55.3-3.75 1.5-4.05 4.05-.3-2.55-1.5-3.75-4.05-4.05 2.55-.3 3.75-1.5 4.05-4.05Z" />
  </svg>;
}

export function GeneratorReferencePreview({ reference, compact = false }: { reference: GeneratorReference; compact?: boolean }) {
  if (compact) {
    const ratio = Number.isFinite(reference.aspectRatio) && Number(reference.aspectRatio) > 0
      ? Math.min(2.4, Math.max(.42, Number(reference.aspectRatio)))
      : 1;
    const isVideo = reference.role === "reference-video" || reference.role === "motion-video";
    const isAudio = reference.role === "reference-audio";
    return <span className={`generator-reference-compact-preview ${isVideo ? "is-video" : isAudio ? "is-audio" : "is-image"}`} style={{ aspectRatio: ratio } as CSSProperties}>
      {isAudio
        ? <Volume2 size={15} />
        : reference.thumbnailUrl
          ? <img src={assetThumbnailUrl(reference.thumbnailUrl)} alt="" loading="eager" decoding="async" />
          : isVideo && reference.url
            ? <img src={assetThumbnailUrl(reference.url)} alt="" loading="lazy" decoding="async" />
            : <img src={assetThumbnailUrl(reference.url)} alt="" loading="lazy" decoding="async" />}
    </span>;
  }
  if (reference.role === "reference-video" || reference.role === "motion-video") return <span className={`generator-reference-media-icon ${reference.thumbnailUrl ? "has-thumbnail" : reference.url ? "has-video" : ""}`}>{reference.thumbnailUrl
    ? <img src={assetThumbnailUrl(reference.thumbnailUrl)} alt="" loading="lazy" decoding="async" />
    : reference.url ? <img src={assetThumbnailUrl(reference.url)} alt="" loading="lazy" decoding="async" /> : null}<Video size={14} /></span>;
  if (reference.role === "reference-audio") return <span className="generator-reference-media-icon"><Volume2 size={14} /></span>;
  return <img src={assetThumbnailUrl(reference.url)} alt="" loading="lazy" decoding="async" />;
}
export type GeneratorNodeActions = {
  models: GeneratorModelOption[];
  personas: PersonaRecord[];
  selectNode: (nodeId: string) => void;
  focusMasterClipSource: (nodeId: string, clipId: string) => void;
  updateNode: (nodeId: string, data: Partial<FrameNode["data"]>) => void;
  saveNow: (nodeId?: string, data?: Partial<FrameNode["data"]>) => void;
  composePrompt: (nodeId: string, brief: string) => Promise<string>;
  composeMasterPrompt: (nodeId: string, clipId: string, brief: string) => Promise<string>;
  generateNode: (nodeId: string) => void;
  generateMasterClip: (nodeId: string, clipId: string) => void;
  updateMasterClipModel: (nodeId: string, clipId: string, modelId: string) => void;
  removeMasterClip: (nodeId: string, clipId: string) => void;
  uploadMasterClips: (nodeId: string, files: File[]) => void;
  runAssistant: (nodeId: string) => void;
  generateChain: (nodeId: string) => void;
  captureVideoFrame: (nodeId: string, time: number) => Promise<void>;
  extractVideoSegment: (nodeId: string, segment: VideoSceneSegment, clientX: number, clientY: number) => void;
  openPreview: (nodeId: string, media?: { url: string; start?: number; end?: number; title?: string }) => void;
  downloadMasterMedia: (nodeId: string, lane: VideoMasterDownloadLane, scope: "scene" | "video") => Promise<boolean>;
  openEdit: (nodeId: string) => void;
  addToIdentity: (personaId: string, role: "reference" | "before" | "after", sourceAssetId: string) => Promise<{ alreadyAdded?: boolean }>;
  createIdentityFromAsset: (name: string, role: "reference" | "before" | "after", sourceAssetId: string) => Promise<void>;
  deleteNode: (nodeId: string) => void;
  hasDownstreamGenerator: (nodeId: string) => boolean;
  disconnectReference: (nodeId: string, sourceNodeId: string, edgeId?: string) => void;
  getReferences: (nodeId: string, masterClipId?: string) => GeneratorReference[];
  getTextInput: (nodeId: string) => { title: string; text: string } | null;
  generatingNodeIds: string[];
  preparingMasterClipIds: Record<string, string>;
  generationConcurrency: number;
  queueLabel: string;
  runningAssistantNodeId: string | null;
  activePreviewNodeId: string | null;
};
export const GeneratorNodeContext = createContext<GeneratorNodeActions | null>(null);

const icons = {
  source: Clapperboard,
  scene: ImageIcon,
  persona: UserRound,
  hook: Quote,
  prompt: FileText,
  assistant: AssistantGlyph,
  generation: Sparkles,
  videoMaster: Clapperboard,
  note: StickyNote,
};

export const OPEN_NODE_CREATOR_EVENT = "frameflow:open-node-creator";
export const OPEN_VIDEO_EDITOR_EVENT = "scenelith:open-video-editor";

export type SelectOption = { value: string; label: string; description?: string; glyphValue?: string };

export function RatioGlyph({ value }: { value: string }) {
  if (value === "original") return <span className="generator-ratio-glyph is-original" aria-hidden="true"><i /><i /></span>;
  if (value === "auto" || value === "adaptive") return <span className="generator-ratio-glyph is-original" aria-hidden="true"><i /></span>;
  const [width, height] = value.split(":").map(Number);
  const ratio = width > 0 && height > 0 ? width / height : 1;
  const longSide = 13;
  const glyphWidth = ratio >= 1 ? longSide : Math.max(4, longSide * ratio);
  const glyphHeight = ratio >= 1 ? Math.max(4, longSide / ratio) : longSide;
  return <span className="generator-ratio-glyph" aria-hidden="true"><i style={{ width: glyphWidth, height: glyphHeight }} /></span>;
}

export function nearestSupportedRatio(width: number, height: number, ratios: string[]) {
  const numericRatios = ratios.filter((ratio) => /^\d+:\d+$/.test(ratio));
  const original = width / height;
  return numericRatios.reduce((best, ratio) => {
    const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
    const [bestWidth, bestHeight] = best.split(":").map(Number);
    return Math.abs(Math.log((ratioWidth / ratioHeight) / original)) < Math.abs(Math.log((bestWidth / bestHeight) / original)) ? ratio : best;
  }, numericRatios[0] || "1:1");
}

function readImageRatio(url: string, ratios: string[]) {
  return new Promise<string>((resolve) => {
    const image = new window.Image();
    image.onload = () => resolve(nearestSupportedRatio(image.naturalWidth, image.naturalHeight, ratios));
    image.onerror = () => resolve(ratios[0] || "1:1");
    image.src = url;
  });
}

const OUTPUT_IMAGE_LOAD_ATTEMPTS = 5;
const OUTPUT_IMAGE_RETRY_WINDOW_MS = 2 * 60 * 1000;
const OUTPUT_IMAGE_FAILURE_CACHE_LIMIT = 2_000;
const outputImageFailures = new Map<string, number>();

function rememberOutputImageFailure(url: string, attempts: number) {
  // The cache intentionally outlives individual node mounts so virtualized
  // nodes do not restart failed requests whenever they leave and re-enter the
  // viewport. Keep it bounded for long-lived canvases that visit many assets.
  outputImageFailures.delete(url);
  outputImageFailures.set(url, attempts);
  while (outputImageFailures.size > OUTPUT_IMAGE_FAILURE_CACHE_LIMIT) {
    const oldestUrl = outputImageFailures.keys().next().value;
    if (typeof oldestUrl !== "string") break;
    outputImageFailures.delete(oldestUrl);
  }
}

function outputImageUrlForAttempt(url: string, attempt: number) {
  const thumbnailUrl = assetThumbnailUrl(url);
  if (!attempt) return thumbnailUrl;
  return `${thumbnailUrl}${thumbnailUrl.includes("?") ? "&" : "?"}scenelithLoadRetry=${attempt}`;
}

export function GeneratorSelect({ menuKey, openMenu, setOpenMenu, value, options, label, className = "", onChange }: { menuKey: string; openMenu: string | null; setOpenMenu: Dispatch<SetStateAction<string | null>>; value: string; options: SelectOption[]; label: string; className?: string; onChange: (value: string) => void }) {
  const open = openMenu === menuKey;
  const selected = options.find((option) => option.value === value) || options[0];
  const showsRatioGlyph = menuKey === "ratio" || menuKey.startsWith("master-ratio-");
  return <div className={`generator-select ${open ? "is-open" : ""} ${className} nodrag nopan`} onPointerDown={(event) => event.stopPropagation()}>
    <button type="button" className="generator-select-trigger" aria-label={label} aria-expanded={open} onPointerDown={(event) => { event.stopPropagation(); setOpenMenu(open ? null : menuKey); }}><span className="generator-select-value">{showsRatioGlyph && <RatioGlyph value={selected?.glyphValue || selected?.value || value} />}<strong>{selected?.label || value}</strong></span><ChevronDown size={13} /></button>
    {open && <div className="generator-select-menu" onWheel={(event) => event.stopPropagation()}>
      <div className="generator-select-label">{label}</div>
      <div className="generator-select-scroll nowheel" onWheelCapture={(event) => event.stopPropagation()}>
        {options.map((option) => <button key={option.value} type="button" className={option.value === value ? "is-selected" : ""} onPointerDown={(event) => {
          event.stopPropagation();
          onChange(option.value);
          setOpenMenu(null);
        }}>
          <span className="generator-option-main">{showsRatioGlyph && <RatioGlyph value={option.glyphValue || option.value} />}<span>{option.label}{option.description && <small>{option.description}</small>}</span></span>
          {option.value === value && <Check size={13} />}
        </button>)}
      </div>
    </div>}
  </div>;
}

export function VideoMasterGenerationControls({ clipId, openMenu, setOpenMenu, modelValue, modelOptions, onModelChange, ratioValue, ratioOptions = [], onRatioChange, durationValue, durationOptions = [], onDurationChange, qualityValue, qualityOptions = [], onQualityChange, assistantActive = false, onAssistant, supportsAudio = false, audioEnabled = false, onToggleAudio, runDisabled = false, runTitle, runBusy = false, onRun, demoAssistantClick = false, demoRunClick = false, className = "" }: {
  clipId: string;
  openMenu: string | null;
  setOpenMenu: Dispatch<SetStateAction<string | null>>;
  modelValue: string;
  modelOptions: SelectOption[];
  onModelChange: (value: string) => void;
  ratioValue?: string;
  ratioOptions?: SelectOption[];
  onRatioChange?: (value: string) => void;
  durationValue?: string;
  durationOptions?: SelectOption[];
  onDurationChange?: (value: string) => void;
  qualityValue?: string;
  qualityOptions?: SelectOption[];
  onQualityChange?: (value: string) => void;
  assistantActive?: boolean;
  onAssistant?: () => void;
  supportsAudio?: boolean;
  audioEnabled?: boolean;
  onToggleAudio?: () => void;
  runDisabled?: boolean;
  runTitle?: string;
  runBusy?: boolean;
  onRun: () => void;
  demoAssistantClick?: boolean;
  demoRunClick?: boolean;
  className?: string;
}) {
  return <div className={`generator-node-controls video-master-generator-controls nodrag nopan ${className}`} onPointerDown={(event) => event.stopPropagation()}>
    <div className="video-master-controls-left">
      <GeneratorSelect menuKey={`master-model-${clipId}`} openMenu={openMenu} setOpenMenu={setOpenMenu} className="generator-model-control" value={modelValue} label="VIDEO MODELS" options={modelOptions} onChange={onModelChange} />
      {ratioValue && ratioOptions.length > 0 && onRatioChange && <GeneratorSelect menuKey={`master-ratio-${clipId}`} openMenu={openMenu} setOpenMenu={setOpenMenu} className="generator-ratio-control" value={ratioValue} label="RATIO" options={ratioOptions} onChange={onRatioChange} />}
      {durationValue && durationOptions.length > 0 && onDurationChange && <GeneratorSelect menuKey={`master-duration-${clipId}`} openMenu={openMenu} setOpenMenu={setOpenMenu} className="generator-duration-control" value={durationValue} label="GENERATE" options={durationOptions} onChange={onDurationChange} />}
    </div>
    <div className="video-master-controls-right">
      {qualityValue && qualityOptions.length > 0 && onQualityChange && <GeneratorSelect menuKey={`master-quality-${clipId}`} openMenu={openMenu} setOpenMenu={setOpenMenu} className="generator-quality-control" value={qualityValue} label="QUALITY" options={qualityOptions} onChange={onQualityChange} />}
      {onAssistant && <button type="button" className={`generator-assistant-trigger generator-assistant-control ${assistantActive ? "is-active" : ""} ${demoAssistantClick ? "is-demo-clicking" : ""}`} aria-label="Open scene prompt assistant" title="Scene prompt assistant" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpenMenu(null); onAssistant(); }}><AssistantGlyph size={13} />{demoAssistantClick && <i className="landing-node-demo-pointer is-control" aria-hidden="true"><MousePointer2 size={17} /></i>}</button>}
      {supportsAudio && onToggleAudio && <button type="button" className={`generator-sound-control ${audioEnabled ? "is-on" : ""}`} title={audioEnabled ? "Generated audio on" : "Generated audio off"} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onToggleAudio(); }}>{audioEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}</button>}
      <div className={`generator-run-control ${demoRunClick ? "is-demo-clicking" : ""}`}><span role="tooltip" className="generator-credit-tooltip">{runTitle || "Run generation"}</span><button className="generator-run" disabled={runDisabled} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpenMenu(null); onRun(); }}>{runBusy ? <span className="generator-spinner" /> : <Play size={15} fill="currentColor" />}</button>{demoRunClick && <i className="landing-node-demo-pointer is-control" aria-hidden="true"><MousePointer2 size={17} /></i>}</div>
    </div>
  </div>;
}

function FrameNodeCardComponent({ id, data, selected }: NodeProps<FrameNode>) {
  const generator = useContext(GeneratorNodeContext);
  const previewOwnsPlayback = generator?.activePreviewNodeId === id;
  const videoMasterPlaybackOwnerId = `video-master:${id}`;
  const videoMasterProgressStore = useMemo(() => ({
    subscribe: (listener: () => void) => videoPlaybackManager.subscribeProgress(videoMasterPlaybackOwnerId, listener),
    getSnapshot: () => videoPlaybackManager.getProgressSnapshot(videoMasterPlaybackOwnerId),
  }), [videoMasterPlaybackOwnerId]);
  const videoMasterProgress = useSyncExternalStore(videoMasterProgressStore.subscribe, videoMasterProgressStore.getSnapshot, videoMasterProgressStore.getSnapshot);
  const updateNodeInternals = useUpdateNodeInternals();
  const [openGeneratorMenu, setOpenGeneratorMenu] = useState<string | null>(null);
  const [referenceMenuPortId, setReferenceMenuPortId] = useState("reference-image");
  const [referencePersonaId, setReferencePersonaId] = useState("");
  const [referencePersonaPickerOpen, setReferencePersonaPickerOpen] = useState(false);
  const [promptFocused, setPromptFocused] = useState(false);
  const [referenceMention, setReferenceMention] = useState<{ start: number; query: string } | null>(null);
  const [referenceMentionIndex, setReferenceMentionIndex] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantBrief, setAssistantBrief] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const [assistantMention, setAssistantMention] = useState<{ start: number; query: string } | null>(null);
  const [assistantMentionIndex, setAssistantMentionIndex] = useState(0);
  const [videoMasterSelectedClipId, setVideoMasterSelectedClipId] = useState(() => {
    if (data.kind !== "videoMaster") return "";
    const lastTarget = videoPlaybackManager.getLastTarget(videoMasterPlaybackOwnerId)?.targetKey || "";
    const lastSeparator = lastTarget.lastIndexOf(":");
    const lastClipId = lastSeparator > 0 ? lastTarget.slice(0, lastSeparator) : "";
    return data.videoMasterClips?.some((clip) => clip.id === lastClipId)
      ? lastClipId
      : data.videoMasterSelectedClipId || data.videoMasterClips?.[0]?.id || "";
  });
  const generatorPortModel = data.kind === "prompt"
    ? generator?.models.find((model) => model.id === data.modelId)
      || generator?.models.find((model) => model.mediaType === (data.mediaType || "image"))
    : undefined;
  const selectedMasterClip = data.kind === "videoMaster"
    ? data.videoMasterClips?.find((clip) => clip.id === videoMasterSelectedClipId)
      || data.videoMasterClips?.find((clip) => clip.id === data.videoMasterSelectedClipId)
      || data.videoMasterClips?.[0]
    : undefined;
  const selectedMasterReferences = useMemo(() => selectedMasterClip && generator ? generator.getReferences(id, selectedMasterClip.id) : [], [generator, id, selectedMasterClip]);
  const selectedMasterModels = useMemo(() => generator ? videoMasterModelsForScene(generator.models, selectedMasterClip, selectedMasterReferences) : [], [generator, selectedMasterClip, selectedMasterReferences]);
  const masterPortModel = selectedMasterClip
    ? selectedMasterModels.find((model) => model.id === selectedMasterClip.modelId)
      || selectedMasterModels[0]
      || generator?.models.find((model) => model.mediaType === "video")
    : undefined;
  useEffect(() => {
    if (!generator || data.kind !== "videoMaster" || !selectedMasterClip || !masterPortModel) return;
    if (!masterClipHasVideoReference(selectedMasterClip, selectedMasterReferences)) return;
    const currentModel = generator.models.find((model) => model.id === selectedMasterClip.modelId);
    const currentModelSupportsReference = modelSupportsVideoReference(currentModel);
    // A frame-mode model intentionally hides the automatic source video from
    // provider inputs while the assistant still receives it as scene context.
    // Re-applying the same compatible model cannot reveal that input and used
    // to create an infinite setNodes loop when the playhead crossed scenes.
    if (currentModelSupportsReference || masterPortModel.id === currentModel?.id || !modelSupportsVideoReference(masterPortModel)) return;
    generator.updateMasterClipModel(id, selectedMasterClip.id, masterPortModel.id);
  }, [data.kind, generator, id, masterPortModel, selectedMasterClip, selectedMasterReferences]);
  const generatorPortSignature = data.kind === "videoMaster"
    ? `${selectedMasterClip?.id || "none"}|${(masterPortModel?.inputPorts || []).map((port) => `${port.id}:${port.kind}`).join("|")}`
    : (generatorPortModel?.inputPorts || []).map((port) => `${port.id}:${port.kind}`).join("|");
  const timelinePortSignature = `${data.videoOutputSelection || "full"}|${data.videoSegments?.map((segment) => `${segment.id}:${segment.start.toFixed(3)}:${segment.end.toFixed(3)}`).join("|") || ""}`;
  useEffect(() => {
    if (data.kind !== "prompt" && !timelinePortSignature) return;
    // React Flow measures handles before the async model catalogue is ready.
    // Explicitly invalidate that measurement whenever semantic ports appear or change.
    const frame = window.requestAnimationFrame(() => updateNodeInternals(id));
    return () => window.cancelAnimationFrame(frame);
  }, [data.kind, generatorPortSignature, id, timelinePortSignature, updateNodeInternals]);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const assistantRef = useRef<HTMLTextAreaElement>(null);
  const assistantBriefValueRef = useRef("");
  const [naturalSceneRatio, setNaturalSceneRatio] = useState<number | null>(null);
  const [outputGalleryOpen, setOutputGalleryOpen] = useState(false);
  const [videoMasterOutputFilter, setVideoMasterOutputFilter] = useState<"scene" | "all">("scene");
  const [videoMasterOutputTarget, setVideoMasterOutputTarget] = useState<string | null>(null);
  const [assistantSettingsOpen, setAssistantSettingsOpen] = useState(false);
  const [assistantCopied, setAssistantCopied] = useState(false);
  const [assistantView, setAssistantView] = useState<"input" | "output">("input");
  const [videoMasterControlsHost, setVideoMasterControlsHost] = useState<HTMLDivElement | null>(null);
  const [videoMasterRelativeTime, setVideoMasterRelativeTime] = useState(0);
  const [videoMasterSequencePlaying, setVideoMasterSequencePlaying] = useState(false);
  const [videoMasterPlayRequest, setVideoMasterPlayRequest] = useState<{ token: number; clipId: string; lane: "output" | "original"; relativeTime: number } | null>(null);
  const [videoMasterLaneVisibility, setVideoMasterLaneVisibility] = useState({ output: true, original: true });
  const [videoMasterSelectedLane, setVideoMasterSelectedLane] = useState<"output" | "original">("output");
  const videoMasterCurrentTargetKey = `${selectedMasterClip?.id || ""}:${videoMasterSelectedLane}`;
  const videoMasterTransportRelativeTime = videoMasterProgress.targetKey === videoMasterCurrentTargetKey
    ? videoMasterProgress.relativeTime
    : videoMasterRelativeTime;
  const [videoMasterSeekRequest, setVideoMasterSeekRequest] = useState<{ clipId: string; time: number; version: number } | null>(null);
  const [videoMasterDownloadBusy, setVideoMasterDownloadBusy] = useState(false);
  const [videoMasterExportScope, setVideoMasterExportScope] = useState<"scene" | "video">("video");
  const [videoMasterExportLane, setVideoMasterExportLane] = useState<VideoMasterDownloadLane>("original");
  const videoMasterRootRef = useRef<HTMLElement | null>(null);
  const videoMasterSelectedClipRef = useRef(selectedMasterClip?.id || "");
  const videoMasterInternalSelectionRef = useRef<string | null>(null);
  const videoMasterLiveSelectionOwnedRef = useRef(false);
  const videoMasterPlaybackTargetRef = useRef(`${selectedMasterClip?.id || ""}:output`);
  const demoMasterPlaybackTokenRef = useRef<number | undefined>(undefined);
  const queueVideoMasterPlay = (clipId: string, lane: "output" | "original", relativeTime: number) => {
    setVideoMasterPlayRequest((current) => ({
      token: (current?.token || 0) + 1,
      clipId,
      lane,
      relativeTime: Math.max(0, relativeTime),
    }));
  };
  const assistantInputRef = useRef<HTMLTextAreaElement>(null);
  const assistantSettingsRef = useRef<HTMLDivElement>(null);
  const [liveNodeWidth, setLiveNodeWidth] = useState<number | null>(null);
  const [liveNodeHeight, setLiveNodeHeight] = useState<number | null>(null);
  useEffect(() => {
    if (data.kind !== "videoMaster") return;
    const persistedClipId = data.videoMasterSelectedClipId || data.videoMasterClips?.[0]?.id || "";
    if (!persistedClipId) return;
    // The fullscreen editor is the only mounted Master player while it is
    // open. Mirror its persisted selection into the passive canvas shell so
    // returning to canvas cannot resurrect the scene that was selected before
    // fullscreen opened.
    if (previewOwnsPlayback) {
      videoMasterLiveSelectionOwnedRef.current = false;
      queueMicrotask(() => setVideoMasterSelectedClipId((current) => current === persistedClipId ? current : persistedClipId));
      return;
    }
    // After the first direct interaction this mounted editor is the sole
    // authority for its live transport selection. Autosave acknowledgements
    // and project refreshes may arrive out of order; allowing any of them to
    // drive the player again makes a later stale response resurrect the clip
    // the user already left (03 -> 01 becoming 03 -> 02, for example).
    if (videoMasterLiveSelectionOwnedRef.current) return;
    queueMicrotask(() => setVideoMasterSelectedClipId((current) => current === persistedClipId ? current : persistedClipId));
  }, [data.kind, data.videoMasterSelectedClipId, data.videoMasterClips?.[0]?.id, previewOwnsPlayback]);
  useEffect(() => {
    if (data.kind !== "videoMaster" || !videoMasterRootRef.current || typeof ResizeObserver === "undefined") return;
    const root = videoMasterRootRef.current;
    let frame = 0;
    const refreshHandles = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => updateNodeInternals(id));
    };
    const observer = new ResizeObserver(refreshHandles);
    observer.observe(root);
    refreshHandles();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [data.kind, id, updateNodeInternals]);
  useEffect(() => {
    if (data.kind !== "videoMaster") return;
    const nextClipId = selectedMasterClip?.id || "";
    videoMasterPlaybackTargetRef.current = `${nextClipId}:${videoMasterSelectedLane}`;
    const handledInternally = videoMasterInternalSelectionRef.current === nextClipId;
    if (nextClipId === videoMasterSelectedClipRef.current) {
      if (handledInternally) videoMasterInternalSelectionRef.current = null;
      return;
    }
    videoMasterSelectedClipRef.current = nextClipId;
    videoMasterInternalSelectionRef.current = null;
    if (handledInternally) return;
    // Fullscreen and canvas editors share persisted scene selection, but never
    // share a media element. Keep the canvas player mounted and let its
    // declarative source/seek inputs reconcile the externally selected scene.
    setVideoMasterRelativeTime(0);
    setVideoMasterSequencePlaying(false);
    setVideoMasterSeekRequest(null);
  }, [data.kind, selectedMasterClip?.id, videoMasterSelectedLane]);
  const initialOutputUrl = String(data.outputUrl || "");
  // Do not assume a persisted output is already decoded after a page reload.
  // The visible image itself owns loading and retry state, avoiding a lazy
  // image plus a second hidden preload element for every generator node.
  const [loadedOutput, setLoadedOutput] = useState({ sourceUrl: "", renderUrl: "" });
  const [outputRetry, setOutputRetry] = useState({ sourceUrl: "", attempt: 0 });
  const outputRetryTimerRef = useRef<number | null>(null);
  const promptGenerationActive = data.kind === "prompt" && Boolean(
    generator?.generatingNodeIds.includes(id)
    || data.status === "queued"
    || data.status === "working"
  );
  const promptGenerationResultKey = data.kind === "prompt"
    ? `${String(data.generatedAt || "")}|${String(data.outputUrl || "")}`
    : "";
  const previousPromptGenerationResultKeyRef = useRef(promptGenerationResultKey);
  useEffect(() => {
    const completedWithNewOutput = data.kind === "prompt"
      && data.status === "ready"
      && Boolean(data.outputUrl)
      && previousPromptGenerationResultKeyRef.current !== promptGenerationResultKey;
    previousPromptGenerationResultKeyRef.current = promptGenerationResultKey;
    if (!promptGenerationActive && !completedWithNewOutput) return;

    // The prompt editor is removed while a generation is active. Browsers do
    // not dispatch blur when React removes a focused textarea, so relying on
    // onBlur can leave the local focus flag alive when the result remounts the
    // editor. Generation lifecycle events are authoritative: both starting a
    // run and receiving a new successful output end the editing session.
    const promptElement = promptRef.current;
    if (document.activeElement === promptElement) promptElement?.blur();
    setPromptFocused(false);
    setReferenceMention(null);
  }, [data.kind, data.outputUrl, data.status, promptGenerationActive, promptGenerationResultKey]);
  const connectedGeneratorPrompt = data.kind === "prompt" && generator ? generator.getTextInput(id)?.text.trim() || "" : "";
  const beginProportionalResize = (event: ReactPointerEvent<HTMLButtonElement>, currentWidth: number, minWidth: number, maxWidth: number) => {
    if (!generator) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const viewport = event.currentTarget.closest(".react-flow")?.querySelector(".react-flow__viewport");
    const transform = viewport ? window.getComputedStyle(viewport).transform : "none";
    const zoom = transform === "none" ? 1 : Math.max(0.15, new window.DOMMatrixReadOnly(transform).a || 1);
    let nextWidth = currentWidth;
    const move = (moveEvent: PointerEvent) => {
      nextWidth = Math.round(Math.min(maxWidth, Math.max(minWidth, currentWidth + (moveEvent.clientX - startX) / zoom)));
      setLiveNodeWidth(nextWidth);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      generator.updateNode(id, { nodeWidth: nextWidth });
      window.requestAnimationFrame(() => setLiveNodeWidth(null));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };
  const beginNoteResize = (event: ReactPointerEvent<HTMLButtonElement>, currentWidth: number, currentHeight: number) => {
    if (!generator) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const viewport = event.currentTarget.closest(".react-flow")?.querySelector(".react-flow__viewport");
    const transform = viewport ? window.getComputedStyle(viewport).transform : "none";
    const zoom = transform === "none" ? 1 : Math.max(0.15, new window.DOMMatrixReadOnly(transform).a || 1);
    let nextWidth = currentWidth;
    let nextHeight = currentHeight;
    const move = (moveEvent: PointerEvent) => {
      nextWidth = Math.round(Math.min(720, Math.max(240, currentWidth + (moveEvent.clientX - startX) / zoom)));
      nextHeight = Math.round(Math.min(820, Math.max(260, currentHeight + (moveEvent.clientY - startY) / zoom)));
      setLiveNodeWidth(nextWidth);
      setLiveNodeHeight(nextHeight);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      generator.updateNode(id, { nodeWidth: nextWidth, nodeHeight: nextHeight });
      window.requestAnimationFrame(() => { setLiveNodeWidth(null); setLiveNodeHeight(null); });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };
  useEffect(() => {
    if (!openGeneratorMenu) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".generator-select.is-open, .generator-semantic-port.is-open, .generator-reference-menu, .generator-run-control.is-open, .video-master-download-control.is-open")) setOpenGeneratorMenu(null);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [openGeneratorMenu]);
  useEffect(() => {
    if (!outputGalleryOpen) return;
    const closeGalleryOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".generator-output-history")) setOutputGalleryOpen(false);
    };
    document.addEventListener("pointerdown", closeGalleryOutside, true);
    return () => document.removeEventListener("pointerdown", closeGalleryOutside, true);
  }, [outputGalleryOpen]);
  useEffect(() => () => {
    if (outputRetryTimerRef.current !== null) window.clearTimeout(outputRetryTimerRef.current);
  }, [initialOutputUrl]);
  useEffect(() => {
    if (!assistantOpen) return;
    const closeAssistantOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".generator-prompt-assistant, .generator-assistant-trigger")) return;
      // Dismiss only. Letting this pointer event continue would also click the
      // full-stage playback control behind the assistant.
      event.preventDefault();
      event.stopPropagation();
      setAssistantOpen(false);
      setAssistantMention(null);
    };
    const closeAssistantWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAssistantOpen(false);
        setAssistantMention(null);
      }
    };
    document.addEventListener("pointerdown", closeAssistantOutside, true);
    document.addEventListener("keydown", closeAssistantWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeAssistantOutside, true);
      document.removeEventListener("keydown", closeAssistantWithEscape);
    };
  }, [assistantOpen]);
  useEffect(() => {
    assistantBriefValueRef.current = assistantBrief;
  }, [assistantBrief]);
  useEffect(() => {
    if (typeof data.demoAssistantOpen !== "boolean") return;
    queueMicrotask(() => {
      setAssistantOpen(data.demoAssistantOpen!);
      if (!data.demoAssistantOpen) setAssistantMention(null);
    });
  }, [data.demoAssistantOpen]);
  useEffect(() => {
    if (typeof data.demoAssistantBusy !== "boolean") return;
    queueMicrotask(() => setAssistantBusy(data.demoAssistantBusy!));
  }, [data.demoAssistantBusy]);
  useEffect(() => {
    if (typeof data.demoOutputGalleryOpen !== "boolean") return;
    queueMicrotask(() => setOutputGalleryOpen(data.demoOutputGalleryOpen!));
  }, [data.demoOutputGalleryOpen, data.demoOutputGalleryToken]);
  useEffect(() => {
    const token = data.demoMasterPlaybackToken;
    if (typeof token !== "number") {
      demoMasterPlaybackTokenRef.current = undefined;
      return;
    }
    if (data.kind !== "videoMaster" || demoMasterPlaybackTokenRef.current === token || previewOwnsPlayback) return;
    const clip = data.videoMasterClips?.find((item) => item.id === data.demoMasterPlaybackClipId);
    if (!clip) return;
    const lane = data.demoMasterPlaybackLane === "original" ? "original" : "output";
    const playback = videoMasterClipPlaybackMedia(clip, lane, videoMasterLaneVisibility);
    if (!playback.url) return;
    const relativeTime = Math.min(playback.duration, Math.max(0, Number(data.demoMasterPlaybackRelativeTime || 0)));
    const targetKey = `${clip.id}:${lane}`;
    demoMasterPlaybackTokenRef.current = token;
    videoMasterPlaybackTargetRef.current = targetKey;
    videoMasterInternalSelectionRef.current = clip.id;
    videoMasterLiveSelectionOwnedRef.current = true;
    queueMicrotask(() => {
      setVideoMasterSelectedClipId(clip.id);
      setVideoMasterSelectedLane(lane);
      setVideoMasterRelativeTime(relativeTime);
      setVideoMasterSeekRequest(null);
      setVideoMasterSequencePlaying(true);
      const command = videoPlaybackManager.play(videoMasterPlaybackOwnerId, targetKey, { relativeTime });
      setVideoMasterPlayRequest({ token: command.id, clipId: clip.id, lane, relativeTime });
    });
  }, [data.demoMasterPlaybackClipId, data.demoMasterPlaybackLane, data.demoMasterPlaybackRelativeTime, data.demoMasterPlaybackToken, data.kind, data.videoMasterClips, previewOwnsPlayback, videoMasterLaneVisibility, videoMasterPlaybackOwnerId]);
  useEffect(() => {
    if (typeof data.demoAssistantTypingText !== "string") return;
    const target = data.demoAssistantTypingText;
    let current = assistantBriefValueRef.current;
    if (!target.startsWith(current)) {
      current = "";
      assistantBriefValueRef.current = "";
      setAssistantBrief("");
    }
    if (current === target) return;
    const timer = window.setInterval(() => {
      const next = target.slice(0, Math.min(target.length, assistantBriefValueRef.current.length + 1));
      assistantBriefValueRef.current = next;
      setAssistantBrief(next);
      if (next === target) window.clearInterval(timer);
    }, 24);
    return () => window.clearInterval(timer);
  }, [data.demoAssistantTypingText]);
  useEffect(() => {
    const referenceId = data.demoAssistantReferenceId;
    if (!generator || data.kind !== "prompt" || typeof referenceId !== "string") return;
    const references = generator.getReferences(id);
    const referenceIndex = references.findIndex((reference) => reference.id === referenceId || reference.assetId === referenceId);
    const reference = references[referenceIndex];
    if (!reference) return;
    const token = referenceMentionToken(reference.title, referenceIndex);
    const timer = window.setTimeout(() => {
      const current = assistantBriefValueRef.current;
      if (current.includes(token)) return;
      const separator = current && !/\s$/u.test(current) ? " " : "";
      const next = `${current}${separator}${token}`;
      assistantBriefValueRef.current = next;
      setAssistantBrief(next);
    }, Number(data.demoAssistantReferenceDelayMs || 0));
    return () => window.clearTimeout(timer);
  }, [data.demoAssistantReferenceDelayMs, data.demoAssistantReferenceId, data.kind, generator, id]);
  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea || document.activeElement === textarea) return;
    if (connectedGeneratorPrompt && String(data.prompt || "").trim() === connectedGeneratorPrompt) {
      textarea.value = "";
      generator?.updateNode(id, { prompt: "" });
      return;
    }
    const nextPrompt = data.prompt || "";
    if (textarea.value !== nextPrompt) textarea.value = nextPrompt;
  }, [connectedGeneratorPrompt, data.prompt, generator, id]);
  useEffect(() => {
    const textarea = assistantInputRef.current;
    if (!textarea || document.activeElement === textarea) return;
    const nextInput = String(data.assistantInput || "");
    if (textarea.value !== nextInput) textarea.value = nextInput;
  }, [data.assistantInput]);
  useEffect(() => {
    if (!assistantSettingsOpen) return;
    const close = (event: PointerEvent) => {
      if (!assistantSettingsRef.current?.contains(event.target as Node)) setAssistantSettingsOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setAssistantSettingsOpen(false); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [assistantSettingsOpen]);
  useEffect(() => {
    if (!generator || data.kind !== "videoMaster" || !data.outputUrl || !data.videoMasterGeneratingClipId) return;
    const clips = data.videoMasterClips || [];
    const clipId = data.videoMasterGeneratingClipId;
    if (!clips.some((clip) => clip.id === clipId)) return;
    generator.updateNode(id, {
      videoMasterClips: clips.map((clip) => clip.id === clipId ? {
        ...clip,
        origin: "generated" as const,
        outputUrl: data.outputUrl,
        outputAssetId: data.assetId,
      } : clip),
      videoMasterGeneratingClipId: undefined,
      outputUrl: undefined,
      assetId: undefined,
    });
  }, [data.assetId, data.kind, data.outputUrl, data.videoMasterClips, data.videoMasterGeneratingClipId, generator, id]);
  useEffect(() => {
    if (!generator || data.kind !== "videoMaster" || !data.videoMasterClips?.length) return;
    if (data.videoMasterClips.every((clip) => Number.isFinite(clip.sequenceIndex))) return;
    const videoMasterClips = [...data.videoMasterClips]
      .sort((left, right) => videoMasterLegacyOrder(left, 0) - videoMasterLegacyOrder(right, 0))
      .map((clip, sequenceIndex) => ({ ...clip, sequenceIndex }));
    const first = videoMasterClips[0];
    generator.updateNode(id, {
      videoMasterClips,
      videoMasterSelectedClipId: first.id,
      prompt: first.prompt,
      modelId: first.modelId,
      duration: String(Math.max(.1, Number(first.duration || 5))),
    });
  }, [data.kind, data.videoMasterClips, generator, id]);
  const Icon = icons[data.kind] || StickyNote;
  const hasImage = Boolean(data.imageUrl || data.outputUrl);
  const image = String(data.outputUrl || data.imageUrl || "");
  const thumbnailImage = assetThumbnailUrl(image);
  if (data.kind === "assistant" && generator) {
    const busy = generator.runningAssistantNodeId === id;
    const output = String(data.assistantOutput || "");
    const textInput = generator.getTextInput(id);
    const images = generator.getReferences(id);
    const renderedWidth = liveNodeWidth || data.nodeWidth || 430;
    return <article className={`frame-node frame-node--assistant ${selected ? "is-selected" : ""}`} style={{ width: renderedWidth }}>
      <header className="assistant-node-title"><span><AssistantGlyph size={15} />Assistant</span></header>
      <div className="assistant-node-shell">
        {busy && <ImageGeneration className="assistant-generation-progress" startingLabel="Preparing context…" generatingLabel="Assistant is writing. This may take a moment.">
          <div className="assistant-generation-preview">{output ? <p>{output}</p> : <AssistantGlyph size={24} />}</div>
        </ImageGeneration>}
        <div className="assistant-view-switch nodrag nopan" role="tablist" aria-label="Assistant view" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="tab" aria-selected={assistantView === "input"} className={assistantView === "input" ? "is-active" : ""} aria-label="Task" onPointerDown={(event) => { event.stopPropagation(); setAssistantView("input"); }}><FileText size={14} /></button>
          <button type="button" role="tab" aria-selected={assistantView === "output"} className={assistantView === "output" ? "is-active" : ""} aria-label="Result" onPointerDown={(event) => { event.stopPropagation(); setAssistantView("output"); }}><AssistantGlyph size={14} />{output && <i />}</button>
        </div>
        {assistantView === "input" ? <section className="assistant-input-section">
            <textarea className="nodrag nopan" ref={assistantInputRef} defaultValue={String(data.assistantInput || "")} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => generator.updateNode(id, { assistantInput: event.target.value })} onWheelCapture={(event) => event.stopPropagation()} placeholder="Describe the prompt you want the assistant to create…" aria-label="Assistant task" />
            {(textInput || images.length > 0) && <div className="assistant-context-chips">
              {textInput && <span className="is-text"><FileText size={10} />{textInput.title}</span>}
              {images.length > 0 && <span><ImageIcon size={10} />{images.length} image{images.length === 1 ? "" : "s"}</span>}
            </div>}
          </section> : <section className="assistant-output-section">
            {output && <button type="button" className="assistant-copy-button nodrag nopan" title="Copy result" aria-label="Copy result" onPointerDown={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(output); setAssistantCopied(true); window.setTimeout(() => setAssistantCopied(false), 1400); }}>{assistantCopied ? <Check size={13} /> : <Copy size={13} />}</button>}
            {output ? <div className="assistant-output-copy nodrag nopan" onWheelCapture={(event) => event.stopPropagation()}>{output}</div> : <p>Run Assistant to generate a prompt.</p>}
          </section>}
        <footer className="assistant-node-footer nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
          <GeneratorSelect menuKey="assistant-model" openMenu={openGeneratorMenu} setOpenMenu={setOpenGeneratorMenu} className="assistant-model-select" value={normalizeAssistantModelId(data.textModelId)} label="ASSISTANT MODEL" options={assistantModels.map((model) => ({ value: model.id, label: model.label, description: assistantModelCreditDescription(model, { inputCharacters: String(data.assistantInput || "").length + String(data.systemPrompt || "").length + String(textInput?.text || "").length, imageCount: images.length }) }))} onChange={(value) => generator.updateNode(id, { textModelId: value })} />
          <button type="button" className={`assistant-settings-button ${assistantSettingsOpen ? "is-active" : ""}`} aria-label="Assistant settings" title="System role" onPointerDown={(event) => { event.stopPropagation(); setAssistantSettingsOpen((open) => !open); }}><Settings2 size={14} /></button>
          <button type="button" className="assistant-run-button" aria-label="Run Assistant" disabled={busy || !String(data.assistantInput || "").trim()} onPointerDown={(event) => { event.stopPropagation(); setAssistantView("output"); generator.runAssistant(id); }}>{busy ? <span className="generator-spinner" /> : <Play size={15} fill="currentColor" />}</button>
        </footer>
      </div>
      {assistantSettingsOpen && <div ref={assistantSettingsRef} className="assistant-settings-popover nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
        <header><span><Settings2 size={13} />System role</span><button type="button" aria-label="Close settings" onPointerDown={(event) => { event.stopPropagation(); setAssistantSettingsOpen(false); }}><X size={14} /></button></header>
        <label>System prompt</label>
        <textarea value={String(data.systemPrompt || "")} onChange={(event) => generator.updateNode(id, { systemPrompt: event.target.value })} onWheelCapture={(event) => event.stopPropagation()} placeholder="Add custom instructions for the model (optional)" autoFocus />
        <small><Check size={10} />Autosaved for this Assistant</small>
      </div>}
      <div className="assistant-port assistant-port--text-in" title="Text input"><Handle id="text-input" type="target" position={Position.Left} /><span>T</span></div>
      <div className="assistant-port assistant-port--image-in" title="Image input"><Handle id="image-input" type="target" position={Position.Left} /><span><ImageIcon size={12} /></span></div>
      <div className="assistant-port assistant-port--text-out" title="Text output"><span>T</span><Handle id="text-output" type="source" position={Position.Right} /></div>
      <button type="button" className="node-resize-corner nodrag nopan" aria-label="Resize Assistant" onPointerDown={(event) => beginProportionalResize(event, Number(renderedWidth), 360, 720)}><svg viewBox="0 0 36 36" aria-hidden="true"><path className="resize-grip-outer" d="M6 30h10c7.7 0 14-6.3 14-14V6" /></svg></button>
    </article>;
  }
  if (data.kind === "prompt" && generator) {
    const selectedModel = generator.models.find((model) => model.id === data.modelId) || generator.models.find((model) => model.mediaType === (data.mediaType || "image"));
    const references = generator.getReferences(id);
    const hasVideoInput = references.some((reference) => reference.role === "reference-video" || reference.role === "motion-video");
    const ratios = generatorRatiosFor(selectedModel, data.resolution, references.length > 0).filter((ratio) => ratio !== "source");
    const resolutions = generatorResolutionsFor(selectedModel, hasVideoInput);
    const connectedText = generator.getTextInput(id);
    const allMentionOptions = references
      .map((reference, index) => ({ ...reference, referenceIndex: index, token: referenceMentionToken(reference.title, index) }));
    const mentionOptions = allMentionOptions
      .filter((reference) => !referenceMention?.query || `${reference.title} ${reference.token}`.toLocaleLowerCase().includes(referenceMention.query.toLocaleLowerCase()));
    const assistantMentionOptions = allMentionOptions
      .filter((reference) => !assistantMention?.query || `${reference.title} ${reference.token}`.toLocaleLowerCase().includes(assistantMention.query.toLocaleLowerCase()));
    const outputUrl = String(data.outputUrl || "");
    const generatedOutputs = Array.isArray(data.generatedOutputs) ? data.generatedOutputs.filter((output) => Boolean(output?.url)) : [];
    const outputMediaType = data.mediaType || selectedModel?.mediaType || "image";
    const GeneratorNodeIcon = outputMediaType === "video" ? Video : ImageIcon;
    const availableModels = generator.models.filter((model) => model.mediaType === outputMediaType);
    const selectedRatio = String(data.aspectRatio || selectedModel?.defaultRatio || "4:5");
    const ratioCss = /^\d+:\d+$/.test(selectedRatio) ? selectedRatio.replace(":", " / ") : "16 / 9";
    const [ratioWidth, ratioHeight] = String(data.aspectRatio || "4:5").split(":").map(Number);
    const ratioValue = Number.isFinite(ratioWidth / ratioHeight) ? ratioWidth / ratioHeight : 16 / 9;
    const generatorWidth = ratioValue >= 1.65 ? 620 : ratioValue >= 1.2 ? 520 : 430;
    const busy = generator.generatingNodeIds.includes(id);
    const queued = data.status === "queued";
    const failed = data.status === "failed";
    const outputRetryAttempt = outputRetry.sourceUrl === outputUrl
      ? outputRetry.attempt
      : Math.min(OUTPUT_IMAGE_LOAD_ATTEMPTS, outputImageFailures.get(outputUrl) || 0);
    const outputIsLoaded = outputMediaType === "video" || !outputUrl || loadedOutput.sourceUrl === outputUrl;
    const outputLoadFailed = outputMediaType === "image" && Boolean(outputUrl) && !outputIsLoaded && outputRetryAttempt >= OUTPUT_IMAGE_LOAD_ATTEMPTS;
    const displayedOutputUrl = outputLoadFailed
      ? ""
      : outputMediaType === "video"
        ? outputUrl
        : outputUrl
          ? loadedOutput.sourceUrl === outputUrl ? loadedOutput.renderUrl : outputImageUrlForAttempt(outputUrl, outputRetryAttempt)
          : "";
    const readyOutputUrl = outputIsLoaded ? outputUrl : "";
    const activeGeneration = busy || queued;
    const showCanvasGenerationProgress = activeGeneration && !previewOwnsPlayback;
    const markOutputLoaded = () => {
      if (!outputUrl) return;
      if (outputRetryTimerRef.current !== null) {
        window.clearTimeout(outputRetryTimerRef.current);
        outputRetryTimerRef.current = null;
      }
      outputImageFailures.delete(outputUrl);
      setLoadedOutput({ sourceUrl: outputUrl, renderUrl: outputImageUrlForAttempt(outputUrl, outputRetryAttempt) });
      setOutputRetry({ sourceUrl: "", attempt: 0 });
    };
    const retryOutputLoad = () => {
      if (!outputUrl || outputRetryTimerRef.current !== null) return;
      const generatedRecently = Date.now() - new Date(String(data.generatedAt || 0)).getTime() <= OUTPUT_IMAGE_RETRY_WINDOW_MS;
      const canRetry = selected || busy || queued || generatedRecently;
      if (!canRetry || outputRetryAttempt >= OUTPUT_IMAGE_LOAD_ATTEMPTS - 1) {
        rememberOutputImageFailure(outputUrl, OUTPUT_IMAGE_LOAD_ATTEMPTS);
        setOutputRetry({ sourceUrl: outputUrl, attempt: OUTPUT_IMAGE_LOAD_ATTEMPTS });
        return;
      }
      const nextAttempt = outputRetryAttempt + 1;
      rememberOutputImageFailure(outputUrl, nextAttempt);
      outputRetryTimerRef.current = window.setTimeout(() => {
        setOutputRetry({ sourceUrl: outputUrl, attempt: nextAttempt });
        outputRetryTimerRef.current = null;
      }, Math.min(3000, 750 * nextAttempt));
    };
    const selectGeneratedOutput = (index: number) => {
      const output = generatedOutputs[index];
      if (!output) return;
      generator.updateNode(id, { outputUrl: output.url, assetId: output.assetId, mediaType: output.mediaType, modelId: output.modelId, activeGeneratedOutputIndex: index });
    };
    const maxReferences = selectedModel?.maxReferences || 8;
    const inputPorts = selectedModel?.inputPorts || (selectedModel?.maxReferences ? [{ id: "reference-image", label: "Image reference", kind: "image" as const, max: selectedModel.maxReferences }] : []);
    const missingRequiredInputs = inputPorts.filter((port) => port.required && !references.some((reference) => reference.role === port.id));
    const canGenerate = Boolean(connectedText?.text || data.prompt?.trim()) && missingRequiredInputs.length === 0;
    const generationCount = Math.min(MAX_GENERATION_BATCH, Math.max(1, Number(data.generationCount || 1)));
    const generatedAudioEnabled = data.generateAudio ?? selectedModel?.defaultGenerateAudio ?? false;
    const inputVideoDurationSeconds = references
      .filter((reference) => reference.role === "reference-video" || reference.role === "motion-video")
      .reduce((total, reference) => total + Math.max(0, Number(reference.durationSeconds || 0)), 0);
    const runCredits = selectedModel
      ? generationCreditCost(selectedModel.id, resolutions.includes(String(data.resolution || "").toUpperCase()) ? String(data.resolution).toUpperCase() : resolutions.includes(selectedModel.defaultResolution || "") ? selectedModel.defaultResolution! : resolutions[0] || "1K", data.duration || selectedModel.defaultDuration || selectedModel.durations?.[0] || "5", references.length, { generateAudio: generatedAudioEnabled, hasVideoInput, inputVideoDurationSeconds }) * generationCount
      : 0;
    const runCreditLabel = missingRequiredInputs.length
      ? `Connect ${missingRequiredInputs.map((port) => port.label).join(" and ")}`
      : selectedModel?.durationSource === "reference-video" && !inputVideoDurationSeconds
        ? "Run cost follows reference video length"
        : `Run ${runCredits.toLocaleString("en-US")} credit${runCredits === 1 ? "" : "s"}`;
    const simultaneousCount = Math.min(generationCount, generator.generationConcurrency);
    const generationCountLabel = generationCount === 1
      ? "Creates 1 generator node"
      : `Creates ${generationCount} generator nodes · ${simultaneousCount} at a time on ${generator.queueLabel}`;
    const attachedReferences = data.attachedReferences || [];
    const promptIsLong = Boolean((data.prompt || "").length > 150 || (data.prompt || "").split("\n").length > 4);
    const attachedReferenceIds = new Set(attachedReferences.map((reference) => reference.assetId));
    const attachedPersonaId = attachedReferences.find((reference) => reference.personaId && generator.personas.some((persona) => persona.id === reference.personaId))?.personaId || "";
    const selectedReferencePersona = generator.personas.find((persona) => persona.id === referencePersonaId)
      || generator.personas.find((persona) => persona.id === attachedPersonaId)
      || null;
    const attachPersonaAsset = (persona: PersonaRecord, asset: PersonaRecord["assets"][number]) => {
      if (attachedReferenceIds.has(asset.id)) {
        generator.updateNode(id, { attachedReferences: attachedReferences.filter((reference) => reference.assetId !== asset.id) });
        return;
      }
      if (references.length >= maxReferences) return;
      generator.updateNode(id, { attachedReferences: [...attachedReferences, { assetId: asset.id, url: asset.url, title: `${persona.name} · ${asset.role} ${persona.assets.filter((item) => item.role === asset.role).findIndex((item) => item.id === asset.id) + 1}`, personaId: persona.id, variant: asset.role }] });
    };
    const attachPersonaVariant = (persona: PersonaRecord, variant: "reference" | "before" | "after") => {
      const occupied = references.length;
      const freeSlots = Math.max(0, maxReferences - occupied);
      const additions = persona.assets
        .filter((asset) => asset.role === variant && !attachedReferenceIds.has(asset.id))
        .slice(0, freeSlots)
        .map((asset, index) => ({ assetId: asset.id, url: asset.url, title: `${persona.name} · ${variant} ${index + 1}`, personaId: persona.id, variant }));
      if (additions.length) generator.updateNode(id, { attachedReferences: [...attachedReferences, ...additions] });
    };
    const removeAttachedReference = (assetId: string) => generator.updateNode(id, { attachedReferences: attachedReferences.filter((reference) => reference.assetId !== assetId) });
    const removeReference = (reference: GeneratorReference) => {
      if (reference.sourceNodeId) generator.disconnectReference(id, reference.sourceNodeId, reference.edgeId);
      else if (reference.assetId) removeAttachedReference(reference.assetId);
    };
    const insertReferenceMention = (reference: (typeof mentionOptions)[number]) => {
      if (!referenceMention) return;
      const textarea = promptRef.current;
      const prompt = data.prompt || "";
      const caret = textarea?.selectionStart ?? prompt.length;
      const before = prompt.slice(0, referenceMention.start);
      const after = prompt.slice(caret);
      const nextPrompt = `${before}${reference.token} ${after}`;
      const nextCaret = before.length + reference.token.length + 1;
      if (textarea) textarea.value = nextPrompt;
      generator.updateNode(id, { prompt: nextPrompt });
      setReferenceMention(null);
      window.requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(nextCaret, nextCaret);
      });
    };
    const updateReferenceMention = (value: string, caret: number) => {
      const prefix = value.slice(0, caret);
      const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u);
      if (!match || !references.length) {
        setReferenceMention(null);
        return;
      }
      setReferenceMention({ start: prefix.lastIndexOf("@"), query: match[1] || "" });
      setReferenceMentionIndex(0);
    };
    const updateAssistantMention = (value: string, caret: number) => {
      const prefix = value.slice(0, caret);
      const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u);
      if (!match || !references.length) {
        setAssistantMention(null);
        return;
      }
      setAssistantMention({ start: prefix.lastIndexOf("@"), query: match[1] || "" });
      setAssistantMentionIndex(0);
    };
    const insertAssistantMention = (reference: (typeof allMentionOptions)[number]) => {
      const textarea = assistantRef.current;
      const currentBrief = textarea?.value ?? assistantBriefValueRef.current ?? assistantBrief;
      const caret = textarea?.selectionStart ?? currentBrief.length;
      const start = assistantMention?.start ?? caret;
      const before = currentBrief.slice(0, start);
      const after = currentBrief.slice(caret);
      const separator = before && !/\s$/u.test(before) ? " " : "";
      const nextBrief = `${before}${separator}${reference.token} ${after}`;
      const nextCaret = before.length + separator.length + reference.token.length + 1;
      assistantBriefValueRef.current = nextBrief;
      setAssistantBrief(nextBrief);
      setAssistantError("");
      setAssistantMention(null);
      window.requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(nextCaret, nextCaret);
      });
    };
    const buildPromptWithAssistant = async () => {
      const brief = String(assistantRef.current?.value || assistantBriefValueRef.current || assistantBrief).trim();
      if (!brief || assistantBusy) return;
      assistantBriefValueRef.current = brief;
      if (assistantBrief !== brief) setAssistantBrief(brief);
      setAssistantBusy(true);
      setAssistantError("");
      try {
        const prompt = await generator.composePrompt(id, brief);
        if (promptRef.current) promptRef.current.value = prompt;
        assistantBriefValueRef.current = "";
        setAssistantBrief("");
        setAssistantOpen(false);
        setAssistantMention(null);
      } catch (error) {
        setAssistantError(error instanceof Error ? error.message : "Prompt assistant failed");
      } finally {
        setAssistantBusy(false);
      }
    };
    const chooseRatio = (value: string) => {
      if (value !== "original") {
        generator.updateNode(id, { aspectRatio: value as FrameNode["data"]["aspectRatio"], ratioMode: "custom" });
        return;
      }
      const reference = references[0];
      if (!reference) return;
      void readImageRatio(reference.url, ratios).then((ratio) => generator.updateNode(id, { aspectRatio: ratio as FrameNode["data"]["aspectRatio"], ratioMode: "original" }));
    };
    const ratioOptions = references.length
      ? [{ value: "original", label: `Original · ${data.ratioMode === "original" ? data.aspectRatio || "auto" : "auto"}`, description: "Match the first connected reference" }, ...ratios.map((ratio) => ({ value: ratio, label: ratio }))]
      : ratios.map((ratio) => ({ value: ratio, label: ratio }));
    const referenceMenu = openGeneratorMenu === "references" && <div
      className="generator-reference-menu nodrag nopan nowheel"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
    >
      <div className="generator-reference-menu-head"><span>REFERENCES</span><b>{references.length} ATTACHED</b></div>
      <div className="generator-reference-capacity"><span>{selectedModel?.label || "Selected model"}</span><small>{maxReferences > 0 ? `supports up to ${maxReferences} reference input${maxReferences === 1 ? "" : "s"}` : "does not accept reference inputs"}</small></div>
      <div className="generator-reference-scroll nowheel" onWheelCapture={(event) => {
        if ((event.target as HTMLElement).closest(".generator-persona-picker-options")) return;
        event.stopPropagation();
      }} onTouchMove={(event) => event.stopPropagation()}>
      {references.length > 0 && <div className="generator-reference-current">
        {references.map((reference) => {
          const persona = reference.assetId ? generator.personas.find((item) => item.id === reference.personaId) : null;
          const asset = persona?.assets.find((item) => item.id === reference.assetId);
          const variant = asset?.role || reference.variant;
          const variantIndex = persona && asset ? persona.assets.filter((item) => item.role === asset.role).findIndex((item) => item.id === asset.id) + 1 : 0;
          const title = persona && variant ? `${persona.name} · ${variant === "reference" ? "Identity" : variant[0].toUpperCase() + variant.slice(1)}${variantIndex ? ` ${String(variantIndex).padStart(2, "0")}` : ""}` : reference.title;
          return <div className="generator-reference-row" key={reference.id}>
            <GeneratorReferencePreview reference={reference} />
            <span><strong>{title}</strong><small>{variant ? `${variant.toUpperCase()} identity reference` : generatorReferenceRoleLabels[reference.role || ""] || "Connected source image"}</small></span>
            {reference.removable && <button type="button" aria-label={`Detach ${title}`} title="Disconnect reference" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeReference(reference); }}><X size={12} /></button>}
          </div>;
        })}
      </div>}
      <div className="generator-reference-divider"><span>IDENTITY LIBRARY</span></div>
      <div className="generator-reference-list nowheel">
        {generator.personas.length > 0 && <div className={`generator-persona-picker ${referencePersonaPickerOpen ? "is-open" : ""}`}>
          <button type="button" className="generator-persona-picker-trigger" aria-expanded={referencePersonaPickerOpen} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setReferencePersonaPickerOpen((open) => !open); }}>
            <span className="generator-persona-picker-avatar">{selectedReferencePersona?.avatarUrl ? <img src={selectedReferencePersona.avatarUrl} alt="" loading="lazy" decoding="async" /> : <UserRound size={14} />}</span>
            <span><small>Selected identity</small><strong>{selectedReferencePersona?.name || "Choose identity"}</strong></span>
            <ChevronDown size={13} />
          </button>
          {referencePersonaPickerOpen && <div className="generator-persona-picker-options nowheel" onWheelCapture={(event) => event.stopPropagation()}>
            {generator.personas.map((persona) => {
              const beforeCount = persona.assets.filter((asset) => asset.role === "before").length;
              const afterCount = persona.assets.filter((asset) => asset.role === "after").length;
              const referenceCount = persona.assets.filter((asset) => asset.role === "reference").length;
              return <button type="button" className={selectedReferencePersona?.id === persona.id ? "is-selected" : ""} key={persona.id} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setReferencePersonaId(persona.id); setReferencePersonaPickerOpen(false); }}>
                <span className="generator-persona-picker-avatar">{persona.avatarUrl ? <img src={persona.avatarUrl} alt="" loading="lazy" decoding="async" /> : <UserRound size={14} />}</span>
                <span><strong>{persona.name}</strong><small>{referenceCount ? `${referenceCount} identity photos` : `${beforeCount} before · ${afterCount} after`}</small></span>
                {selectedReferencePersona?.id === persona.id && <Check size={12} />}
              </button>;
            })}
          </div>}
        </div>}
        {selectedReferencePersona && (() => {
          const reference = selectedReferencePersona.assets.filter((asset) => asset.role === "reference");
          const before = selectedReferencePersona.assets.filter((asset) => asset.role === "before");
          const after = selectedReferencePersona.assets.filter((asset) => asset.role === "after");
          const states = reference.length ? ([['reference', reference]] as const) : ([['before', before], ['after', after]] as const);
          return <div className="generator-persona-option" key={selectedReferencePersona.id}>
            {states.map(([variant, assets]) => <div className="generator-persona-state" key={variant}>
              <header><span>{variant === "reference" ? "identity" : variant}</span><button type="button" disabled={!assets.some((asset) => !attachedReferenceIds.has(asset.id)) || references.length >= maxReferences} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); attachPersonaVariant(selectedReferencePersona, variant); }}>Add available</button></header>
              <div>{assets.map((asset, index) => { const active = attachedReferenceIds.has(asset.id); return <button type="button" className={active ? "is-attached" : ""} disabled={!active && references.length >= maxReferences} title={`${active ? "Remove" : "Attach"} ${selectedReferencePersona.name} ${variant} ${index + 1}`} key={asset.id} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); attachPersonaAsset(selectedReferencePersona, asset); }}><img src={asset.thumbnailUrl || asset.url} alt="" loading="lazy" decoding="async" /><span>{String(index + 1).padStart(2, "0")}</span>{active && <Check size={9} />}</button>; })}{!assets.length && <small>No {variant} photos</small>}</div>
            </div>)}
          </div>;
        })()}
        {!generator.personas.length && <div className="generator-reference-empty"><UserRound size={17} /><span>Add identities in the Identities section first.</span></div>}
      </div>
      </div>
    </div>;
    const renderedGeneratorWidth = liveNodeWidth || data.nodeWidth || generatorWidth;
    const promptMaxHeight = Math.round(Math.min(120, Math.max(44, (Number(renderedGeneratorWidth) / ratioValue) * 0.2)));
    return <article className={`frame-node frame-node--generator generator-${outputMediaType} ${selected ? "is-selected" : ""} ${failed ? "is-failed" : ""}`} style={{ width: renderedGeneratorWidth }}>
      <NodeToolbar isVisible={selected} position={Position.Top} offset={10} className="generator-node-toolbar nodrag nopan">
        <button type="button" className="is-run" disabled={busy || queued || !canGenerate} title={runCreditLabel} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); generator.generateNode(id); }}><Play size={14} fill="currentColor" /><span>Run</span></button>
        <i />
        <button type="button" disabled={!readyOutputUrl} title="Open preview" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); generator.openPreview(id); }}><Expand size={15} /></button>
        <button type="button" disabled={!readyOutputUrl || outputMediaType === "video" || !data.assetId} title="Edit image" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); generator.openEdit(id); }}><WandSparkles size={15} /></button>
        {outputMediaType === "image" && readyOutputUrl && data.assetId && <AddToIdentityPopover personas={generator.personas} sourceUrl={readyOutputUrl} sourceAssetId={data.assetId} onAdd={generator.addToIdentity} onCreate={generator.createIdentityFromAsset} />}
        {readyOutputUrl ? <a href={assetDownloadUrl(readyOutputUrl)} download title="Download" onPointerDown={(event) => event.stopPropagation()}><Download size={15} /></a> : <button type="button" disabled title="Download"><Download size={15} /></button>}
        <i />
        <button type="button" className="is-delete" title="Delete node" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); generator.deleteNode(id); }}><Trash2 size={15} /></button>
      </NodeToolbar>
      <header className="generator-node-title"><span><GeneratorNodeIcon size={15} />{outputMediaType === "video" ? "Video Generator" : "Image Generator"}</span></header>
      <div className={`generator-media-stage ${displayedOutputUrl ? "has-output" : ""} ${generatedOutputs.length ? "has-history" : ""} ${busy && !previewOwnsPlayback ? "is-generating" : ""} ${queued && !previewOwnsPlayback ? "is-queued" : ""} ${failed || outputLoadFailed ? "is-failed" : ""}`} style={{ aspectRatio: ratioCss, "--prompt-max-height": `${promptMaxHeight}px` } as CSSProperties}>
        {outputMediaType === "video" && outputUrl ? <CanvasVideoPlayer src={outputUrl} variant="generator" selectionActive={Boolean(selected)} onDoubleClick={() => generator.openPreview(id)} /> : displayedOutputUrl ? <img key={`${outputUrl}:${outputRetryAttempt}`} className="generator-output-image" src={displayedOutputUrl} alt="Generated output" draggable={false} loading={selected ? "eager" : "lazy"} fetchPriority={selected ? "high" : "auto"} decoding="async" onLoad={outputIsLoaded ? undefined : markOutputLoaded} onError={outputIsLoaded ? undefined : retryOutputLoad} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); if (readyOutputUrl) generator.openPreview(id); }} /> : null}
        {displayedOutputUrl && <div className="generator-output-vignette" />}
        {showCanvasGenerationProgress && <>
          <svg className="generator-running-outline" aria-hidden="true">
            <rect className="generator-running-runner" x="2" y="2" width="calc(100% - 4px)" height="calc(100% - 4px)" rx="26" pathLength="100" />
          </svg>
        </>}
        {busy && !previewOwnsPlayback && <ImageGeneration className="generator-generation-progress" startingLabel="Preparing generation…" generatingLabel={`Creating ${outputMediaType}. This may take a moment.`}><div className={`generator-generation-preview ${displayedOutputUrl ? "has-output" : ""}`} /></ImageGeneration>}
        {queued && !busy && !previewOwnsPlayback && <ImageGeneration className="generator-generation-progress generator-queue-progress" startingLabel={`${outputMediaType === "video" ? "Video" : "Image"} queued…`} generatingLabel={data.queueReason === "provider" ? "Waiting for an available generation slot…" : `Queued. Waiting for ${generator.queueLabel} slot…`}><div className={`generator-generation-preview ${displayedOutputUrl ? "has-output" : ""}`} /></ImageGeneration>}
        {failed && <span className="generator-failed-label" title={String(data.generationError || "Generation failed")}>Failed</span>}
        {outputLoadFailed && <span className="generator-failed-label" title="The generated file exists, but could not be loaded yet">Image unavailable</span>}
        {!activeGeneration && <><div className="generator-stage-top"><b>{data.ratioMode === "original" ? `Original · ${data.aspectRatio || "auto"}` : data.aspectRatio || "4:5"}</b></div>
        <div className={`generator-overlay ${promptFocused ? "is-prompt-focused" : ""} ${promptIsLong ? "has-long-prompt" : ""}`}>
          <textarea ref={promptRef} className="nodrag nopan" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheelCapture={(event) => event.stopPropagation()} onFocus={() => setPromptFocused(true)} onBlur={() => { setPromptFocused(false); window.setTimeout(() => setReferenceMention(null), 120); }} defaultValue={data.prompt || ""} onChange={(event) => { generator.updateNode(id, { prompt: event.target.value }); updateReferenceMention(event.target.value, event.target.selectionStart); }} onKeyDown={(event) => {
            if (!referenceMention || !mentionOptions.length) return;
            if (event.key === "ArrowDown") { event.preventDefault(); setReferenceMentionIndex((current) => (current + 1) % mentionOptions.length); }
            if (event.key === "ArrowUp") { event.preventDefault(); setReferenceMentionIndex((current) => (current - 1 + mentionOptions.length) % mentionOptions.length); }
            if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertReferenceMention(mentionOptions[Math.min(referenceMentionIndex, mentionOptions.length - 1)]); }
            if (event.key === "Escape") { event.preventDefault(); setReferenceMention(null); }
          }} placeholder={data.mediaType === "video" ? "Describe motion, camera and action…" : "Describe the image you want to generate…"} aria-label="Generation prompt" />
          {referenceMention && <div className="generator-mention-menu nodrag nopan" onPointerDown={(event) => event.preventDefault()}>
            <div className="generator-mention-head"><span>REFERENCES</span><small>↑↓ navigate · ↵ insert</small></div>
            <div className="generator-mention-list">
              {mentionOptions.map((reference, index) => <button type="button" className={index === referenceMentionIndex ? "is-active" : ""} key={reference.id} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); insertReferenceMention(reference); }}>
                <GeneratorReferencePreview reference={reference} />
                <span><strong>{reference.title}</strong><small>{generatorReferenceRoleLabels[reference.role || ""] || "Visual reference"} · {reference.token}</small></span>
                <b>{String(reference.referenceIndex + 1).padStart(2, "0")}</b>
              </button>)}
              {!mentionOptions.length && <div className="generator-mention-empty">No matching references</div>}
            </div>
          </div>}
          <div className="generator-node-controls nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
            <div className="generator-count-control" aria-describedby={`generation-count-${id}`}>
              <span id={`generation-count-${id}`} role="tooltip" className="generator-count-tooltip">{generationCountLabel}</span>
              <div className="generator-count">
                <button onClick={() => generator.updateNode(id, { generationCount: Math.max(1, generationCount - 1) })} aria-label="Decrease generator nodes">−</button>
                <b>×{generationCount}</b>
                <button onClick={() => generator.updateNode(id, { generationCount: Math.min(MAX_GENERATION_BATCH, generationCount + 1) })} aria-label="Increase generator nodes">+</button>
              </div>
            </div>
            <GeneratorSelect menuKey="model" openMenu={openGeneratorMenu} setOpenMenu={setOpenGeneratorMenu} className="generator-model-control" value={data.modelId || selectedModel?.id || ""} label={outputMediaType === "video" ? "VIDEO MODELS" : "IMAGE MODELS"} options={availableModels.map((model) => ({ value: model.id, label: model.label, description: generatorModelCreditDescription(model, { resolution: model.id === selectedModel?.id ? data.resolution : undefined, duration: model.id === selectedModel?.id ? data.duration : undefined, referenceCount: references.length, generateAudio: model.id === selectedModel?.id ? generatedAudioEnabled : model.defaultGenerateAudio, hasVideoInput, inputVideoDurationSeconds }) }))} onChange={(value) => { const model = generator.models.find((item) => item.id === value); const next = generatorSettingsForModel(model, { aspectRatio: data.aspectRatio, resolution: data.resolution, duration: data.duration }, references.length > 0, hasVideoInput); generator.updateNode(id, { modelId: value, mediaType: model?.mediaType || "image", aspectRatio: next.aspectRatio as FrameNode["data"]["aspectRatio"], ratioMode: data.ratioMode === "original" && !next.preservedAspectRatio ? "custom" : data.ratioMode, resolution: next.resolution as FrameNode["data"]["resolution"], duration: next.duration as FrameNode["data"]["duration"], generateAudio: model?.defaultGenerateAudio ?? false }); }} />
            <GeneratorSelect menuKey="ratio" openMenu={openGeneratorMenu} setOpenMenu={setOpenGeneratorMenu} className="generator-ratio-control" value={data.ratioMode === "original" ? "original" : data.aspectRatio || ratios[0] || "1:1"} label="RATIO" options={ratioOptions} onChange={chooseRatio} />
            <GeneratorSelect menuKey="quality" openMenu={openGeneratorMenu} setOpenMenu={setOpenGeneratorMenu} className="generator-quality-control" value={resolutions.includes(String(data.resolution || "")) ? String(data.resolution) : resolutions.includes(selectedModel?.defaultResolution || "") ? selectedModel!.defaultResolution! : resolutions[0] || "1K"} label="QUALITY" options={resolutions.map((resolution) => ({ value: resolution, label: resolution }))} onChange={(value) => {
              const nextRatios = generatorRatiosFor(selectedModel, value, references.length > 0);
              const currentRatio = String(data.aspectRatio || selectedModel?.defaultRatio || "1:1");
              const nextRatio = nextRatios.includes(currentRatio) ? currentRatio : nextRatios.includes(selectedModel?.defaultRatio || "") ? selectedModel!.defaultRatio! : nextRatios[0];
              generator.updateNode(id, { resolution: value as FrameNode["data"]["resolution"], aspectRatio: nextRatio as FrameNode["data"]["aspectRatio"], ratioMode: nextRatio === currentRatio ? data.ratioMode : "custom" });
            }} />
            {outputMediaType === "video" && Boolean(selectedModel?.durations?.length) && <GeneratorSelect menuKey="duration" openMenu={openGeneratorMenu} setOpenMenu={setOpenGeneratorMenu} className="generator-duration-control" value={data.duration || selectedModel?.defaultDuration || selectedModel?.durations?.[0] || "5"} label="DURATION" options={selectedModel!.durations!.map((duration) => ({ value: duration, label: `${duration}s` }))} onChange={(value) => generator.updateNode(id, { duration: value as FrameNode["data"]["duration"] })} />}
            {outputMediaType === "video" && selectedModel?.supportsAudio && <button type="button" className={`generator-sound-control ${generatedAudioEnabled ? "is-on" : ""}`} title={generatedAudioEnabled ? "Generated audio on" : "Generated audio off"} aria-label={generatedAudioEnabled ? "Disable generated audio" : "Enable generated audio"} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); generator.updateNode(id, { generateAudio: !generatedAudioEnabled }); }}>{generatedAudioEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}</button>}
            <button type="button" className={`generator-assistant-trigger generator-assistant-control ${assistantOpen ? "is-active" : ""}`} aria-label="Open prompt assistant" title="Prompt assistant" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpenGeneratorMenu(null); setAssistantOpen((open) => !open); }}><AssistantGlyph size={13} /></button>
            <div className={`generator-run-control ${openGeneratorMenu === "run" ? "is-open" : ""}`}>
              <span id={`generation-cost-${id}`} role="tooltip" className="generator-credit-tooltip">{runCreditLabel}</span>
              <button className="generator-run" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpenGeneratorMenu(null); generator.generateNode(id); }} disabled={busy || queued || !canGenerate} aria-label={`Generate this node · ${runCredits} credits`} aria-describedby={`generation-cost-${id}`}>{busy ? <span className="generator-spinner" /> : <Play size={15} fill="currentColor" />}</button>
              <button type="button" className="generator-run-more" disabled={busy || queued || !canGenerate} aria-label="More generation options" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpenGeneratorMenu(openGeneratorMenu === "run" ? null : "run"); }}><ChevronDown size={9} /></button>
              {openGeneratorMenu === "run" && <div className="generator-run-menu">
                <button type="button" onPointerDown={(event) => { event.stopPropagation(); setOpenGeneratorMenu(null); generator.generateNode(id); }}><Play size={13} /><span><strong>This node only</strong><small>Generate only this block</small></span></button>
                <button type="button" disabled={!generator.hasDownstreamGenerator(id)} onPointerDown={(event) => { event.stopPropagation(); setOpenGeneratorMenu(null); generator.generateChain(id); }}><Workflow size={13} /><span><strong>Run from here</strong><small>{generator.hasDownstreamGenerator(id) ? "Continue through connected generators" : "Connect another generator first"}</small></span></button>
              </div>}
            </div>
          </div>
        </div></>}
      </div>
      {generatedOutputs.length > 0 && <div className={`generator-output-history nodrag nopan ${outputGalleryOpen ? "is-open" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" className="generator-history-trigger" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOutputGalleryOpen((open) => !open); }} aria-label={`${generatedOutputs.length} generated images`} aria-expanded={outputGalleryOpen}><Images size={13} /><b>{generatedOutputs.length}</b><ChevronDown size={11} /></button>
        {outputGalleryOpen && <div className="generator-history-panel">
          <div className="generator-history-head"><span>NODE OUTPUTS</span><b>{generatedOutputs.length} SAVED</b></div>
          <div className="generator-history-grid" onWheel={(event) => event.stopPropagation()}>{generatedOutputs.map((output, index) => <button type="button" key={`${output.url}-${index}`} className={output.url === outputUrl ? "is-active" : ""} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); selectGeneratedOutput(index); }} aria-label={`Show generated output ${index + 1}`}>
            <img src={assetThumbnailUrl(output.url)} alt={`Generated output ${index + 1}`} loading="lazy" decoding="async" fetchPriority="low" />
            <span>{String(index + 1).padStart(2, "0")}</span>
          </button>)}</div>
        </div>}
      </div>}
      {assistantOpen && <section className="generator-prompt-assistant nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
        <header className="generator-assistant-head">
          <span>ASSISTANT</span>
          <button type="button" aria-label="Close prompt assistant" onPointerDown={(event) => { event.stopPropagation(); setAssistantOpen(false); setAssistantMention(null); }}><X size={13} /></button>
        </header>
        <div className="generator-assistant-references">
          <div className="generator-assistant-reference-title"><span>CONNECTED REFERENCES</span><small>Click or type @ to mention</small></div>
          <div className="generator-assistant-reference-strip">
            {allMentionOptions.map((reference) => <button type="button" key={reference.id} className={data.demoAssistantReferenceId === reference.id ? "is-demo-selecting" : ""} title={`Insert ${reference.token}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); insertAssistantMention(reference); }}>
              <GeneratorReferencePreview reference={reference} /><span><strong>{reference.title}</strong><small>{generatorReferenceRoleLabels[reference.role || ""] || "Visual reference"} · {reference.token}</small></span>
              {data.demoAssistantReferenceId === reference.id && <i className="generator-assistant-demo-pointer" aria-hidden="true"><MousePointer2 size={17} /></i>}
            </button>)}
            {!allMentionOptions.length && <p>No references connected. The assistant can still structure a text-only prompt.</p>}
          </div>
        </div>
        <div className="generator-assistant-compose">
          <textarea ref={assistantRef} value={assistantBrief} autoFocus placeholder={outputMediaType === "video" ? "Describe one shot: subject action, camera movement and timing. Use @ to assign start, end, motion or audio references…" : "Describe the result in your own words. Use @ to assign identity, pose, location or composition references…"} onChange={(event) => { assistantBriefValueRef.current = event.target.value; setAssistantBrief(event.target.value); setAssistantError(""); updateAssistantMention(event.target.value, event.target.selectionStart); }} onKeyDown={(event) => {
            if (assistantMention && assistantMentionOptions.length) {
              if (event.key === "ArrowDown") { event.preventDefault(); setAssistantMentionIndex((current) => (current + 1) % assistantMentionOptions.length); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setAssistantMentionIndex((current) => (current - 1 + assistantMentionOptions.length) % assistantMentionOptions.length); return; }
              if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertAssistantMention(assistantMentionOptions[Math.min(assistantMentionIndex, assistantMentionOptions.length - 1)]); return; }
              if (event.key === "Escape") { event.preventDefault(); setAssistantMention(null); return; }
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void buildPromptWithAssistant(); }
          }} onWheelCapture={(event) => event.stopPropagation()} />
          {assistantMention && <div className="generator-assistant-mention-menu">
            {assistantMentionOptions.map((reference, index) => <button type="button" className={index === assistantMentionIndex ? "is-active" : ""} key={reference.id} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); insertAssistantMention(reference); }}><GeneratorReferencePreview reference={reference} /><span><strong>{reference.title}</strong><small>{generatorReferenceRoleLabels[reference.role || ""] || "Visual reference"} · {reference.token}</small></span></button>)}
            {!assistantMentionOptions.length && <p>No matching references</p>}
          </div>}
        </div>
        {assistantError && <p className="generator-assistant-error">{assistantError}</p>}
        <footer className="generator-assistant-foot"><GeneratorSelect menuKey="prompt-assistant-model" openMenu={openGeneratorMenu} setOpenMenu={setOpenGeneratorMenu} className="prompt-assistant-model-select" value={normalizeAssistantModelId(data.textModelId)} label="ASSISTANT MODEL" options={assistantModels.map((model) => ({ value: model.id, label: model.label, description: assistantModelCreditDescription(model, { inputCharacters: assistantBrief.length + String(connectedText?.text || "").length, imageCount: references.length, outputTokens: 1_800 }) }))} onChange={(value) => generator.updateNode(id, { textModelId: value })} /><button type="button" className={data.demoAssistantBuild ? "is-demo-selecting" : ""} disabled={assistantBusy || !assistantBrief.trim()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void buildPromptWithAssistant(); }}>{assistantBusy && <span className="generator-spinner" />}<b>{assistantBusy ? "Building" : "Build prompt"}</b>{data.demoAssistantBuild && <i className="generator-assistant-demo-pointer is-build" aria-hidden="true"><MousePointer2 size={17} /></i>}</button></footer>
      </section>}
      <div className="generator-semantic-ports nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
        <div className="generator-text-port" title="Text prompt input"><Handle id="text-input" type="target" position={Position.Left} /><span>T</span></div>
        {inputPorts.map((port) => <div key={port.id} data-port-id={port.id} className={`generator-semantic-port is-${port.kind} ${openGeneratorMenu === "references" && port.id === referenceMenuPortId ? "is-open" : ""}`}>
          <Handle id={`${port.id}-input`} type="target" position={Position.Left} />
          <button type="button" aria-label={port.label} title={`${port.label}${port.required ? " · required" : ""}`} onPointerDown={(event) => { event.stopPropagation(); const closing = openGeneratorMenu === "references" && referenceMenuPortId === port.id; setReferenceMenuPortId(port.id); setOpenGeneratorMenu(closing ? null : "references"); }}>
            {port.kind === "video" ? <Video size={14} /> : port.kind === "audio" ? <Volume2 size={14} /> : <ImageIcon size={14} />}
            {port.required && <i />}
          </button>
          <span>{port.label}</span>
          {port.id === referenceMenuPortId && referenceMenu}
        </div>)}
      </div>
      <Handle id="output" type="source" position={Position.Right} className="node-next-button nodrag nopan generator-next-button" title={outputUrl ? "Drag to connect · click to continue" : "Drag to connect · click to add the next generator"} aria-label="Connect or create next node" onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent(OPEN_NODE_CREATOR_EVENT, { detail: { nodeId: id, clientX: event.clientX, clientY: event.clientY } })); }}>{outputMediaType === "video" ? <Video size={14} /> : <ImageIcon size={14} />}</Handle>
      <button type="button" className="node-resize-corner nodrag nopan" aria-label="Resize node proportionally" onPointerDown={(event) => beginProportionalResize(event, Number(renderedGeneratorWidth), 330, 920)}>
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <path className="resize-grip-outer" d="M6 30h10c7.7 0 14-6.3 14-14V6" />
        </svg>
      </button>
    </article>;
  }
  if (data.kind === "note") {
    const renderedNoteWidth = liveNodeWidth || data.nodeWidth || 330;
    const renderedNoteHeight = liveNodeHeight || data.nodeHeight || 410;
    return <article className={`frame-node frame-node--sticky-note sticky-note-${data.noteColor || "yellow"} ${selected ? "is-selected" : ""}`} style={{ width: renderedNoteWidth, height: renderedNoteHeight }}>
      <header className="sticky-note-head"><span><StickyNote size={13} /> NOTE</span><small>{String(data.noteText || "").length}</small></header>
      <textarea
        className="sticky-note-editor nodrag nopan"
        value={String(data.noteText || "")}
        onChange={(event) => generator?.updateNode(id, { noteText: event.target.value })}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        placeholder="Write anything…"
        spellCheck
      />
      <footer className="sticky-note-foot"><span>Scenelith</span><small>Canvas note</small></footer>
      <button type="button" className="node-resize-corner nodrag nopan" aria-label="Resize note" onPointerDown={(event) => beginNoteResize(event, Number(renderedNoteWidth), Number(renderedNoteHeight))}>
        <svg viewBox="0 0 36 36" aria-hidden="true"><path className="resize-grip-outer" d="M6 30h10c7.7 0 14-6.3 14-14V6" /></svg>
      </button>
    </article>;
  }
  if (data.kind === "videoMaster" && generator) {
    const clips = [...(data.videoMasterClips || [])].sort((left, right) =>
      Number(left.sequenceIndex ?? videoMasterLegacyOrder(left, 0)) - Number(right.sequenceIndex ?? videoMasterLegacyOrder(right, 0)));
    const selectedClip = clips.find((clip) => clip.id === videoMasterSelectedClipId)
      || clips.find((clip) => clip.id === data.videoMasterSelectedClipId)
      || clips[0];
    const selectedIndex = selectedClip ? clips.findIndex((clip) => clip.id === selectedClip.id) : -1;
    const masterOutputEntries = clips.flatMap((clip, clipIndex) => videoMasterGeneratedOutputs(clip).map((output, outputIndex) => ({
      clip,
      clipIndex,
      output,
      outputIndex,
    })));
    const visibleMasterOutputEntries = videoMasterOutputFilter === "all"
      ? masterOutputEntries
      : masterOutputEntries.filter((entry) => entry.clip.id === selectedClip?.id);
    const sceneReferences = selectedClip ? generator.getReferences(id, selectedClip.id) : [];
    const hasVideoInput = sceneReferences.some((reference) => reference.role === "reference-video" || reference.role === "motion-video");
    const videoModels = videoMasterModelsForScene(generator.models, selectedClip, sceneReferences);
    const selectedModel = videoModels.find((model) => model.id === selectedClip?.modelId)
      || videoModels[0]
      || generator.models.find((model) => model.mediaType === "video");
    const inputPorts = selectedModel?.inputPorts || [];
    const maxReferences = selectedModel?.maxReferences || inputPorts.reduce((sum, port) => sum + Math.max(1, Number(port.max || 1)), 0) || 1;
    const ratios = generatorRatiosFor(selectedModel, selectedClip?.resolution, sceneReferences.length > 0).filter((ratio) => ratio !== "source");
    const sourceAspectRatio = videoMasterSourceRatio(selectedClip, Number(data.videoAspectRatio));
    const originalAspectRatio = nearestVideoMasterRatio(sourceAspectRatio, ratios);
    const selectedAspectRatio = selectedClip?.aspectRatioMode === "custom" ? selectedClip.aspectRatio || originalAspectRatio : originalAspectRatio;
    const ratioOptions: SelectOption[] = selectedClip ? [
      { value: "original", label: `Original · ${originalAspectRatio}`, description: "Match this source clip", glyphValue: "original" },
      ...ratios.filter((ratio) => /^\d+:\d+$/.test(ratio)).map((ratio) => ({ value: ratio, label: ratio, glyphValue: ratio })),
    ] : [];
    const generationDuration = videoMasterGenerationDuration(selectedModel, selectedClip);
    const timelineDuration = videoMasterTimelineDuration(selectedClip);
    const masterDurationOptions: SelectOption[] = videoMasterGenerationDurationChoices(selectedModel, selectedClip).map((duration) => ({
      value: String(duration),
      label: `${duration}s`,
      description: duration < timelineDuration - .01 ? `Uses first ${duration}s of this scene` : undefined,
    }));
    const resolutions = generatorResolutionsFor(selectedModel, hasVideoInput);
    const generatedAudioEnabled = selectedClip?.generateAudio ?? selectedModel?.defaultGenerateAudio ?? false;
    const missingRequiredInputs = inputPorts.filter((port) => port.required && !sceneReferences.some((reference) => reference.role === port.id));
    const selectedPlaybackMedia = videoMasterClipPlaybackMedia(selectedClip, videoMasterSelectedLane, videoMasterLaneVisibility);
    const masterPlaybackSources = clips.flatMap((clip) => [
      videoMasterClipPlaybackMedia(clip, "original", { output: false, original: true }).url,
      videoMasterClipPlaybackMedia(clip, "output", { output: true, original: false }).url,
    ]).filter(Boolean);
    const clipMediaUrl = selectedPlaybackMedia.url;
    const clipStart = selectedPlaybackMedia.start;
    const clipEnd = selectedPlaybackMedia.end;
    const nextClip = selectedIndex >= 0 ? clips[selectedIndex + 1] : undefined;
    const nextPlaybackMedia = nextClip ? videoMasterClipPlaybackMedia(nextClip, videoMasterSelectedLane, videoMasterLaneVisibility) : undefined;
    const seamlessNext = Boolean(nextPlaybackMedia?.url
      && editorPlaybackUrl(nextPlaybackMedia.url) === editorPlaybackUrl(selectedPlaybackMedia.url)
      && Math.abs(selectedPlaybackMedia.end - nextPlaybackMedia.start) <= .04);
    const playbackDurations = clips.map((clip) => videoMasterClipPlaybackMedia(clip, videoMasterSelectedLane, videoMasterLaneVisibility).duration);
    const totalDuration = playbackDurations.reduce((sum, duration) => sum + duration, 0);
    const selectedClipOffset = selectedIndex > 0 ? playbackDurations.slice(0, selectedIndex).reduce((sum, duration) => sum + duration, 0) : 0;
    const masterTimelineTime = Math.min(totalDuration, Math.max(0, selectedClipOffset + videoMasterTransportRelativeTime));
    const preparingMasterClipId = generator.preparingMasterClipIds[id];
    const masterPreparing = Boolean(selectedClip && preparingMasterClipId === selectedClip.id);
    const masterGeneratingClipId = preparingMasterClipId || data.videoMasterGeneratingClipId;
    const masterHasActiveGeneration = Boolean(preparingMasterClipId || (data.videoMasterGeneratingClipId && (data.status === "queued" || data.status === "working")));
    const masterGenerationTargetsScene = Boolean(selectedClip && masterGeneratingClipId === selectedClip.id);
    const masterBusy = Boolean(masterGenerationTargetsScene && masterHasActiveGeneration);
    const masterFailed = Boolean(masterGenerationTargetsScene && data.status === "failed");
    const originalDownloads = videoMasterDownloadAvailability(clips, "original", selectedClip?.id);
    const outputDownloads = videoMasterDownloadAvailability(clips, "output", selectedClip?.id);
    const masterDownloadOpen = openGeneratorMenu === "master-download";
    const exportAvailability = videoMasterExportLane === "original" ? originalDownloads : outputDownloads;
    const exportReady = videoMasterExportScope === "scene" ? exportAvailability.selected : exportAvailability.all;
    const exportDuration = clips.reduce((sum, clip) => sum + videoMasterClipPlaybackMedia(clip, videoMasterExportLane, {
      output: videoMasterExportLane === "output",
      original: videoMasterExportLane === "original",
    }).duration, 0);
    const runResolution = resolutions.includes(String(selectedClip?.resolution || ""))
      ? String(selectedClip?.resolution)
      : resolutions.includes(selectedModel?.defaultResolution || "")
        ? selectedModel!.defaultResolution!
        : resolutions[0] || "720P";
    const runCredits = selectedModel && selectedClip
      ? generationCreditCost(selectedModel.id, runResolution, String(generationDuration || timelineDuration || selectedModel.defaultDuration || 5), sceneReferences.length, {
        generateAudio: generatedAudioEnabled,
        hasVideoInput,
        inputVideoDurationSeconds: sceneReferences.filter((reference) => reference.role === "reference-video" || reference.role === "motion-video").reduce((sum, reference) => sum + Math.max(0, Number(reference.durationSeconds || 0)), 0),
      })
      : 0;
    const updateClip = (clipId: string, patch: Partial<VideoMasterClip>) => generator.updateNode(id, {
      videoMasterClips: clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip),
    });
    const applyMasterOutput = (targetClipId: string, output: VideoMasterGeneratedOutput, selectTarget = true) => {
      const nextClips = applyVideoMasterGeneratedOutput(clips, targetClipId, output);
      const targetClip = nextClips.find((clip) => clip.id === targetClipId);
      if (!targetClip) return;
      videoPlaybackManager.pause(videoMasterPlaybackOwnerId);
      setVideoMasterSequencePlaying(false);
      setVideoMasterRelativeTime(0);
      setVideoMasterSeekRequest(null);
      setVideoMasterSelectedLane("output");
      setVideoMasterOutputTarget(null);
      if (selectTarget) {
        videoMasterInternalSelectionRef.current = targetClip.id;
        videoMasterLiveSelectionOwnedRef.current = true;
        setVideoMasterSelectedClipId(targetClip.id);
      }
      generator.saveNow(id, {
        videoMasterClips: nextClips,
        ...(selectTarget ? {
          videoMasterSelectedClipId: targetClip.id,
          prompt: targetClip.prompt,
          modelId: targetClip.modelId,
          duration: String(videoMasterGenerationDuration(generator.models.find((model) => model.id === targetClip.modelId), targetClip) || targetClip.duration),
        } : {}),
      });
    };
    const selectClip = (clip: VideoMasterClip, continuePlayback = false, relativeTime = 0, lane: "output" | "original" = videoMasterSelectedLane, explicitPlayback = false, continuousPlayback = false) => {
      const clipModel = generator.models.find((model) => model.id === clip.modelId)
        || generator.models.find((model) => model.mediaType === "video");
      generator.selectNode(id);
      generator.focusMasterClipSource(id, clip.id);
      const playbackDuration = videoMasterClipPlaybackMedia(clip, lane, videoMasterLaneVisibility).duration;
      const safeRelativeTime = Math.min(playbackDuration, Math.max(0, relativeTime));
      // This ref changes in the click handler, before React commits the new
      // selected clip. Any completion arriving from the previous transport in
      // that window is stale and must not advance/replace the user's choice.
      videoMasterPlaybackTargetRef.current = `${clip.id}:${lane}`;
      videoMasterInternalSelectionRef.current = clip.id;
      videoMasterLiveSelectionOwnedRef.current = true;
      setVideoMasterSelectedClipId(clip.id);
      setVideoMasterRelativeTime(safeRelativeTime);
      setVideoMasterSelectedLane(lane);
      setVideoMasterSeekRequest(null);
      setVideoMasterSequencePlaying(continuePlayback || explicitPlayback);
      if (continuePlayback || explicitPlayback) {
        videoPlaybackManager.play(videoMasterPlaybackOwnerId, `${clip.id}:${lane}`, {
          relativeTime: safeRelativeTime,
          intent: continuePlayback && !explicitPlayback ? "sequence" : "manual",
          continuous: continuousPlayback,
        });
        queueVideoMasterPlay(clip.id, lane, safeRelativeTime);
      }
      setOpenGeneratorMenu(null);
      setReferencePersonaPickerOpen(false);
      setReferenceMenuPortId(clipModel?.inputPorts?.[0]?.id || "reference-image");
      generator.updateNode(id, {
        videoMasterSelectedClipId: clip.id,
        prompt: clip.prompt,
        modelId: clip.modelId || clipModel?.id,
        duration: String(videoMasterGenerationDuration(clipModel, clip) || Math.max(1, Math.round(clip.duration || 5))),
      });
    };
    const seekMasterTimeline = (nextTime: number) => {
      if (videoMasterSequencePlaying) videoPlaybackManager.pause(videoMasterPlaybackOwnerId, `${selectedClip?.id || ""}:${videoMasterSelectedLane}`);
      setVideoMasterSequencePlaying(false);
      setVideoMasterPlayRequest(null);
      const targetTime = Math.min(Math.max(.1, totalDuration), Math.max(0, nextTime));
      let offset = 0;
      const targetClip = clips.find((clip, index) => {
        const duration = playbackDurations[index] || Math.max(.1, Number(clip.duration || 0));
        const isLast = index === clips.length - 1;
        if (targetTime < offset + duration || isLast) return true;
        offset += duration;
        return false;
      });
      if (!targetClip) return;
      const targetIndex = clips.findIndex((clip) => clip.id === targetClip.id);
      const relativeTime = Math.min(playbackDurations[targetIndex] || Math.max(.1, Number(targetClip.duration || 0)), Math.max(0, targetTime - offset));
      if (targetClip.id !== selectedClip?.id) selectClip(targetClip, false, relativeTime, videoMasterSelectedLane);
      else setVideoMasterRelativeTime(relativeTime);
      setVideoMasterSeekRequest((current) => ({ clipId: targetClip.id, time: relativeTime, version: (current?.version || 0) + 1 }));
    };
    const removeClip = () => {
      if (!selectedClip) return;
      generator.removeMasterClip(id, selectedClip.id);
    };
    const addBlankClip = () => {
      const clip: VideoMasterClip = {
        id: `master-clip-${crypto.randomUUID()}`,
        sequenceIndex: clips.length,
        title: `Scene ${String(clips.length + 1).padStart(2, "0")}`,
        role: clips.length ? "scene" : "hook",
        origin: "generated",
        duration: Number(selectedModel?.defaultDuration || selectedModel?.durations?.[0] || 5),
        generationDuration: Number(selectedModel?.defaultDuration || selectedModel?.durations?.[0] || 5),
        prompt: "",
        modelId: selectedModel?.id,
        aspectRatio: selectedModel?.defaultRatio || selectedModel?.ratios?.find((ratio) => ratio !== "source") || "9:16",
        aspectRatioMode: "custom",
        resolution: selectedModel?.defaultResolution || selectedModel?.resolutions?.[0] || "720p",
        generateAudio: selectedModel?.defaultGenerateAudio ?? false,
      };
      videoMasterInternalSelectionRef.current = clip.id;
      videoMasterLiveSelectionOwnedRef.current = true;
      setVideoMasterSelectedClipId(clip.id);
      generator.updateNode(id, {
        videoMasterClips: [...clips, clip],
        videoMasterSelectedClipId: clip.id,
        prompt: "",
        modelId: clip.modelId,
        duration: String(clip.duration),
      });
    };
    const attachedReferences = selectedClip?.attachedReferences || [];
    const attachedReferenceIds = new Set(attachedReferences.map((reference) => reference.assetId));
    const attachedPersonaId = attachedReferences.find((reference) => reference.personaId && generator.personas.some((persona) => persona.id === reference.personaId))?.personaId || "";
    const selectedReferencePersona = generator.personas.find((persona) => persona.id === referencePersonaId)
      || generator.personas.find((persona) => persona.id === attachedPersonaId)
      || null;
    const activeReferencePort = inputPorts.find((port) => port.id === referenceMenuPortId) || inputPorts[0];
    const attachPersonaAsset = (persona: PersonaRecord, asset: PersonaRecord["assets"][number]) => {
      if (!selectedClip || activeReferencePort?.kind !== "image") return;
      if (attachedReferenceIds.has(asset.id)) {
        updateClip(selectedClip.id, { attachedReferences: attachedReferences.filter((reference) => reference.assetId !== asset.id) });
        return;
      }
      if (sceneReferences.length >= maxReferences) return;
      updateClip(selectedClip.id, { attachedReferences: [...attachedReferences, {
        assetId: asset.id,
        url: asset.url,
        title: `${persona.name} · ${asset.role} ${persona.assets.filter((item) => item.role === asset.role).findIndex((item) => item.id === asset.id) + 1}`,
        thumbnailUrl: asset.thumbnailUrl,
        personaId: persona.id,
        variant: asset.role,
        role: activeReferencePort.id as GeneratorInputRole,
      }] });
    };
    const attachPersonaVariant = (persona: PersonaRecord, variant: "reference" | "before" | "after") => {
      if (!selectedClip || activeReferencePort?.kind !== "image") return;
      const additions = persona.assets
        .filter((asset) => asset.role === variant && !attachedReferenceIds.has(asset.id))
        .slice(0, Math.max(0, maxReferences - sceneReferences.length))
        .map((asset, index) => ({ assetId: asset.id, url: asset.url, thumbnailUrl: asset.thumbnailUrl, title: `${persona.name} · ${variant} ${index + 1}`, personaId: persona.id, variant, role: activeReferencePort.id as GeneratorInputRole }));
      if (additions.length) updateClip(selectedClip.id, { attachedReferences: [...attachedReferences, ...additions] });
    };
    const removeReference = (reference: GeneratorReference) => {
      if (!selectedClip) return;
      if (reference.sourceNodeId) generator.disconnectReference(id, reference.sourceNodeId, reference.edgeId);
      else if (selectedClip.origin !== "upload" && reference.role === "reference-video" && reference.url === selectedClip.sourceUrl) updateClip(selectedClip.id, moveUploadedMasterClipToLane(selectedClip, "output"));
      else if (reference.assetId) updateClip(selectedClip.id, { attachedReferences: attachedReferences.filter((item) => item.assetId !== reference.assetId) });
    };
    const mentionOptions = sceneReferences.map((reference, index) => ({ ...reference, referenceIndex: index, token: referenceMentionToken(reference.title, index) }))
      .filter((reference) => !referenceMention?.query || `${reference.title} ${reference.token}`.toLocaleLowerCase().includes(referenceMention.query.toLocaleLowerCase()));
    const updateMasterMention = (value: string, caret: number) => {
      const match = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/u);
      if (!match || !sceneReferences.length) { setReferenceMention(null); return; }
      setReferenceMention({ start: value.slice(0, caret).lastIndexOf("@"), query: match[1] || "" });
      setReferenceMentionIndex(0);
    };
    const insertMasterMention = (reference: (typeof mentionOptions)[number]) => {
      if (!selectedClip || !referenceMention) return;
      const textarea = promptRef.current;
      const caret = textarea?.selectionStart ?? selectedClip.prompt.length;
      const nextPrompt = `${selectedClip.prompt.slice(0, referenceMention.start)}${reference.token} ${selectedClip.prompt.slice(caret)}`;
      const nextCaret = referenceMention.start + reference.token.length + 1;
      updateClip(selectedClip.id, { prompt: nextPrompt });
      generator.updateNode(id, { prompt: nextPrompt });
      setReferenceMention(null);
      window.requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(nextCaret, nextCaret); });
    };
    const masterAssistantReferences = sceneReferences.map((reference, index) => ({ ...reference, referenceIndex: index, token: referenceMentionToken(reference.title, index) }));
    const masterOriginalReference = masterClipOriginalReference(selectedClip);
    const masterOriginalConnectedReference = masterOriginalReference
      ? masterAssistantReferences.find((reference) => reference.assetId === masterOriginalReference.assetId && reference.role === "reference-video")
      : undefined;
    const masterOriginalAssistantReference = masterOriginalReference ? {
      ...masterOriginalReference,
      aspectRatio: sourceAspectRatio,
      removable: false,
      referenceIndex: masterOriginalConnectedReference?.referenceIndex ?? masterAssistantReferences.length,
      token: masterOriginalConnectedReference?.token ?? referenceMentionToken(masterOriginalReference.title, masterAssistantReferences.length),
    } : undefined;
    const masterOtherAssistantReferences = masterAssistantReferences.filter((reference) => reference !== masterOriginalConnectedReference);
    const masterAssistantMentionReferences = masterOriginalAssistantReference
      ? [masterOriginalAssistantReference, ...masterOtherAssistantReferences]
      : masterOtherAssistantReferences;
    const masterAssistantMentionOptions = masterAssistantMentionReferences.filter((reference) => !assistantMention?.query || `${reference.title} ${reference.token}`.toLocaleLowerCase().includes(assistantMention.query.toLocaleLowerCase()));
    const updateMasterAssistantMention = (value: string, caret: number) => {
      const prefix = value.slice(0, caret);
      const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u);
      if (!match || !masterAssistantReferences.length) { setAssistantMention(null); return; }
      setAssistantMention({ start: prefix.lastIndexOf("@"), query: match[1] || "" });
      setAssistantMentionIndex(0);
    };
    const insertMasterAssistantMention = (reference: (typeof masterAssistantReferences)[number]) => {
      const textarea = assistantRef.current;
      const currentBrief = textarea?.value ?? assistantBriefValueRef.current ?? assistantBrief;
      const caret = textarea?.selectionStart ?? currentBrief.length;
      const start = assistantMention?.start ?? caret;
      const before = currentBrief.slice(0, start);
      const after = currentBrief.slice(caret);
      const separator = before && !/\s$/u.test(before) ? " " : "";
      const nextBrief = `${before}${separator}${reference.token} ${after}`;
      const nextCaret = before.length + separator.length + reference.token.length + 1;
      assistantBriefValueRef.current = nextBrief;
      setAssistantBrief(nextBrief);
      setAssistantError("");
      setAssistantMention(null);
      window.requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(nextCaret, nextCaret); });
    };
    const buildMasterPromptWithAssistant = async () => {
      if (!selectedClip) return;
      const brief = String(assistantRef.current?.value || assistantBriefValueRef.current || assistantBrief).trim();
      if (!brief || assistantBusy) return;
      setAssistantBusy(true);
      setAssistantError("");
      try {
        const prompt = await generator.composeMasterPrompt(id, selectedClip.id, brief);
        if (promptRef.current) promptRef.current.value = prompt;
        assistantBriefValueRef.current = "";
        setAssistantBrief("");
        setAssistantOpen(false);
        setAssistantMention(null);
      } catch (error) {
        setAssistantError(error instanceof Error ? error.message : "Prompt assistant failed");
      } finally {
        setAssistantBusy(false);
      }
    };
    const referenceMenu = openGeneratorMenu === "references" && activeReferencePort && <div className="generator-reference-menu nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()} onWheelCapture={(event) => event.stopPropagation()}>
      <div className="generator-reference-menu-head"><span>REFERENCES</span><b>{sceneReferences.length} ATTACHED</b></div>
      <div className="generator-reference-capacity"><span>{activeReferencePort.label}</span><small>{activeReferencePort.required ? "Required input" : "Optional input"} · up to {activeReferencePort.max || maxReferences}</small></div>
      <div className="generator-reference-scroll nowheel" onWheelCapture={(event) => { if ((event.target as HTMLElement).closest(".generator-persona-picker-options")) return; event.stopPropagation(); }}>
        {sceneReferences.length > 0 && <div className="generator-reference-current">{sceneReferences.map((reference) => {
          const roleLabel = generatorReferenceRoleLabels[reference.role || ""] || "Connected reference";
          const durationLabel = Number(reference.durationSeconds || 0) > 0 ? ` · ${Number(reference.durationSeconds).toFixed(1)}s` : "";
          return <div className="generator-reference-row" key={`${reference.role}:${reference.id}`}><GeneratorReferencePreview reference={reference} /><span><strong>{reference.title}</strong><small>{roleLabel}{durationLabel}</small></span>{reference.removable && <button type="button" aria-label={`Detach ${reference.title}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeReference(reference); }}><X size={12} /></button>}</div>;
        })}</div>}
        {!sceneReferences.length && <div className="generator-reference-empty"><Images size={17} /><span>Connect media from the canvas to this scene.</span></div>}
        {activeReferencePort.kind === "image" && <><div className="generator-reference-divider"><span>IDENTITY LIBRARY</span></div><div className="generator-reference-list nowheel">
          {generator.personas.length > 0 && <div className={`generator-persona-picker ${referencePersonaPickerOpen ? "is-open" : ""}`}><button type="button" className="generator-persona-picker-trigger" aria-expanded={referencePersonaPickerOpen} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setReferencePersonaPickerOpen((open) => !open); }}><span className="generator-persona-picker-avatar">{selectedReferencePersona?.avatarUrl ? <img src={selectedReferencePersona.avatarUrl} alt="" /> : <UserRound size={14} />}</span><span><small>Selected identity</small><strong>{selectedReferencePersona?.name || "Choose identity"}</strong></span><ChevronDown size={13} /></button>
            {referencePersonaPickerOpen && <div className="generator-persona-picker-options nowheel">{generator.personas.map((persona) => <button type="button" className={selectedReferencePersona?.id === persona.id ? "is-selected" : ""} key={persona.id} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setReferencePersonaId(persona.id); setReferencePersonaPickerOpen(false); }}><span className="generator-persona-picker-avatar">{persona.avatarUrl ? <img src={persona.avatarUrl} alt="" /> : <UserRound size={14} />}</span><span><strong>{persona.name}</strong><small>{persona.assets.length} photos</small></span>{selectedReferencePersona?.id === persona.id && <Check size={12} />}</button>)}</div>}
          </div>}
          {selectedReferencePersona && <div className="generator-persona-option">{(["reference", "before", "after"] as const).map((variant) => { const assets = selectedReferencePersona.assets.filter((asset) => asset.role === variant); if (!assets.length) return null; return <div className="generator-persona-state" key={variant}><header><span>{variant === "reference" ? "identity" : variant}</span><button type="button" disabled={!assets.some((asset) => !attachedReferenceIds.has(asset.id)) || sceneReferences.length >= maxReferences} onClick={(event) => { event.preventDefault(); event.stopPropagation(); attachPersonaVariant(selectedReferencePersona, variant); }}>Add available</button></header><div>{assets.map((asset, index) => { const active = attachedReferenceIds.has(asset.id); return <button type="button" className={active ? "is-attached" : ""} disabled={!active && sceneReferences.length >= maxReferences} key={asset.id} onClick={(event) => { event.preventDefault(); event.stopPropagation(); attachPersonaAsset(selectedReferencePersona, asset); }}><img src={asset.thumbnailUrl || asset.url} alt="" /><span>{String(index + 1).padStart(2, "0")}</span>{active && <Check size={9} />}</button>; })}</div></div>; })}</div>}
        </div></>}
      </div>
    </div>;
    const renderedMasterWidth = Math.max(860, Number(liveNodeWidth || data.nodeWidth || 920));
    const masterPreviewHeight = Math.round(Math.max(430, Math.min(560, renderedMasterWidth * .58)));
    const promptMaxHeight = Math.round(Math.min(132, Math.max(60, masterPreviewHeight * .2)));
    const openMasterPreview = () => {
      videoPlaybackManager.stop(videoMasterPlaybackOwnerId);
      setVideoMasterSequencePlaying(false);
      generator.openPreview(id, clipMediaUrl ? { url: clipMediaUrl, start: clipStart, end: clipEnd, title: selectedClip?.title } : undefined);
    };
    const toggleMasterPlaybackFromStage = () => {
      const activeCommand = videoPlaybackManager.getSnapshot();
      const targetKey = selectedClip ? `${selectedClip.id}:${videoMasterSelectedLane}` : "";
      const pausing = activeCommand.action === "play"
        && activeCommand.ownerId === videoMasterPlaybackOwnerId
        && activeCommand.targetKey === targetKey;
      generator.selectNode(id);
      if (!targetKey) return;
      if (pausing) {
        setVideoMasterSequencePlaying(false);
        videoPlaybackManager.pause(videoMasterPlaybackOwnerId, targetKey);
      } else {
        setVideoMasterSequencePlaying(true);
        const replayTime = videoPlaybackReplayTime(videoMasterTransportRelativeTime, selectedPlaybackMedia.duration);
        setVideoMasterRelativeTime(replayTime);
        videoPlaybackManager.play(videoMasterPlaybackOwnerId, targetKey, { relativeTime: replayTime });
        if (selectedClip) queueVideoMasterPlay(selectedClip.id, videoMasterSelectedLane, replayTime);
      }
    };
    const downloadMaster = async () => {
      if (videoMasterDownloadBusy) return;
      setVideoMasterDownloadBusy(true);
      try {
        const downloaded = await generator.downloadMasterMedia(id, videoMasterExportLane, videoMasterExportScope);
        if (downloaded) setOpenGeneratorMenu(null);
      } finally {
        setVideoMasterDownloadBusy(false);
      }
    };
    const toggleMasterDownload = () => {
      const opening = !masterDownloadOpen;
      if (opening) {
        videoPlaybackManager.pause(videoMasterPlaybackOwnerId);
        setVideoMasterSequencePlaying(false);
        const currentAvailability = videoMasterExportLane === "original" ? originalDownloads : outputDownloads;
        const currentReady = videoMasterExportScope === "scene" ? currentAvailability.selected : currentAvailability.all;
        if (!currentReady) {
          const originalReady = videoMasterExportScope === "scene" ? originalDownloads.selected : originalDownloads.all;
          const outputReady = videoMasterExportScope === "scene" ? outputDownloads.selected : outputDownloads.all;
          if (originalReady || outputReady) setVideoMasterExportLane(originalReady ? "original" : "output");
          else {
            setVideoMasterExportScope("scene");
            setVideoMasterExportLane(originalDownloads.selected ? "original" : "output");
          }
        }
      }
      setOpenGeneratorMenu(opening ? "master-download" : null);
    };
    return <article ref={videoMasterRootRef} className={`frame-node frame-node--video-master ${selected ? "is-selected" : ""} ${data.demoNodeHovered ? "is-demo-hovered" : ""}`} style={{ width: renderedMasterWidth }} onPointerDownCapture={(event) => {
      const target = event.target as HTMLElement;
      if (target.closest("button, input, textarea, select, [role='slider'], .generator-prompt-assistant, .generator-overlay, .generator-generation-progress, .video-master-generation-error")) return;
      generator.selectNode(id);
    }}>
      <NodeToolbar isVisible={Boolean(selected && (!data.demoRequireHover || data.demoNodeHovered))} position={Position.Top} offset={10} className="generator-node-toolbar video-master-node-toolbar nodrag nopan" onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        <button type="button" className={`is-run ${data.demoRunClick ? "is-demo-clicking" : ""}`} disabled={!selectedClip?.prompt.trim() || masterHasActiveGeneration || missingRequiredInputs.length > 0} title={missingRequiredInputs.length ? `Connect ${missingRequiredInputs.map((port) => port.label).join(" and ")}` : masterHasActiveGeneration ? "Another scene is generating" : `Run ${runCredits.toLocaleString("en-US")} credits`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); if (selectedClip) generator.generateMasterClip(id, selectedClip.id); }}><Play size={14} fill="currentColor" /><span>Run</span>{data.demoRunClick && <i className="landing-node-demo-pointer is-toolbar-run" aria-hidden="true"><MousePointer2 size={18} /></i>}</button>
        <i />
        <button type="button" title="Open Video Master editor" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openMasterPreview(); }}><Expand size={15} /></button>
        <div className={`video-master-download-control ${masterDownloadOpen ? "is-open" : ""}`} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
          <button type="button" disabled={videoMasterDownloadBusy || (!originalDownloads.selected && !outputDownloads.selected)} title="Export video" aria-label="Export Video Master" aria-expanded={masterDownloadOpen} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggleMasterDownload(); }}>{videoMasterDownloadBusy ? <span className="generator-spinner" /> : <Download size={15} />}</button>
          {masterDownloadOpen && <div className={`video-master-download-menu ${videoMasterDownloadBusy ? "is-busy" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
            <header><span>EXPORT VIDEO</span><small>{videoMasterDownloadBusy ? "Rendering…" : "MP4"}</small></header>
            <div className="video-master-export-settings">
              <label><span>Range</span><div><select value={videoMasterExportScope} disabled={videoMasterDownloadBusy} onChange={(event) => { const scope = event.target.value as "scene" | "video"; setVideoMasterExportScope(scope); const laneAvailability = videoMasterExportLane === "original" ? originalDownloads : outputDownloads; const laneReady = scope === "scene" ? laneAvailability.selected : laneAvailability.all; if (!laneReady) { const originalReady = scope === "scene" ? originalDownloads.selected : originalDownloads.all; setVideoMasterExportLane(originalReady ? "original" : "output"); } }}><option value="video" disabled={!originalDownloads.all && !outputDownloads.all}>Full video</option><option value="scene">{selectedClip?.title || "Current scene"}</option></select><ChevronDown size={11} /></div></label>
              <label><span>Version</span><div><select value={videoMasterExportLane} disabled={videoMasterDownloadBusy} onChange={(event) => setVideoMasterExportLane(event.target.value as VideoMasterDownloadLane)}><option value="original" disabled={!(videoMasterExportScope === "scene" ? originalDownloads.selected : originalDownloads.all)}>Original{videoMasterExportScope === "video" ? ` · ${originalDownloads.availableCount}/${originalDownloads.totalCount}` : ""}</option><option value="output" disabled={!(videoMasterExportScope === "scene" ? outputDownloads.selected : outputDownloads.all)}>Output{videoMasterExportScope === "video" ? ` · ${outputDownloads.availableCount}/${outputDownloads.totalCount}` : ""}</option></select><ChevronDown size={11} /></div></label>
            </div>
            <div className="video-master-export-summary"><Clapperboard size={14} /><span><strong>{videoMasterExportScope === "video" ? (videoMasterExportLane === "original" ? "Original timeline" : "Generated timeline") : selectedClip?.title || "Current scene"}</strong><small>{videoMasterExportScope === "video" ? `${clips.length} scenes · ${formatVideoTime(exportDuration)}` : `${videoMasterExportLane === "original" ? "Original" : "Output"} · MP4`}</small></span></div>
            {videoMasterDownloadBusy && <div className="video-master-export-progress" aria-label="Rendering video" />}
            <footer><button type="button" className="video-master-export-submit" disabled={videoMasterDownloadBusy || !exportReady} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void downloadMaster(); }}><Download size={13} /><b>{videoMasterDownloadBusy ? "Exporting…" : videoMasterExportScope === "video" ? "Export full video" : "Export scene"}</b></button></footer>
          </div>}
        </div>
        <i />
        <button type="button" className="is-delete" title="Delete node" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); generator.deleteNode(id); }}><Trash2 size={15} /></button>
      </NodeToolbar>
      <header className="scene-floating-title video-master-floating-title"><span><i className="scene-floating-title-media-icon is-video" aria-hidden="true"><Clapperboard size={15} /></i>{data.title || "Video Master"}</span></header>
      <div className="video-master-shell video-editor-shell video-scene-editor">
        <div className={`video-master-generator-stage generator-media-stage ${clipMediaUrl ? "has-output" : ""} ${masterBusy ? "is-generating" : ""} ${masterFailed ? "is-failed" : ""}`} style={{ height: masterPreviewHeight, "--prompt-max-height": `${promptMaxHeight}px` } as CSSProperties}>
          <div className="video-master-media-viewport">
            {selectedClip ? <VideoMasterPlayer
              src={clipMediaUrl}
              preloadSources={masterPlaybackSources}
              controlsPortal={videoMasterControlsHost}
              clipStart={clipStart}
              clipEnd={clipEnd}
              seamlessNext={seamlessNext}
              backdropUrl={videoMasterClipThumbnail(selectedClip, selectedPlaybackMedia.usesOutput ? "output" : "original")}
              active={Boolean(selected && !previewOwnsPlayback)}
              keyboardActive={Boolean(selected && !previewOwnsPlayback)}
              playbackOwnerId={videoMasterPlaybackOwnerId}
              playbackKey={`${selectedClip.id}:${videoMasterSelectedLane}`}
              playRequestToken={videoMasterPlayRequest?.clipId === selectedClip.id && videoMasterPlayRequest.lane === videoMasterSelectedLane ? videoMasterPlayRequest.token : undefined}
              playRequestRelativeTime={videoMasterPlayRequest?.clipId === selectedClip.id && videoMasterPlayRequest.lane === videoMasterSelectedLane ? videoMasterPlayRequest.relativeTime : undefined}
              requestedRelativeTime={videoMasterSeekRequest?.clipId === selectedClip?.id ? videoMasterSeekRequest.time : undefined}
              requestedSeekToken={videoMasterSeekRequest?.clipId === selectedClip?.id ? videoMasterSeekRequest.version : undefined}
              onDoubleClick={openMasterPreview}
              externalCurrentTime={masterTimelineTime}
              externalDuration={totalDuration}
              externalActions={<button type="button" className="video-master-transport-remove" aria-label="Remove scene" title="Remove scene" onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeClip(); }}><Trash2 size={13} /></button>}
              onExternalSeek={seekMasterTimeline}
              onAspectRatio={(ratio) => {
                if (selectedPlaybackMedia.usesOutput || !Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - sourceAspectRatio) < .002) return;
                const measuredOriginalRatio = nearestVideoMasterRatio(ratio, ratios);
                updateClip(selectedClip.id, {
                  sourceAspectRatio: ratio,
                  ...(selectedClip.aspectRatioMode === "custom" ? {} : { aspectRatio: measuredOriginalRatio, aspectRatioMode: "original" }),
                });
                generator.updateNode(id, { videoAspectRatio: ratio });
              }}
              onMediaDuration={(duration) => {
                const reconciledGeneratedDuration = reconciledVideoMasterGeneratedDuration(selectedClip, selectedPlaybackMedia, duration);
                if (reconciledGeneratedDuration !== undefined && Math.abs(reconciledGeneratedDuration - Number(selectedClip.generatedDuration || 0)) > .02) {
                  generator.saveNow(id, {
                    videoMasterClips: clips.map((clip) => clip.id !== selectedClip.id ? clip : {
                      ...clip,
                      generatedDuration: reconciledGeneratedDuration,
                      generatedOutputs: clip.generatedOutputs?.map((output) => output.url === clip.outputUrl
                        ? { ...output, durationSeconds: reconciledGeneratedDuration }
                        : output),
                    }),
                  });
                  return;
                }
                const reconciledDuration = reconciledVideoMasterClipDuration(selectedClip, selectedPlaybackMedia, duration);
                if (reconciledDuration === undefined || Math.abs(reconciledDuration - selectedClip.duration) <= .02) return;
                generator.saveNow(id, {
                  videoMasterClips: clips.map((clip) => clip.id === selectedClip.id ? { ...clip, duration: reconciledDuration, sourceEnd: clip.sourceStart ? clip.sourceStart + reconciledDuration : reconciledDuration } : clip),
                  duration: String(reconciledDuration),
                });
              }}
              onPlaybackChange={(playing, playbackSessionKey) => {
                if (playbackSessionKey !== videoMasterPlaybackTargetRef.current) return;
                setVideoMasterSequencePlaying(playing);
              }}
              onTimeChange={(relativeTime) => setVideoMasterRelativeTime(relativeTime)}
              onClipEnded={(playback, playbackSessionKey) => {
                if (playbackSessionKey !== videoMasterPlaybackTargetRef.current) return;
                if (masterDownloadOpen) { videoPlaybackManager.pause(videoMasterPlaybackOwnerId); setVideoMasterSequencePlaying(false); return; }
                if (nextClip) selectClip(nextClip, playback === "manual", 0, videoMasterSelectedLane, playback === "manual", seamlessNext);
                else { videoPlaybackManager.complete(videoMasterPlaybackOwnerId, `${selectedClip.id}:${videoMasterSelectedLane}`); setVideoMasterSequencePlaying(false); setVideoMasterRelativeTime(selectedPlaybackMedia.duration); }
              }}
            /> : selectedClip && clipMediaUrl ? <img className="video-master-passive-frame" src={videoMasterClipThumbnail(selectedClip, selectedPlaybackMedia.usesOutput ? "output" : "original")} alt="" draggable={false} /> : <div className="video-master-empty-stage"><Video size={20} /><strong>New scene</strong></div>}
            {!masterBusy && selectedClip && clipMediaUrl && <button type="button" className="video-master-stage-toggle" aria-label="Toggle Video Master playback" onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggleMasterPlaybackFromStage(); }} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); openMasterPreview(); }} />}
            {selectedClip && !clipMediaUrl && <div className="video-master-empty-stage is-overlay"><Video size={20} /><strong>New scene</strong></div>}
            {masterBusy && !previewOwnsPlayback && <>
              <svg className="generator-running-outline video-master-running-outline" aria-hidden="true"><rect className="generator-running-runner" x="2" y="2" width="calc(100% - 4px)" height="calc(100% - 4px)" rx="2" pathLength="100" /></svg>
              <ImageGeneration
                className="generator-generation-progress video-master-generation-progress"
                startingLabel={masterPreparing
                  ? "Preparing source video…"
                  : data.status === "queued"
                    ? "Submitting generation…"
                    : "Preparing generation…"}
                generatingLabel={masterPreparing
                  ? "Preparing source video. This may take a moment."
                  : data.status === "queued"
                    ? data.queueReason === "provider" ? "Generation submitted. Waiting for provider…" : "Video queued. Waiting for a generation slot…"
                    : "Creating video. This may take a moment."}
              >
                <div className="generator-generation-preview video-master-generation-preview" aria-hidden="true" />
              </ImageGeneration>
            </>}
            {masterFailed && <div className="video-master-generation-error" role="alert" title={String(data.generationError || "Generation failed")} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><strong>Generation failed</strong><span>{String(data.generationError || "Could not generate this scene")}</span></div>}
          </div>
          {!masterBusy && selectedClip && <div className={`generator-overlay video-master-generator-overlay ${promptFocused ? "is-prompt-focused" : ""}`} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            <textarea ref={promptRef} className="nodrag nopan" value={selectedClip.prompt} onPointerDown={(event) => event.stopPropagation()} onFocus={() => setPromptFocused(true)} onBlur={() => { setPromptFocused(false); generator.updateNode(id, { prompt: selectedClip.prompt }); window.setTimeout(() => setReferenceMention(null), 120); }} onChange={(event) => { updateClip(selectedClip.id, { prompt: event.target.value }); updateMasterMention(event.target.value, event.target.selectionStart); }} onKeyDown={(event) => {
              if (!referenceMention || !mentionOptions.length) return;
              if (event.key === "ArrowDown") { event.preventDefault(); setReferenceMentionIndex((current) => (current + 1) % mentionOptions.length); }
              if (event.key === "ArrowUp") { event.preventDefault(); setReferenceMentionIndex((current) => (current - 1 + mentionOptions.length) % mentionOptions.length); }
              if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertMasterMention(mentionOptions[Math.min(referenceMentionIndex, mentionOptions.length - 1)]); }
              if (event.key === "Escape") { event.preventDefault(); setReferenceMention(null); }
            }} placeholder="Describe motion, camera and action…" />
            {referenceMention && <div className="generator-mention-menu nodrag nopan" onPointerDown={(event) => event.preventDefault()}><div className="generator-mention-head"><span>REFERENCES</span><small>↑↓ navigate · ↵ insert</small></div><div className="generator-mention-list">{mentionOptions.map((reference, index) => <button type="button" className={index === referenceMentionIndex ? "is-active" : ""} key={reference.id} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); insertMasterMention(reference); }}><GeneratorReferencePreview reference={reference} /><span><strong>{reference.title}</strong><small>{generatorReferenceRoleLabels[reference.role || ""] || "Visual reference"} · {reference.token}</small></span><b>{String(reference.referenceIndex + 1).padStart(2, "0")}</b></button>)}</div></div>}
            <VideoMasterGenerationControls clipId={selectedClip.id} openMenu={openGeneratorMenu} setOpenMenu={setOpenGeneratorMenu} modelValue={selectedModel?.id || ""} modelOptions={videoModels.map((model) => ({ value: model.id, label: model.label, description: generatorModelCreditDescription(model, { duration: String(videoMasterGenerationDuration(model, selectedClip) || timelineDuration), referenceCount: sceneReferences.length, generateAudio: model.id === selectedModel?.id ? generatedAudioEnabled : model.defaultGenerateAudio, hasVideoInput, inputVideoDurationSeconds: timelineDuration }) }))} onModelChange={(value) => {
                  const nextModel = videoModels.find((model) => model.id === value);
                  setReferencePersonaPickerOpen(false);
                  setReferenceMenuPortId(nextModel?.inputPorts?.[0]?.id || "reference-image");
                  generator.updateMasterClipModel(id, selectedClip.id, value);
                }} ratioValue={selectedClip.aspectRatioMode === "custom" ? selectedAspectRatio : "original"} ratioOptions={ratioOptions} onRatioChange={(value) => updateClip(selectedClip.id, value === "original" ? { aspectRatio: originalAspectRatio, aspectRatioMode: "original", sourceAspectRatio } : { aspectRatio: value, aspectRatioMode: "custom", sourceAspectRatio })} durationValue={masterDurationOptions.length ? String(generationDuration || selectedModel?.defaultDuration || masterDurationOptions[0]?.value || "5") : undefined} durationOptions={masterDurationOptions} onDurationChange={(value) => updateClip(selectedClip.id, { generationDuration: Number(value) })} qualityValue={resolutions.includes(String(selectedClip.resolution || "")) ? String(selectedClip.resolution) : resolutions.includes(selectedModel?.defaultResolution || "") ? selectedModel!.defaultResolution! : resolutions[0]} qualityOptions={resolutions.map((resolution) => ({ value: resolution, label: resolution }))} onQualityChange={(value) => updateClip(selectedClip.id, { resolution: value })} assistantActive={assistantOpen} onAssistant={() => setAssistantOpen((open) => !open)} supportsAudio={Boolean(selectedModel?.supportsAudio)} audioEnabled={generatedAudioEnabled} onToggleAudio={() => updateClip(selectedClip.id, { generateAudio: !generatedAudioEnabled })} runDisabled={!selectedClip.prompt.trim() || masterHasActiveGeneration || missingRequiredInputs.length > 0} runTitle={missingRequiredInputs.length ? `Connect ${missingRequiredInputs.map((port) => port.label).join(" and ")}` : masterHasActiveGeneration ? "Another scene is generating" : `Run ${runCredits.toLocaleString("en-US")} credits`} runBusy={masterBusy} onRun={() => generator.generateMasterClip(id, selectedClip.id)} demoAssistantClick={Boolean(data.demoAssistantClick)} />
          </div>}
          {assistantOpen && selectedClip && <section className="generator-prompt-assistant video-master-prompt-assistant nodrag nopan" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            <header className="generator-assistant-head"><span>SCENE PROMPT ASSISTANT</span><button type="button" aria-label="Close scene prompt assistant" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setAssistantOpen(false); setAssistantMention(null); }}><X size={13} /></button></header>
            <div className="generator-assistant-references">
              <div className="generator-assistant-reference-title"><span>SCENE REFERENCES</span><small>Assign each role with @</small></div>
              <div className="generator-assistant-reference-strip is-compact">
                {masterOriginalAssistantReference && <button type="button" className={`generator-assistant-scene-source ${masterOriginalConnectedReference ? "" : "is-context"} ${data.demoAssistantReferenceId === masterOriginalAssistantReference.id || data.demoAssistantReferenceId === masterOriginalAssistantReference.assetId ? "is-demo-selecting" : ""}`} aria-label={`Insert ${masterOriginalAssistantReference.token}`} title={`${masterOriginalAssistantReference.title} · Selected scene source · ${masterOriginalAssistantReference.token}${masterOriginalConnectedReference ? "" : " · assistant context"}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); insertMasterAssistantMention(masterOriginalAssistantReference); }}><GeneratorReferencePreview reference={masterOriginalAssistantReference} compact /><i>SCENE SOURCE</i></button>}
                {masterOtherAssistantReferences.map((reference) => <button type="button" className={data.demoAssistantReferenceId === reference.id || data.demoAssistantReferenceId === reference.assetId ? "is-demo-selecting" : ""} key={reference.id} aria-label={`Insert ${reference.token}`} title={`${reference.title} · ${generatorReferenceRoleLabels[reference.role || ""] || "Visual reference"} · ${reference.token}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); insertMasterAssistantMention(reference); }}><GeneratorReferencePreview reference={reference} compact /></button>)}
                {!masterOriginalAssistantReference && !masterAssistantReferences.length && <p>No references connected. Describe the new scene and the assistant will structure it for {selectedModel?.label || "the selected model"}.</p>}
              </div>
            </div>
            <div className="generator-assistant-scene-context"><span>{selectedModel?.label}</span><span>{timelineDuration.toFixed(3)}s timeline</span>{generationDuration && <span>{generationDuration}s generated</span>}<span>{selectedClip.aspectRatioMode === "custom" ? selectedAspectRatio : `Original ${originalAspectRatio}`}</span></div>
            <div className="generator-assistant-compose">
              <textarea ref={assistantRef} value={assistantBrief} autoFocus placeholder="Describe what should happen in this scene. Use @ to say which reference controls identity, start frame, motion, audio or style…" onChange={(event) => { assistantBriefValueRef.current = event.target.value; setAssistantBrief(event.target.value); setAssistantError(""); updateMasterAssistantMention(event.target.value, event.target.selectionStart); }} onKeyDown={(event) => {
                if (assistantMention && masterAssistantMentionOptions.length) {
                  if (event.key === "ArrowDown") { event.preventDefault(); setAssistantMentionIndex((current) => (current + 1) % masterAssistantMentionOptions.length); return; }
                  if (event.key === "ArrowUp") { event.preventDefault(); setAssistantMentionIndex((current) => (current - 1 + masterAssistantMentionOptions.length) % masterAssistantMentionOptions.length); return; }
                  if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertMasterAssistantMention(masterAssistantMentionOptions[Math.min(assistantMentionIndex, masterAssistantMentionOptions.length - 1)]); return; }
                  if (event.key === "Escape") { event.preventDefault(); setAssistantMention(null); return; }
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void buildMasterPromptWithAssistant(); }
              }} onWheelCapture={(event) => event.stopPropagation()} />
              {assistantMention && <div className="generator-assistant-mention-menu">{masterAssistantMentionOptions.map((reference, index) => <button type="button" className={index === assistantMentionIndex ? "is-active" : ""} key={reference.id} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); insertMasterAssistantMention(reference); }}><GeneratorReferencePreview reference={reference} /><span><strong>{reference.title}</strong><small>{generatorReferenceRoleLabels[reference.role || ""] || "Visual reference"} · {reference.token}</small></span></button>)}{!masterAssistantMentionOptions.length && <p>No matching references</p>}</div>}
            </div>
            {assistantError && <p className="generator-assistant-error">{assistantError}</p>}
            <footer className="generator-assistant-foot"><GeneratorSelect menuKey="master-prompt-assistant-model" openMenu={openGeneratorMenu} setOpenMenu={setOpenGeneratorMenu} className="prompt-assistant-model-select" value={normalizeAssistantModelId(data.textModelId)} label="ASSISTANT MODEL" options={assistantModels.map((model) => ({ value: model.id, label: model.label, description: assistantModelCreditDescription(model, { inputCharacters: assistantBrief.length, imageCount: sceneReferences.length, outputTokens: 2_400 }) }))} onChange={(value) => generator.updateNode(id, { textModelId: value })} /><button type="button" className={data.demoAssistantBuild ? "is-demo-selecting" : ""} disabled={assistantBusy || !assistantBrief.trim()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void buildMasterPromptWithAssistant(); }}>{assistantBusy && <span className="generator-spinner" />}<b>{assistantBusy ? "Building" : "Build scene prompt"}</b>{data.demoAssistantBuild && <i className="generator-assistant-demo-pointer is-build" aria-hidden="true"><MousePointer2 size={17} /></i>}</button></footer>
          </section>}
        </div>
        <div className="video-master-workbench video-scene-workbench nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="video-master-transport-host" ref={setVideoMasterControlsHost} />
          {selectedClip && <div className="video-master-segment-readout"><strong>{selectedClip.title}</strong><code>{formatPreciseVideoTime(selectedClipOffset)} <i>–</i> {formatPreciseVideoTime(selectedClipOffset + selectedPlaybackMedia.duration)}</code></div>}
          <VideoMasterTimeline
            clips={clips}
            selectedClipId={selectedClip?.id}
            selectedLane={videoMasterSelectedLane}
            currentTime={masterTimelineTime}
            laneVisibility={videoMasterLaneVisibility}
            onToggleLane={(lane) => setVideoMasterLaneVisibility((current) => ({ ...current, [lane]: !current[lane] }))}
            onSelect={(clip, lane) => selectClip(clip, false, 0, lane, true)}
            onSeek={seekMasterTimeline}
            onReorder={(videoMasterClips) => generator.updateNode(id, { videoMasterClips: videoMasterClips.map((clip, sequenceIndex) => ({ ...clip, sequenceIndex })) })}
            onMoveLane={(clip, lane) => {
              updateClip(clip.id, moveUploadedMasterClipToLane(clip, lane));
            }}
            onCopyOutput={(sourceClip, targetClipId) => {
              const output = videoMasterGeneratedOutputs(sourceClip).find((candidate) =>
                candidate.url === sourceClip.outputUrl
                || Boolean(sourceClip.outputAssetId && candidate.assetId === sourceClip.outputAssetId)
              ) || videoMasterGeneratedOutputs(sourceClip).at(-1);
              if (output) applyMasterOutput(targetClipId, output);
            }}
            onAddGenerated={addBlankClip}
            onUpload={(files) => generator.uploadMasterClips(id, files)}
          />
        </div>
      </div>
      {masterOutputEntries.length > 0 && <div className={`generator-output-history video-master-output-history nodrag nopan ${outputGalleryOpen ? "is-open" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" className="generator-history-trigger" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setVideoMasterOutputTarget(null); setOutputGalleryOpen((open) => !open); }} aria-label={`${masterOutputEntries.length} saved Video Master outputs`} aria-expanded={outputGalleryOpen}><Images size={13} /><b>{masterOutputEntries.length}</b><ChevronDown size={11} /></button>
        {outputGalleryOpen && <div className="generator-history-panel video-master-history-panel">
          <div className="generator-history-head video-master-history-head"><span>MASTER OUTPUTS</span><b>{masterOutputEntries.length} SAVED</b></div>
          <div className="video-master-history-filters" role="group" aria-label="Filter Video Master outputs">
            <button type="button" className={videoMasterOutputFilter === "scene" ? "is-active" : ""} onClick={() => { setVideoMasterOutputFilter("scene"); setVideoMasterOutputTarget(null); }}>{selectedClip?.title || "SCENE"}<b>{selectedClip ? videoMasterGeneratedOutputs(selectedClip).length : 0}</b></button>
            <button type="button" className={videoMasterOutputFilter === "all" ? "is-active" : ""} onClick={() => { setVideoMasterOutputFilter("all"); setVideoMasterOutputTarget(null); }}>ALL<b>{masterOutputEntries.length}</b></button>
          </div>
          <div className="video-master-history-grid" onWheel={(event) => event.stopPropagation()}>{visibleMasterOutputEntries.map(({ clip, clipIndex, output, outputIndex }) => {
            const active = clip.outputUrl === output.url;
            const targetOpen = videoMasterOutputTarget === `${clip.id}:${output.url}`;
            return <div className={`video-master-history-item ${active ? "is-active" : ""}`} key={`${clip.id}:${output.url}:${outputIndex}`}>
              <button type="button" className="video-master-history-preview" onClick={(event) => { event.preventDefault(); event.stopPropagation(); applyMasterOutput(clip.id, output); }} aria-label={`Use ${clip.title} output ${outputIndex + 1}`}>
                <img src={output.thumbnailUrl || assetThumbnailUrl(output.url)} alt={`${clip.title} version ${outputIndex + 1}`} loading="lazy" decoding="async" />
                <span className="video-master-history-scene">S{String(clipIndex + 1).padStart(2, "0")}</span>
                <span className="video-master-history-version">V{String(outputIndex + 1).padStart(2, "0")}</span>
                {active && <i><Check size={9} /></i>}
              </button>
              <button type="button" className="video-master-history-move" title="Use in another scene" aria-label={`Use output ${outputIndex + 1} in another scene`} aria-expanded={targetOpen} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setVideoMasterOutputTarget(targetOpen ? null : `${clip.id}:${output.url}`); }}><ArrowRightLeft size={10} /></button>
              {targetOpen && <div className="video-master-history-targets"><small>USE IN</small>{clips.map((targetClip, targetIndex) => <button type="button" key={targetClip.id} className={targetClip.id === clip.id ? "is-current" : ""} onClick={(event) => { event.preventDefault(); event.stopPropagation(); applyMasterOutput(targetClip.id, output); }}><span>{String(targetIndex + 1).padStart(2, "0")}</span>{targetClip.title}{targetClip.id === clip.id && <Check size={9} />}</button>)}</div>}
            </div>;
          })}</div>
          {!visibleMasterOutputEntries.length && <div className="video-master-history-empty">No generated versions for this scene yet.</div>}
        </div>}
      </div>}
      {selectedClip && <div className="generator-semantic-ports video-master-semantic-ports nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
        {inputPorts.map((port) => <div key={port.id} data-port-id={port.id} className={`generator-semantic-port is-${port.kind} ${openGeneratorMenu === "references" && port.id === referenceMenuPortId ? "is-open" : ""}`}>
          <Handle id={`master:${selectedClip.id}:${port.id}-input`} type="target" position={Position.Left} />
          <button type="button" aria-label={port.label} title={`${port.label}${port.required ? " · required" : ""}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); const closing = openGeneratorMenu === "references" && referenceMenuPortId === port.id; setReferenceMenuPortId(port.id); setOpenGeneratorMenu(closing ? null : "references"); }}>{port.kind === "video" ? <Video size={14} /> : port.kind === "audio" ? <Volume2 size={14} /> : <ImageIcon size={14} />}{port.required && <i />}</button>
          <span>{port.label}</span>
          {port.id === referenceMenuPortId && referenceMenu}
        </div>)}
      </div>}
      <button type="button" className="node-resize-corner nodrag nopan" aria-label="Resize Video Master" onPointerDown={(event) => beginProportionalResize(event, Number(renderedMasterWidth), 860, 1180)}><svg viewBox="0 0 36 36" aria-hidden="true"><path className="resize-grip-outer" d="M6 30h10c7.7 0 14-6.3 14-14V6" /></svg></button>
    </article>;
  }
  if (data.kind === "source" && data.mediaType === "video" && data.imageUrl && data.videoSegments?.length) {
    const renderedTimelineWidth = liveNodeWidth || data.nodeWidth || 580;
    const outputSelection = data.videoOutputSelection === "full" || data.videoSegments.some((segment) => segment.id === data.videoOutputSelection) ? String(data.videoOutputSelection || "full") : "full";
    const outputHandleId = outputSelection === "full" ? "video-output" : `segment-output:${outputSelection}`;
    const outputSegment = outputSelection === "full" ? undefined : data.videoSegments.find((segment) => segment.id === outputSelection);
    const allOutputHandleIds = ["video-output", ...data.videoSegments.map((segment) => `segment-output:${segment.id}`)];
    return <article className={`frame-node frame-node--video-timeline ${selected ? "is-selected" : ""}`} style={{ width: renderedTimelineWidth }} onPointerDownCapture={(event) => {
      if ((event.target as HTMLElement).closest("button,input,[role=slider]")) return;
      generator?.selectNode(id);
    }} onDoubleClickCapture={(event) => {
      if ((event.target as HTMLElement).closest("button,input,[role=slider]")) return;
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(OPEN_VIDEO_EDITOR_EVENT, { detail: { nodeId: id } }));
    }}>
      <NodeToolbar isVisible={selected} position={Position.Top} offset={10} className="generator-node-toolbar video-timeline-node-toolbar nodrag nopan">
        <button type="button" title="Open source editor" aria-label="Open source editor" onClick={(event) => { event.preventDefault(); event.stopPropagation(); window.dispatchEvent(new CustomEvent(OPEN_VIDEO_EDITOR_EVENT, { detail: { nodeId: id } })); }}><Expand size={15} /></button>
      </NodeToolbar>
      <header className="scene-floating-title video-timeline-floating-title"><span><i className="scene-floating-title-media-icon is-video" aria-hidden="true"><Video size={15} /></i>{data.title}</span></header>
      <VideoSceneTimeline
        nodeId={id}
        src={data.imageUrl}
        title={data.title}
        selected={Boolean(selected && !previewOwnsPlayback)}
        segments={data.videoSegments}
        detectedSegments={data.videoDetectedSegments}
        durationHint={data.videoDurationSeconds}
        timelineSprite={data.videoTimelineSprite}
        outputSelection={outputSelection}
        demoPlaybackToken={data.demoSourcePlaybackToken}
        demoPlaybackSegmentId={data.demoSourcePlaybackSegmentId}
        demoClickSegmentId={data.demoSourceClickSegmentId}
        onActivate={() => generator?.selectNode(id)}
        onOutputSelectionChange={(videoOutputSelection) => generator?.updateNode(id, { videoOutputSelection })}
        onOpenPreview={() => window.dispatchEvent(new CustomEvent(OPEN_VIDEO_EDITOR_EVENT, { detail: { nodeId: id } }))}
        onAspectRatio={(videoAspectRatio) => generator?.updateNode(id, { videoAspectRatio })}
        onExtractSegment={(segment, clientX, clientY) => generator?.extractVideoSegment(id, segment, clientX, clientY)}
        onCaptureFrame={generator ? (time) => generator.captureVideoFrame(id, time) : undefined}
        onChange={(videoSegments, videoDurationSeconds) => generator?.updateNode(id, { videoSegments, videoDurationSeconds })}
      />
      <Handle id="input" type="target" position={Position.Left} className="node-handle node-visual-port video-timeline-input" title="TikTok source video"><Video size={13} /></Handle>
      {allOutputHandleIds.filter((handleId) => handleId !== outputHandleId).map((handleId) => <Handle key={handleId} id={handleId} type="source" position={Position.Right} className="video-timeline-output-anchor is-hidden" aria-hidden="true" />)}
      <Handle id={outputHandleId} type="source" position={Position.Right} className={`node-next-button nodrag nopan video-timeline-output-anchor ${data.demoOutputHandleClick ? "is-demo-clicking" : ""}`} title={outputSegment ? `Connect ${outputSegment.label}` : "Connect full video"} aria-label={outputSegment ? `Connect ${outputSegment.label}` : "Connect full video"} onClick={(event) => {
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent(OPEN_NODE_CREATOR_EVENT, { detail: { nodeId: id, clientX: event.clientX, clientY: event.clientY, segment: outputSegment, intent: "video-master" } }));
      }}><Video size={14} />{data.demoOutputHandleClick && <i className="landing-node-demo-pointer is-handle" aria-hidden="true"><MousePointer2 size={18} /></i>}</Handle>
      <button type="button" className="node-resize-corner nodrag nopan" aria-label="Resize video editor" onPointerDown={(event) => beginProportionalResize(event, Number(renderedTimelineWidth), 440, 820)}>
        <svg viewBox="0 0 36 36" aria-hidden="true"><path className="resize-grip-outer" d="M6 30h10c7.7 0 14-6.3 14-14V6" /></svg>
      </button>
    </article>;
  }
  if ((data.kind === "scene" || data.kind === "persona") && hasImage) {
    const renderedSceneWidth = liveNodeWidth || data.nodeWidth || 260;
    const sceneIsVideo = data.mediaType === "video";
    const isStandaloneCanvasMedia = Boolean(data.canvasMediaOrigin)
      || data.subtitle === "Dropped on canvas"
      || data.subtitle === "Pasted from clipboard"
      || (data.kind === "scene" && sceneIsVideo);
    return <article className={`frame-node frame-node--scene-media ${sceneIsVideo ? "is-video" : "is-image"} ${selected ? "is-selected" : ""}`} style={{ width: renderedSceneWidth }}>
      <header className="scene-floating-title"><span><i className={`scene-floating-title-media-icon ${sceneIsVideo ? "is-video" : "is-image"}`} aria-hidden="true">{sceneIsVideo ? <Video size={15} /> : <Icon size={15} />}</i>{data.title}</span></header>
      <div className="scene-media-shell" style={naturalSceneRatio ? { aspectRatio: naturalSceneRatio } : undefined} onDoubleClick={(event) => { event.stopPropagation(); generator?.openPreview(id); }}>
        {sceneIsVideo ? <CanvasVideoPlayer src={image} variant="scene" selectionActive={Boolean(selected)} clipStart={Number(data.videoClipStart || 0)} clipEnd={typeof data.videoClipEnd === "number" ? data.videoClipEnd : undefined} onAspectRatio={setNaturalSceneRatio} onDoubleClick={() => generator?.openPreview(id)} /> : <img src={thumbnailImage} alt={data.title} draggable={false} loading="lazy" decoding="async" onLoad={(event) => {
          const element = event.currentTarget;
          if (element.naturalWidth > 0 && element.naturalHeight > 0) setNaturalSceneRatio(element.naturalWidth / element.naturalHeight);
        }} />}
        {!isStandaloneCanvasMedia && !sceneIsVideo && <div className="scene-media-vignette" />}
        {!isStandaloneCanvasMedia && !sceneIsVideo && <span className="scene-role-overlay">{data.kind === "persona" ? (data.personaVariant === "reference" ? "IDENTITY" : data.personaVariant || "IDENTITY") : data.role || "SLIDE"}</span>}
      </div>
      {!isStandaloneCanvasMedia && <Handle id="input" type="target" position={Position.Left} className="node-handle node-visual-port scene-input-handle">{sceneIsVideo ? <Video size={13} /> : <ImageIcon size={13} />}</Handle>}
      <Handle id="output" type="source" position={Position.Right} className={`node-next-button nodrag nopan scene-next-button ${data.demoReferenceHandleClick ? "is-demo-clicking" : ""}`} title="Drag to connect · click to continue" aria-label={`Connect or create next node from ${data.title}`} onClick={(event) => {
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent(OPEN_NODE_CREATOR_EVENT, { detail: { nodeId: id, clientX: event.clientX, clientY: event.clientY } }));
      }}>{sceneIsVideo ? <Video size={14} /> : <ImageIcon size={14} />}{data.demoReferenceHandleClick && <i className="landing-node-demo-pointer is-handle" aria-hidden="true"><MousePointer2 size={18} /></i>}</Handle>
      <button type="button" className="node-resize-corner nodrag nopan" aria-label="Resize node proportionally" onPointerDown={(event) => beginProportionalResize(event, Number(renderedSceneWidth), 180, 680)}>
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <path className="resize-grip-outer" d="M6 30h10c7.7 0 14-6.3 14-14V6" />
        </svg>
      </button>
    </article>;
  }
  return (
    <article className={`frame-node frame-node--${data.kind} ${selected ? "is-selected" : ""}`}>
      {data.kind !== "source" && <Handle id="input" type="target" position={Position.Left} className="node-handle node-visual-port node-input-handle"><Icon size={13} /></Handle>}
      <header className="node-head">
        <span className="node-kind"><Icon size={13} /> {data.kind}</span>
        {data.status && data.status !== "idle" && <span className={`status-dot status-${data.status}`} />}
      </header>
      {hasImage && (
        <div className="node-media">
          {data.mediaType === "video" && data.outputUrl ? (
            <CanvasVideoPlayer src={image} variant="card" selectionActive={Boolean(selected)} onDoubleClick={() => generator?.openPreview(id)} />
          ) : (
            <img src={thumbnailImage} alt="" draggable={false} loading="lazy" decoding="async" />
          )}
          {data.role && <span className="role-chip">{data.role}</span>}
        </div>
      )}
      <div className="node-copy">
        <h3>{data.title}</h3>
        {data.subtitle && <p>{data.subtitle}</p>}
        {data.prompt && <p className="prompt-preview">{data.prompt}</p>}
        {data.hookText && <p className="hook-preview">“{data.hookText}”</p>}
        {data.modelId && <p className="model-preview">{data.mediaType === "video" ? <Video size={10} /> : <Sparkles size={10} />} {data.modelId}</p>}
        {data.kind === "prompt" && <p className="generator-config">{data.aspectRatio || "4:5"} · {data.resolution || "1K"} · ×{data.generationCount || 1}</p>}
      </div>
      {hasImage ? (
        <Handle
          id="output"
          type="source"
          position={Position.Right}
          className="node-next-button nodrag nopan"
          title="Drag to connect · click to continue"
          aria-label={`Connect or create next node from ${data.title}`}
          onClick={(event) => {
            event.stopPropagation();
            window.dispatchEvent(new CustomEvent(OPEN_NODE_CREATOR_EVENT, { detail: { nodeId: id, clientX: event.clientX, clientY: event.clientY } }));
          }}
        >
          <ImageIcon size={14} />
        </Handle>
      ) : <Handle id="output" type="source" position={Position.Right} className="node-handle node-visual-port node-output-handle"><Icon size={13} /></Handle>}
    </article>
  );
}

export const FrameNodeCard = memo(FrameNodeCardComponent);
FrameNodeCard.displayName = "FrameNodeCard";
