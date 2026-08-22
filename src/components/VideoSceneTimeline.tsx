"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ChevronDown, ChevronsLeftRight, MousePointer2, Pause, Play, RotateCcw, Scissors, Video, Volume2, VolumeX } from "lucide-react";
import type { VideoSceneSegment } from "@/lib/types";
import { editorThumbnailUrl } from "@/lib/editor-media";
import { videoPlaybackReplayTime } from "@/lib/video-playback";
import { videoPlaybackManager } from "@/lib/video-playback-owner";
import { restoreDetectedVideoSegments, videoSceneCutsMatch } from "@/lib/video-scenes";
import { VideoMasterPlayer } from "@/components/VideoMasterPlayer";

function directAssetUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.set("delivery", "direct");
  return `${parsed.pathname}${parsed.search}`;
}

function thumbnailAssetUrl(url: string | undefined) {
  return editorThumbnailUrl(url);
}

function preciseTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}

function rulerTime(seconds: number) {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
  return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))}s`;
}

function normalizeSegments(segments: VideoSceneSegment[], duration: number) {
  const initialOrder = new Map(segments.map((segment, index) => [segment.id, Number.isFinite(segment.sequenceIndex) ? Number(segment.sequenceIndex) : index]));
  let ordered = segments.map((segment) => ({
    ...segment,
    thumbnailTime: Number.isFinite(segment.thumbnailTime) ? segment.thumbnailTime : segment.start,
  })).sort((left, right) => left.start - right.start);
  const microFragment = Math.min(0.12, Math.max(1 / 60, duration * 0.01));
  while (ordered.length > 1 && ordered[0].end - ordered[0].start < microFragment) {
    ordered = [{ ...ordered[1], start: 0 }, ...ordered.slice(2)];
  }
  while (ordered.length > 1 && ordered.at(-1)!.end - ordered.at(-1)!.start < microFragment) {
    ordered = [...ordered.slice(0, -2), { ...ordered.at(-2)!, end: duration }];
  }
  const sequenceOrder = [...ordered].sort((left, right) =>
    Number(left.sequenceIndex ?? initialOrder.get(left.id) ?? 0) - Number(right.sequenceIndex ?? initialOrder.get(right.id) ?? 0)
    || left.start - right.start);
  const sequenceIndexById = new Map(sequenceOrder.map((segment, index) => [segment.id, index]));
  return ordered.map((segment, index) => ({
    ...segment,
    index: index + 1,
    label: `Scene ${String(index + 1).padStart(2, "0")}`,
    role: index === 0 ? "hook" as const : index === ordered.length - 1 ? "cta" as const : "scene" as const,
    start: index === 0 ? 0 : segment.start,
    end: index === ordered.length - 1 ? duration : segment.end,
    sequenceIndex: sequenceIndexById.get(segment.id) ?? index,
  }));
}

type TimelineSprite = { assetId: string; url: string; frameCount: number; columns?: number; rows?: number };

const SEGMENT_DRAG_ACTIVATION_PX = 7;

export function VideoSceneTimeline({ nodeId, src, title, selected, segments, detectedSegments, durationHint, timelineSprite, outputSelection, hoverPlayback = false, demoPlaybackToken, demoPlaybackSegmentId, demoClickSegmentId, onActivate, onOutputSelectionChange, onChange, onOpenPreview, onAspectRatio, onExtractSegment, onCaptureFrame }: {
  nodeId: string;
  src: string;
  title: string;
  selected: boolean;
  segments: VideoSceneSegment[];
  detectedSegments?: VideoSceneSegment[];
  durationHint?: number;
  timelineSprite?: TimelineSprite;
  outputSelection: string;
  hoverPlayback?: boolean;
  demoPlaybackToken?: number;
  demoPlaybackSegmentId?: string;
  demoClickSegmentId?: string;
  onActivate?: () => void;
  onOutputSelectionChange: (selection: string) => void;
  onChange: (segments: VideoSceneSegment[], duration: number) => void;
  onOpenPreview: () => void;
  onAspectRatio: (ratio: number) => void;
  onExtractSegment: (segment: VideoSceneSegment, clientX: number, clientY: number) => void;
  onCaptureFrame?: (time: number) => Promise<void> | void;
}) {
  const playbackOwnerId = `video-source:${nodeId}`;
  const initialDuration = Math.max(0.001, durationHint || segments.at(-1)?.end || 0.001);
  const stageRef = useRef<HTMLDivElement>(null);
  const manualPlaybackRef = useRef(false);
  const hoverPreviewRef = useRef(false);
  const hoverSuppressedRef = useRef(false);
  const demoPlaybackTokenRef = useRef<number | undefined>(undefined);
  const trackRef = useRef<HTMLDivElement>(null);
  const timelineViewportRef = useRef<HTMLDivElement>(null);
  const durationRef = useRef(initialDuration);
  const timelineZoomRef = useRef(1);
  const [localSegments, setLocalSegments] = useState<VideoSceneSegment[]>(() => normalizeSegments(segments, initialDuration));
  const localSegmentsRef = useRef<VideoSceneSegment[]>(localSegments);
  const dragRef = useRef<{ boundaryIndex: number; pointerId: number; lastX: number; raf: number } | null>(null);
  const scrubRef = useRef<{ pointerId: number; surface: "transport" | "timeline" } | null>(null);
  const segmentDragRef = useRef<{ pointerId: number; segment: VideoSceneSegment; startX: number; startY: number; lastX: number; lastY: number; activated: boolean } | null>(null);
  const segmentDragCleanupRef = useRef<(() => void) | null>(null);
  const handledSegmentClickRef = useRef<string | null>(null);
  const segmentDragPreviewRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(initialDuration);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [playRequest, setPlayRequest] = useState<{ token: number; targetKey: string; relativeTime: number } | null>(null);
  const [seekRequest, setSeekRequest] = useState({ token: 0, relativeTime: 0 });
  const [selectedSegmentId, setSelectedSegmentId] = useState(segments[0]?.id || "");
  const selectedSegmentIdRef = useRef(selectedSegmentId);
  useLayoutEffect(() => {
    selectedSegmentIdRef.current = selectedSegmentId;
  }, [selectedSegmentId]);
  const [draggingBoundary, setDraggingBoundary] = useState<number | null>(null);
  const [extractingSegmentId, setExtractingSegmentId] = useState<string | null>(null);
  const [reorderTargetId, setReorderTargetId] = useState<string | null>(null);
  const reorderTargetRef = useRef<string | null>(null);
  const [segmentDragPreview, setSegmentDragPreview] = useState<{ id: string; label: string; thumbnailUrl?: string; start: number; end: number; x: number; y: number } | null>(null);

  const [timelineZoom, setTimelineZoom] = useState(1);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const [outputMenuOpen, setOutputMenuOpen] = useState(false);
  const outputMenuRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onAspectRatio, onChange });
  useLayoutEffect(() => { callbacksRef.current = { onAspectRatio, onChange }; }, [onAspectRatio, onChange]);

  const setSegments = (next: VideoSceneSegment[]) => {
    localSegmentsRef.current = next;
    setLocalSegments(next);
  };

  useEffect(() => {
    if (dragRef.current) return;
    const nextDuration = Math.max(0.001, durationHint || segments.at(-1)?.end || 0.001);
    durationRef.current = nextDuration;
    setDuration(nextDuration);
    const normalized = normalizeSegments(segments, nextDuration);
    setSegments(normalized);
    setSelectedSegmentId((current) => normalized.some((segment) => segment.id === current) ? current : normalized[0]?.id || "");
  }, [durationHint, segments]);

  useEffect(() => () => segmentDragCleanupRef.current?.(), []);

  useEffect(() => {
    if (outputSelection === "full" || localSegments.some((segment) => segment.id === outputSelection)) return;
    onOutputSelectionChange("full");
  }, [localSegments, onOutputSelectionChange, outputSelection]);

  useEffect(() => {
    if (selected || outputSelection === "full" || !localSegments.some((segment) => segment.id === outputSelection)) return;
    queueMicrotask(() => setSelectedSegmentId(outputSelection));
  }, [localSegments, outputSelection, selected]);

  useEffect(() => {
    const viewport = timelineViewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.stopPropagation();
      const zooming = event.metaKey || event.ctrlKey;
      if (zooming) {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const cursorX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
        const currentWidth = Math.max(1, viewport.scrollWidth);
        const anchor = (viewport.scrollLeft + cursorX) / currentWidth;
        const smoothFactor = Math.max(0.82, Math.min(1.22, Math.exp(-event.deltaY * 0.0025)));
        const nextZoom = Math.max(1, Math.min(24, timelineZoomRef.current * smoothFactor));
        if (Math.abs(nextZoom - timelineZoomRef.current) < 0.001) return;
        timelineZoomRef.current = nextZoom;
        setTimelineZoom(nextZoom);
        requestAnimationFrame(() => {
          viewport.scrollLeft = Math.max(0, anchor * viewport.scrollWidth - cursorX);
        });
        return;
      }
      if (timelineZoomRef.current > 1) {
        event.preventDefault();
        viewport.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  const selectedSegment = localSegments.find((segment) => segment.id === selectedSegmentId) || localSegments[0];
  const progress = Math.min(100, Math.max(0, currentTime / duration * 100));
  const timelineStyle = { "--scene-playhead": `${progress}%` } as CSSProperties;
  const replacementCount = useMemo(() => localSegments.filter((segment) => segment.replacementAssetId).length, [localSegments]);
  const rulerTickCount = Math.max(7, Math.min(145, Math.ceil(6 * timelineZoom) + 1));
  const rulerTicks = useMemo(() => Array.from({ length: rulerTickCount }, (_, index) => ({
    left: index / (rulerTickCount - 1) * 100,
    time: index / (rulerTickCount - 1) * duration,
  })), [duration, rulerTickCount]);
  const fallbackSamples = useMemo(() => normalizeSegments(segments, initialDuration)
    .filter((segment) => segment.thumbnailUrl)
    .map((segment) => ({ time: segment.thumbnailTime ?? segment.start, url: thumbnailAssetUrl(segment.thumbnailUrl) })), [segments, initialDuration]);
  const sourcePosterUrl = src.startsWith("/api/assets/") ? thumbnailAssetUrl(src) : "";
  // Keep the overview legible instead of squeezing a 15fps contact sheet into
  // one-pixel stripes. More source frames are revealed progressively as the
  // user zooms the timeline, up to the full sprite resolution.
  const overviewFilmstripFrameCount = Math.max(12, Math.min(30, Math.ceil(duration * 1.5)));
  const filmstripFrameCount = timelineSprite
    ? Math.min(Math.max(1, timelineSprite.frameCount), Math.max(1, Math.ceil(overviewFilmstripFrameCount * timelineZoom)))
    : Math.max(1, Math.ceil(overviewFilmstripFrameCount * timelineZoom));
  const filmstripFrames = useMemo(() => Array.from({ length: filmstripFrameCount }, (_, index) => {
    if (timelineSprite) {
      const columns = Math.max(1, timelineSprite.columns || filmstripFrameCount);
      const rows = Math.max(1, timelineSprite.rows || 1);
      const sourceFrameCount = Math.max(1, timelineSprite.frameCount);
      const sourceIndex = filmstripFrameCount <= 1
        ? 0
        : Math.round(index / (filmstripFrameCount - 1) * (sourceFrameCount - 1));
      const column = sourceIndex % columns;
      const row = Math.floor(sourceIndex / columns);
      return {
        key: `${timelineSprite.assetId}-${sourceIndex}-${index}`,
        style: {
          backgroundImage: `url("${directAssetUrl(timelineSprite.url)}")`,
          backgroundSize: `${columns * 100}% ${rows * 100}%`,
          backgroundPosition: `${columns <= 1 ? 0 : column / (columns - 1) * 100}% ${rows <= 1 ? 50 : row / (rows - 1) * 100}%`,
        } as CSSProperties,
      };
    }
    const time = (index + 0.5) / filmstripFrameCount * duration;
    const sample = [...fallbackSamples].reverse().find((item) => item.time <= time) || fallbackSamples[0];
    const previewUrl = sample?.url || sourcePosterUrl;
    return { key: `fallback-${index}`, style: previewUrl ? { backgroundImage: `url("${previewUrl}")` } as CSSProperties : undefined };
  }), [duration, fallbackSamples, filmstripFrameCount, sourcePosterUrl, timelineSprite]);

  const seek = (time: number) => {
    const next = Math.max(0, Math.min(durationRef.current, time));
    setCurrentTime(next);
    const active = localSegmentsRef.current.find((segment) => next >= segment.start && next < segment.end) || localSegmentsRef.current.at(-1);
    if (!active) return;
    if (!dragRef.current) setSelectedSegmentId(active.id);
    videoPlaybackManager.pause(playbackOwnerId, active.id);
    setPlaying(false);
    setSeekRequest((request) => ({ token: request.token + 1, relativeTime: Math.max(0, next - active.start) }));
  };

  const scrubAt = (surface: "transport" | "timeline", clientX: number, transport?: HTMLDivElement) => {
    const target = surface === "timeline" ? trackRef.current : transport;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    seek((clientX - rect.left) / Math.max(1, rect.width) * durationRef.current);
  };

  const beginScrub = (surface: "transport" | "timeline", event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".video-scene-boundary")) return;
    event.preventDefault();
    videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubRef.current = { pointerId: event.pointerId, surface };
    scrubAt(surface, event.clientX, event.currentTarget);
  };

  const moveScrub = (surface: "transport" | "timeline", event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubRef.current?.pointerId !== event.pointerId || scrubRef.current.surface !== surface) return;
    event.preventDefault();
    scrubAt(surface, event.clientX, event.currentTarget);
  };

  const endScrub = (surface: "transport" | "timeline", event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubRef.current?.pointerId !== event.pointerId || scrubRef.current.surface !== surface) return;
    scrubAt(surface, event.clientX, event.currentTarget);
    scrubRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const beginSegmentDrag = (segment: VideoSceneSegment, event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".react-flow__handle")) return;
    event.preventDefault();
    event.stopPropagation();
    segmentDragCleanupRef.current?.();
    reorderTargetRef.current = null;
    setReorderTargetId(null);
    const currentSegment = localSegmentsRef.current.find((item) => item.id === segment.id) || segment;
    const drag = { pointerId: event.pointerId, segment: currentSegment, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, activated: false };
    segmentDragRef.current = drag;
    // Match Video Master semantics: the first pointer press is the complete
    // selection + seek + play transaction. Waiting for pointer-up made a
    // normal 170ms press indistinguishable from the old hold-to-drag gesture,
    // leaving the label on Scene 02 while the decoder was still in Scene 01.
    // A real drag is recognised only by pointer movement below; duration of a
    // press can never suppress playback.
    playSelectedSourceSegment(currentSegment);

    const pointerId = event.pointerId;
    const outsideTimeline = (clientX: number, clientY: number) => {
      const editor = trackRef.current?.closest(".video-scene-workbench")?.getBoundingClientRect();
      return Boolean(editor && (clientX < editor.left - 12 || clientX > editor.right + 12 || clientY < editor.top - 12 || clientY > editor.bottom + 12));
    };
    const activate = (activeDrag: typeof drag, clientX: number, clientY: number) => {
      if (activeDrag.activated || segmentDragRef.current !== activeDrag) return;
      activeDrag.segment = localSegmentsRef.current.find((item) => item.id === activeDrag.segment.id) || activeDrag.segment;
      activeDrag.activated = true;
      setSegmentDragPreview({ id: activeDrag.segment.id, label: activeDrag.segment.label, thumbnailUrl: activeDrag.segment.thumbnailUrl, start: activeDrag.segment.start, end: activeDrag.segment.end, x: clientX, y: clientY });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      if (segmentDragCleanupRef.current === cleanup) segmentDragCleanupRef.current = null;
    };
    const move = (moveEvent: PointerEvent) => {
      const drag = segmentDragRef.current;
      if (!drag || drag.pointerId !== moveEvent.pointerId) return;
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      drag.lastX = moveEvent.clientX;
      drag.lastY = moveEvent.clientY;
      const distance = Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY);
      if (!drag.activated && distance >= SEGMENT_DRAG_ACTIVATION_PX) activate(drag, moveEvent.clientX, moveEvent.clientY);
      if (drag.activated && segmentDragPreviewRef.current) {
        segmentDragPreviewRef.current.style.left = `${moveEvent.clientX}px`;
        segmentDragPreviewRef.current.style.top = `${moveEvent.clientY}px`;
      }
      if (drag.activated) {
        const outside = distance > 12 && outsideTimeline(moveEvent.clientX, moveEvent.clientY);
        const target = (document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-video-segment-id]")?.dataset.videoSegmentId || null;
        setExtractingSegmentId(outside ? drag.segment.id : null);
        reorderTargetRef.current = !outside && target !== drag.segment.id ? target : null;
        setReorderTargetId(reorderTargetRef.current);
      }
    };
    const finish = (finishEvent: PointerEvent) => {
      const drag = segmentDragRef.current;
      if (!drag || drag.pointerId !== finishEvent.pointerId) return;
      finishEvent.preventDefault();
      finishEvent.stopPropagation();
      const distance = Math.hypot(finishEvent.clientX - drag.startX, finishEvent.clientY - drag.startY);
      const latestSegment = localSegmentsRef.current.find((item) => item.id === drag.segment.id) || drag.segment;
      if (drag.activated && distance > 16 && outsideTimeline(finishEvent.clientX, finishEvent.clientY)) onExtractSegment(latestSegment, finishEvent.clientX, finishEvent.clientY);
      else if (drag.activated && reorderTargetRef.current && reorderTargetRef.current !== latestSegment.id) {
        videoPlaybackManager.pause(playbackOwnerId, latestSegment.id);
        const ordered = [...localSegmentsRef.current].sort((left, right) => Number(left.sequenceIndex ?? left.index) - Number(right.sequenceIndex ?? right.index) || left.start - right.start);
        const sourceIndex = ordered.findIndex((segment) => segment.id === latestSegment.id);
        const targetIndex = ordered.findIndex((segment) => segment.id === reorderTargetRef.current);
        if (sourceIndex >= 0 && targetIndex >= 0) {
          const [moved] = ordered.splice(sourceIndex, 1);
          ordered.splice(targetIndex, 0, moved);
          const nextOrder = new Map(ordered.map((segment, index) => [segment.id, index]));
          const next = localSegmentsRef.current.map((segment) => ({ ...segment, sequenceIndex: nextOrder.get(segment.id) ?? segment.sequenceIndex }));
          setSegments(next);
          onChange(next, durationRef.current);
        }
      }
      // Pointer-down already committed the exact same transaction used by a
      // Video Master clip. Pointer-up only completes a possible drag; it must
      // never publish a second media command.
      if (finishEvent.type === "pointerup") {
        handledSegmentClickRef.current = latestSegment.id;
        window.setTimeout(() => {
          if (handledSegmentClickRef.current === latestSegment.id) handledSegmentClickRef.current = null;
        }, 0);
      }
      setExtractingSegmentId(null);
      reorderTargetRef.current = null;
      setReorderTargetId(null);
      setSegmentDragPreview(null);
      cleanup();
      segmentDragRef.current = null;
    };
    segmentDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, { capture: true, passive: false });
    window.addEventListener("pointercancel", finish, { capture: true, passive: false });
  };

  const commit = (next: VideoSceneSegment[]) => {
    const normalized = normalizeSegments(next, durationRef.current);
    setSegments(normalized);
    onChange(normalized, durationRef.current);
  };

  const resetSegments = restoreDetectedVideoSegments(localSegments, duration, detectedSegments);
  const canResetSegments = resetSegments.length > 0 && !videoSceneCutsMatch(localSegments, resetSegments);

  const resetDetectedScenes = () => {
    if (!canResetSegments) return;
    videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
    manualPlaybackRef.current = false;
    hoverSuppressedRef.current = true;
    const active = resetSegments.find((segment) => currentTime >= segment.start && currentTime < segment.end) || resetSegments.at(-1);
    if (active) setSelectedSegmentId(active.id);
    if (outputSelection !== "full" && !resetSegments.some((segment) => segment.id === outputSelection)) onOutputSelectionChange("full");
    commit(resetSegments);
  };

  const applyBoundary = (boundaryIndex: number, clientX: number) => {
    const track = trackRef.current;
    const current = localSegmentsRef.current;
    if (!track || boundaryIndex <= 0 || boundaryIndex >= current.length) return;
    const rect = track.getBoundingClientRect();
    const rawTime = (clientX - rect.left) / Math.max(1, rect.width) * durationRef.current;
    const minimumSceneDuration = Math.min(1 / 120, durationRef.current / Math.max(2, current.length * 20));
    const previous = current[boundaryIndex - 1];
    const following = current[boundaryIndex];
    const time = Math.max(previous.start + minimumSceneDuration, Math.min(following.end - minimumSceneDuration, rawTime));
    const boundaryChanged = Math.abs(time - previous.end) > 0.0000005;
    const next = current.map((segment, index) => index === boundaryIndex - 1
      ? { ...segment, end: time, clipAssetId: boundaryChanged ? undefined : segment.clipAssetId, clipUrl: boundaryChanged ? undefined : segment.clipUrl }
      : index === boundaryIndex
        ? { ...segment, start: time, clipAssetId: boundaryChanged ? undefined : segment.clipAssetId, clipUrl: boundaryChanged ? undefined : segment.clipUrl }
        : segment);
    setSegments(next);
    setSelectedSegmentId(following.id);
    seek(time);
  };

  const queueBoundary = (boundaryIndex: number, clientX: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.lastX = clientX;
    if (drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      const latest = dragRef.current;
      if (!latest) return;
      latest.raf = 0;
      applyBoundary(boundaryIndex, latest.lastX);
    });
  };

  const beginBoundaryDrag = (boundaryIndex: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { boundaryIndex, pointerId: event.pointerId, lastX: event.clientX, raf: 0 };
    setDraggingBoundary(boundaryIndex);
    applyBoundary(boundaryIndex, event.clientX);
  };

  const completeBoundaryDrag = (pointerId: number, clientX: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (drag.raf) cancelAnimationFrame(drag.raf);
    applyBoundary(drag.boundaryIndex, clientX);
    dragRef.current = null;
    setDraggingBoundary(null);
    commit(localSegmentsRef.current);
  };

  const splitAtPlayhead = () => {
    const target = localSegmentsRef.current.find((segment) => currentTime > segment.start + 1 / 120 && currentTime < segment.end - 1 / 120);
    if (!target) return;
    const nextId = `video-scene-${crypto.randomUUID()}`;
    const next = localSegmentsRef.current.flatMap((segment) => segment.id !== target.id ? [segment] : [
      { ...segment, end: currentTime },
      { ...segment, id: nextId, start: currentTime, thumbnailTime: currentTime, confidence: 1, replacementAssetId: undefined, replacementUrl: undefined },
    ]);
    setSelectedSegmentId(nextId);
    commit(next);
  };

  const captureCurrentFrame = async () => {
    if (!onCaptureFrame || capturingFrame) return;
    manualPlaybackRef.current = false;
    hoverSuppressedRef.current = true;
    videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
    const time = Math.max(0, Math.min(Math.max(0, durationRef.current - .001), currentTime));
    setCapturingFrame(true);
    try {
      await onCaptureFrame(time);
    } finally {
      setCapturingFrame(false);
    }
  };

  useEffect(() => {
    if (!outputMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!outputMenuRef.current?.contains(event.target as Node)) setOutputMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOutputMenuOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [outputMenuOpen]);

  const play = (manual: boolean, relativeTime?: number, targetKey = selectedSegmentIdRef.current || "full") => {
    if (manual) onActivate?.();
    const safeRelativeTime = Number.isFinite(relativeTime) ? Math.max(0, Number(relativeTime)) : 0;
    const command = videoPlaybackManager.play(playbackOwnerId, targetKey, {
      ...(Number.isFinite(relativeTime) ? { relativeTime: safeRelativeTime } : {}),
      intent: manual ? "manual" : "hover",
    });
    if (manual) {
      manualPlaybackRef.current = true;
      hoverSuppressedRef.current = false;
      // Scene selection and the media command are committed in different React
      // phases. Mirror the exact command token into the shared player so it can
      // complete the same post-commit handoff used by Video Master. Without
      // this request, the first click after import can reach the previous
      // playbackKey and be discarded before the selected scene is rendered.
      setPlayRequest({ token: command.id, targetKey, relativeTime: safeRelativeTime });
    }
    return command;
  };

  const playSelectedSourceSegment = (segment: VideoSceneSegment) => {
    const currentSegment = localSegmentsRef.current.find((item) => item.id === segment.id) || segment;
    setSelectedSegmentId(currentSegment.id);
    onOutputSelectionChange(currentSegment.id);
    // One click is one media command. Keeping seek and play under the same
    // command id prevents a late rejection from the interrupted scene from
    // clearing the manual authorization of the newly selected scene.
    play(true, 0, currentSegment.id);
  };

  useEffect(() => {
    if (typeof demoPlaybackToken !== "number") {
      demoPlaybackTokenRef.current = undefined;
      return;
    }
    if (!selected || demoPlaybackTokenRef.current === demoPlaybackToken) return;
    const segment = localSegmentsRef.current.find((item) => item.id === demoPlaybackSegmentId);
    if (!segment) return;
    demoPlaybackTokenRef.current = demoPlaybackToken;
    playSelectedSourceSegment(segment);
  }, [demoPlaybackSegmentId, demoPlaybackToken, selected]);

  const playHoverPreviewIfActive = () => {
    if (!hoverPlayback) return;
    const pointerIsOverStage = hoverPreviewRef.current || Boolean(stageRef.current?.matches(":hover"));
    if (!pointerIsOverStage || manualPlaybackRef.current || hoverSuppressedRef.current || playing) return;
    setMuted(true);
    play(false);
  };

  const togglePlayback = () => {
    if (!playing) {
      const targetKey = selectedSegmentIdRef.current || "full";
      const targetSegment = localSegmentsRef.current.find((segment) => segment.id === targetKey);
      const resumeTime = targetSegment
        ? videoPlaybackReplayTime(Math.max(0, currentTime - targetSegment.start), Math.max(.1, targetSegment.end - targetSegment.start))
        : videoPlaybackReplayTime(currentTime, durationRef.current);
      play(true, resumeTime, targetKey);
      return;
    }
    manualPlaybackRef.current = false;
    hoverSuppressedRef.current = true;
    videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
  };

  const openPreview = () => {
    hoverPreviewRef.current = false;
    manualPlaybackRef.current = false;
    videoPlaybackManager.stop(playbackOwnerId);
    onOpenPreview();
  };

  useEffect(() => {
    if (!selected) return;
    const toggleSelectedVideo = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!playing) play(true, undefined, selectedSegmentIdRef.current || "full");
      else {
        manualPlaybackRef.current = false;
        hoverSuppressedRef.current = true;
        videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
      }
    };
    window.addEventListener("keydown", toggleSelectedVideo, true);
    return () => window.removeEventListener("keydown", toggleSelectedVideo, true);
  }, [playing, selected]);

  const stageBackdrop = selectedSegment?.thumbnailUrl || segments[0]?.thumbnailUrl || sourcePosterUrl;

  return <div
    className="video-scene-editor video-editor-shell nopan nowheel"
    aria-label={`Video scene editor for ${title}`}
    onMouseLeave={() => {
      if (!hoverPlayback) return;
      hoverPreviewRef.current = false;
      // Leaving the node may end a hover preview, but it must never revoke a
      // transport command started by the Play button or Space key.
      if (manualPlaybackRef.current) return;
      hoverSuppressedRef.current = false;
      videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
    }}
    onPointerMove={() => {
      if (!hoverPlayback || hoverPreviewRef.current) return;
      hoverPreviewRef.current = true;
      playHoverPreviewIfActive();
    }}
    onDoubleClick={(event) => { if ((event.target as HTMLElement).closest("button,input,[role=slider]")) return; event.stopPropagation(); openPreview(); }}
  >
    <div
      ref={stageRef}
      className="video-scene-stage"
      style={stageBackdrop ? { "--video-stage-backdrop": `url("${thumbnailAssetUrl(stageBackdrop)}")` } as CSSProperties : undefined}
      onMouseEnter={() => {
        if (!hoverPlayback) return;
        hoverSuppressedRef.current = false;
        hoverPreviewRef.current = true;
        playHoverPreviewIfActive();
      }}
      onMouseLeave={() => {
        if (!hoverPlayback) return;
        hoverPreviewRef.current = false;
        if (!manualPlaybackRef.current) videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
      }}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); openPreview(); }}
    >
      {selectedSegment && <VideoMasterPlayer
        src={src}
        clipStart={selectedSegment.start}
        clipEnd={selectedSegment.end}
        backdropUrl={stageBackdrop ? thumbnailAssetUrl(stageBackdrop) : undefined}
        playbackOwnerId={playbackOwnerId}
        playbackKey={selectedSegment.id}
        active={selected}
        playRequestToken={playRequest?.targetKey === selectedSegment.id ? playRequest.token : undefined}
        playRequestRelativeTime={playRequest?.targetKey === selectedSegment.id ? playRequest.relativeTime : undefined}
        muted={muted}
        onMutedChange={setMuted}
        requestedRelativeTime={seekRequest.relativeTime}
        requestedSeekToken={seekRequest.token}
        externalCurrentTime={Math.max(0, currentTime - selectedSegment.start)}
        externalDuration={Math.max(.1, selectedSegment.end - selectedSegment.start)}
        onExternalSeek={(relativeTime) => seek(selectedSegment.start + relativeTime)}
        onAspectRatio={onAspectRatio}
        onMediaDuration={(exactDuration) => {
          if (!Number.isFinite(exactDuration) || exactDuration <= 0 || Math.abs(durationRef.current - exactDuration) < .0005) return;
          durationRef.current = exactDuration;
          setDuration(exactDuration);
          const normalized = normalizeSegments(localSegmentsRef.current, exactDuration);
          setSegments(normalized);
          callbacksRef.current.onChange(normalized, exactDuration);
        }}
        onPlaybackChange={(nextPlaying, playbackKey) => {
          if (playbackKey !== selectedSegmentIdRef.current) return;
          setPlaying(nextPlaying);
        }}
        onTimeChange={(relativeTime) => {
          if (selectedSegment.id !== selectedSegmentIdRef.current) return;
          setCurrentTime(Math.max(selectedSegment.start, Math.min(selectedSegment.end, selectedSegment.start + relativeTime)));
        }}
        onClipEnded={(_playback, playbackKey) => {
          if (playbackKey !== selectedSegmentIdRef.current) return;
          manualPlaybackRef.current = false;
          setPlaying(false);
        }}
      />}
      <button
        type="button"
        className="video-scene-stage-toggle"
        aria-label={playing ? "Pause source video" : "Play source video"}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); togglePlayback(); }}
        onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); openPreview(); }}
      />
    </div>

    <div className="video-scene-workbench nodrag nopan nowheel" onClick={(event) => event.stopPropagation()}>
      <div className="video-scene-transport">
        <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={togglePlayback}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
        <input
          type="range"
          className="video-scene-position-slider"
          aria-label="Video position"
          min={0}
          max={duration}
          step={0.001}
          value={Math.min(currentTime, duration)}
          style={{ "--video-progress": `${progress}%` } as CSSProperties}
          onPointerDown={(event) => {
            event.stopPropagation();
            videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
            const rect = event.currentTarget.getBoundingClientRect();
            seek((event.clientX - rect.left) / Math.max(1, rect.width) * durationRef.current);
          }}
          onClick={(event) => event.stopPropagation()}
          onInput={(event) => seek(Number(event.currentTarget.value))}
          onChange={(event) => seek(Number(event.currentTarget.value))}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            videoPlaybackManager.pause(playbackOwnerId, selectedSegmentIdRef.current || "full");
            if (event.key === "Home") seek(0);
            else if (event.key === "End") seek(durationRef.current);
            else seek(currentTime + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 0.001 : 1 / 30));
          }}
        />
        <code>{preciseTime(currentTime)} <i>/</i> {preciseTime(duration)}</code>
        <button type="button" aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted((current) => !current)}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
      </div>
      <div className="video-scene-readout">
        <span><b>{selectedSegment?.label || "Scene"}</b><em>{selectedSegment?.role || "scene"}</em><small>{localSegments.length} scene{localSegments.length === 1 ? "" : "s"}{replacementCount ? ` · ${replacementCount} replaced` : ""}</small></span>
        <code>{selectedSegment ? `${preciseTime(selectedSegment.start)} — ${preciseTime(selectedSegment.end)}` : preciseTime(0)}</code>
      </div>
      <div className="video-scene-timeline-surface">
      <div ref={timelineViewportRef} className="video-scene-timeline-viewport">
      <div className="video-scene-timeline-canvas" style={{ ...timelineStyle, width: `${timelineZoom * 100}%` }} onPointerDown={(event) => beginScrub("timeline", event)} onPointerMove={(event) => moveScrub("timeline", event)} onPointerUp={(event) => endScrub("timeline", event)} onPointerCancel={(event) => endScrub("timeline", event)}>
      <div className="video-scene-ruler" aria-hidden="true">{rulerTicks.map((tick) => <span key={tick.left} style={{ left: `${tick.left}%` }}><i />{rulerTime(tick.time)}</span>)}</div>
      <div ref={trackRef} className="video-scene-track">
        <div className="video-scene-filmstrip" aria-hidden="true">{filmstripFrames.map((frame) => <i key={frame.key} style={frame.style} />)}</div>
        {localSegments.map((segment, index) => {
          const left = segment.start / duration * 100;
          const width = Math.max(0.001, (segment.end - segment.start) / duration * 100);
          return <div
            data-video-segment-id={segment.id}
            className={`video-scene-segment-range ${segment.id === selectedSegment?.id ? "is-selected" : ""} ${!selected && segment.id === outputSelection ? "is-connected-output" : ""} ${segment.replacementAssetId ? "has-replacement" : ""} ${segmentDragPreview?.id === segment.id ? "is-grabbed" : ""} ${extractingSegmentId === segment.id ? "is-extracting" : ""} ${reorderTargetId === segment.id ? "is-reorder-target" : ""} ${demoClickSegmentId === segment.id ? "is-demo-clicking" : ""}`}
            style={{ left: `${left}%`, width: `${width}%` }}
            key={segment.id}
            title={`${segment.label} · ${preciseTime(segment.start)}–${preciseTime(segment.end)} · drag away to create a clip node`}
            onPointerDown={(event) => beginSegmentDrag(segment, event)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (handledSegmentClickRef.current === segment.id) {
                handledSegmentClickRef.current = null;
                return;
              }
              playSelectedSourceSegment(segment);
            }}
          >
            {segment.replacementAssetId && <i>R</i>}
            {demoClickSegmentId === segment.id && <i className="landing-node-demo-pointer is-scene" aria-hidden="true"><MousePointer2 size={18} /></i>}
          </div>;
        })}
        {localSegments.slice(0, -1).map((segment, index) => <button
          type="button"
          key={`boundary-${segment.id}`}
          className={`video-scene-boundary ${draggingBoundary === index + 1 ? "is-dragging" : ""}`}
          style={{ left: `${segment.end / duration * 100}%` }}
          aria-label={`Move boundary after ${segment.label}`}
          onPointerDown={(event) => beginBoundaryDrag(index + 1, event)}
          onPointerMove={(event) => { if (dragRef.current?.pointerId === event.pointerId) queueBoundary(index + 1, event.clientX); }}
          onPointerUp={(event) => completeBoundaryDrag(event.pointerId, event.clientX)}
          onPointerCancel={(event) => completeBoundaryDrag(event.pointerId, event.clientX)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const current = localSegmentsRef.current;
            const step = event.shiftKey ? 0.001 : 1 / 30;
            const previous = current[index];
            const following = current[index + 1];
            const minimum = 1 / 120;
            const time = Math.max(previous.start + minimum, Math.min(following.end - minimum, previous.end + (event.key === "ArrowRight" ? step : -step)));
            seek(time);
            commit(current.map((item, itemIndex) => itemIndex === index ? { ...item, end: time } : itemIndex === index + 1 ? { ...item, start: time } : item));
          }}
        ><span aria-hidden="true"><ChevronsLeftRight size={10} strokeWidth={2.4} /></span></button>)}
        <i className="video-scene-playhead" aria-hidden="true" />
      </div>
      </div>
      </div>
      </div>
      <div className="video-scene-actions">
        <span>⌘ + wheel zoom · wheel scroll · arrows 1 frame · Shift 1 ms <b>{Math.round(timelineZoom * 100)}%</b></span>
        <div>
          <button type="button" onClick={resetDetectedScenes} disabled={!canResetSegments} title="Restore automatically detected scenes"><RotateCcw size={12} />Reset cuts</button>
          <button type="button" onClick={splitAtPlayhead} disabled={!selectedSegment || currentTime <= selectedSegment.start + 1 / 120 || currentTime >= selectedSegment.end - 1 / 120}><Scissors size={12} />Split</button>
          <div ref={outputMenuRef} className={`video-scene-output-select ${outputMenuOpen ? "is-open" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="video-scene-output-trigger"
              aria-label="Choose Video Master input"
              aria-expanded={outputMenuOpen}
              title={`Video Master input · ${outputSelection === "full" ? "Full video" : localSegments.find((segment) => segment.id === outputSelection)?.label || "Full video"}`}
              onClick={() => setOutputMenuOpen((open) => !open)}
            ><Video size={11} /><span>{outputSelection === "full" ? "Full" : localSegments.find((segment) => segment.id === outputSelection)?.label || "Full"}</span><ChevronDown size={11} /></button>
            {outputMenuOpen && <div className="video-scene-output-menu" role="listbox" aria-label="Video Master input">
              {[{ value: "full", label: "Full video", detail: preciseTime(duration) }, ...localSegments.map((segment) => ({ value: segment.id, label: segment.label, detail: `${preciseTime(segment.start)} — ${preciseTime(segment.end)}` }))].map((option) => <button type="button" role="option" aria-selected={outputSelection === option.value} key={option.value} onClick={() => { onOutputSelectionChange(option.value); setOutputMenuOpen(false); }}><span><strong>{option.label}</strong><small>{option.detail}</small></span>{outputSelection === option.value && <Check size={11} />}</button>)}
            </div>}
          </div>
          <button
            type="button"
            className="is-screenshot"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void captureCurrentFrame();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.detail === 0) void captureCurrentFrame();
            }}
            disabled={!onCaptureFrame || capturingFrame}
            aria-busy={capturingFrame}
          ><Camera size={12} />Screenshot</button>
        </div>
      </div>
    </div>
    {segmentDragPreview && typeof document !== "undefined" && createPortal(<div
      ref={segmentDragPreviewRef}
      className={`video-segment-drag-preview ${extractingSegmentId === segmentDragPreview.id ? "is-detached" : ""}`}
      style={{ left: segmentDragPreview.x, top: segmentDragPreview.y }}
      aria-hidden="true"
    >
      <span className="video-segment-drag-preview-media" style={segmentDragPreview.thumbnailUrl ? { backgroundImage: `url("${thumbnailAssetUrl(segmentDragPreview.thumbnailUrl)}")` } : undefined}><Video size={12} /></span>
      <span><strong>{segmentDragPreview.label}</strong><small>{preciseTime(segmentDragPreview.start)} — {preciseTime(segmentDragPreview.end)}</small></span>
      <em>{extractingSegmentId === segmentDragPreview.id ? "Drop to create clip" : "Video segment"}</em>
    </div>, document.body)}
  </div>;
}
