"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { SegmentedVideoController, type SegmentPlaybackIntent } from "@/lib/segmented-video-controller";
import { shouldAttachVideoTransport, videoPlaybackManager } from "@/lib/video-playback-owner";
import { shouldApplyVideoPlaybackRequest } from "@/lib/video-playback";

export type CanvasVideoPlaybackRequest = {
  token: number;
  playing: boolean;
  targetKey?: string;
  relativeTime?: number;
};

/**
 * Let object storage serve editor byte ranges directly.
 *
 * Proxying an open-ended media Range through Next and Caddy can leave a cold
 * Chromium deck at HAVE_NOTHING even though the object itself is healthy.
 * The API redirect is no-store and the controller refreshes an assigned deck
 * after an expired/failed signed URL, so direct R2 delivery remains reusable.
 */
export function assetPlaybackUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.delete("variant");
  // Bump the transport URL when the streaming response contract changes so a
  // browser cannot reuse an older cached 206 response for a new editor deck.
  parsed.searchParams.set("v", "6");
  parsed.searchParams.set("delivery", "direct");
  return `${parsed.pathname}${parsed.search}`;
}

function assetThumbnailUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.set("variant", "thumbnail");
  parsed.searchParams.set("delivery", "direct");
  parsed.searchParams.set("v", "3");
  return `${parsed.pathname}${parsed.search}`;
}

function formatVideoTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function formatPreciseVideoTime(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(value / 60);
  const wholeSeconds = Math.floor(value % 60);
  const milliseconds = Math.floor((value - Math.floor(value)) * 1000);
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

type PlayerConfig = {
  key: string;
  source: string;
  start: number;
  end: number;
  duration: number;
  autoPlay: boolean;
  hoverActive?: boolean;
  hoverFallback: boolean;
  seamlessEnd: boolean;
};

export function CanvasVideoPlayer({ src, variant, controlsPlacement = "overlay", controlsPortal, clipStart = 0, clipEnd, backdropUrl, blurBackdrop = false, autoPlay = false, hoverActive, hoverSession, selectionActive, clickToToggle = false, keyboardActive = false, seamlessClipEnd = false, preloadSrc, preloadStart = 0, playbackOwnerId, playbackKey, requestedRelativeTime, requestedSeekToken, requestedPlayback, externalCurrentTime, externalDuration, externalActions, onExternalSeek, onAspectRatio, onMediaDuration, onDoubleClick, onPlaybackChange, onTimeChange, onClipEnded }: {
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
  playbackOwnerId?: string;
  playbackKey?: string;
  requestedRelativeTime?: number;
  requestedSeekToken?: number;
  requestedPlayback?: CanvasVideoPlaybackRequest;
  externalCurrentTime?: number;
  externalDuration?: number;
  externalActions?: ReactNode;
  onExternalSeek?: (time: number) => void;
  onAspectRatio?: (ratio: number) => void;
  onMediaDuration?: (duration: number) => void;
  onDoubleClick?: () => void;
  onPlaybackChange?: (playing: boolean) => void;
  onTimeChange?: (relativeTime: number, duration: number) => void;
  onClipEnded?: (playback: "manual" | "hover", playbackSessionKey: string) => void;
}) {
  const generatedOwnerId = useId();
  const ownerId = playbackOwnerId || `canvas-video:${generatedOwnerId}`;
  const managerCommand = useSyncExternalStore(videoPlaybackManager.subscribe, videoPlaybackManager.getSnapshot, videoPlaybackManager.getSnapshot);
  const playerRef = useRef<HTMLDivElement>(null);
  const deckARef = useRef<HTMLVideoElement>(null);
  const deckBRef = useRef<HTMLVideoElement>(null);
  const controllerRef = useRef<SegmentedVideoController | null>(null);
  const manualPlaybackRef = useRef(false);
  const hoverPreviewRef = useRef(false);
  const hoverSuppressedRef = useRef(false);
  const externalScrubRef = useRef(false);
  const externalScrubReleaseTimerRef = useRef<number | null>(null);
  const previousSelectionActiveRef = useRef(selectionActive);
  const previousHoverSessionRef = useRef(hoverSession);
  const requestedPlaybackTokenRef = useRef<number | undefined>(requestedPlayback?.token === 0 ? 0 : undefined);
  const pendingPlaybackRequestRef = useRef<{ token: number; targetKey?: string } | null>(null);
  const transportAttemptRef = useRef(0);
  const transportRetryRef = useRef<{ token: number; attempts: number }>({ token: 0, attempts: 0 });
  const transportRetryTimerRef = useRef<number | null>(null);
  const completedPlaybackRef = useRef<{ key: string; position: number } | null>(null);
  const callbacksRef = useRef({ onAspectRatio, onMediaDuration, onPlaybackChange, onTimeChange, onClipEnded });
  const playbackOwnerIdRef = useRef(ownerId);
  const playbackKeyRef = useRef(playbackKey || "media");
  const desiredKeyRef = useRef("");
  const intentRef = useRef<SegmentPlaybackIntent | null>(null);
  const managerCommandIdRef = useRef(0);
  const [controllerVersion, setControllerVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [externalScrubTime, setExternalScrubTime] = useState<number | null>(null);

  const safeClipStart = Number.isFinite(clipStart) ? Math.max(0, Number(clipStart)) : 0;
  const requestedClipEnd = Number.isFinite(clipEnd) ? Number(clipEnd) : mediaDuration;
  const safeClipEnd = requestedClipEnd > safeClipStart ? requestedClipEnd : Math.max(safeClipStart + .1, mediaDuration);
  const clipDuration = Math.max(.1, safeClipEnd - safeClipStart);
  const sessionKey = `${playbackKey || "media"}|${src}|${safeClipStart.toFixed(6)}|${safeClipEnd.toFixed(6)}`;
  const managerRequest = useMemo(() => (managerCommand.action === "play" || managerCommand.action === "pause")
    && managerCommand.ownerId === ownerId
    && (!managerCommand.targetKey || managerCommand.targetKey === playbackKey)
    ? {
        token: managerCommand.id,
        playing: managerCommand.action === "play",
        targetKey: managerCommand.targetKey || undefined,
        relativeTime: managerCommand.relativeTime,
      }
    : undefined, [managerCommand, ownerId, playbackKey]);
  const transportAttached = shouldAttachVideoTransport({
    selected: Boolean(selectionActive),
    ownerId,
    command: managerCommand,
  });
  const transportAttachedRef = useRef(transportAttached);
  useLayoutEffect(() => {
    transportAttachedRef.current = transportAttached;
  }, [transportAttached]);
  const effectivePlaybackRequest = managerRequest || requestedPlayback;
  const directSource = useMemo(() => src ? assetPlaybackUrl(src) : "", [src]);
  const directPreloadSource = useMemo(() => preloadSrc ? assetPlaybackUrl(preloadSrc) : "", [preloadSrc]);
  const configRef = useRef<PlayerConfig>({ key: sessionKey, source: directSource, start: safeClipStart, end: safeClipEnd, duration: clipDuration, autoPlay, hoverActive, hoverFallback: hoverSession !== undefined, seamlessEnd: seamlessClipEnd });
  useLayoutEffect(() => {
    callbacksRef.current = { onAspectRatio, onMediaDuration, onPlaybackChange, onTimeChange, onClipEnded };
    playbackOwnerIdRef.current = ownerId;
    playbackKeyRef.current = playbackKey || "media";
    configRef.current = { key: sessionKey, source: directSource, start: safeClipStart, end: safeClipEnd, duration: clipDuration, autoPlay, hoverActive, hoverFallback: hoverSession !== undefined, seamlessEnd: seamlessClipEnd };
    desiredKeyRef.current = sessionKey;
  }, [autoPlay, clipDuration, directSource, hoverActive, hoverSession, onAspectRatio, onClipEnded, onMediaDuration, onPlaybackChange, onTimeChange, ownerId, playbackKey, safeClipEnd, safeClipStart, seamlessClipEnd, sessionKey]);

  const relativeTime = Math.min(clipDuration, Math.max(0, currentTime - safeClipStart));
  const displayedDuration = controlsPlacement === "external" && Number.isFinite(externalDuration) ? Math.max(.1, Number(externalDuration)) : clipDuration;
  const controlledExternalTime = Number.isFinite(externalCurrentTime) ? Math.min(displayedDuration, Math.max(0, Number(externalCurrentTime))) : relativeTime;
  const displayedTime = controlsPlacement === "external"
    ? Math.min(displayedDuration, Math.max(0, externalScrubTime ?? controlledExternalTime))
    : relativeTime;
  const progress = displayedDuration > 0 ? Math.min(100, Math.max(0, displayedTime / displayedDuration * 100)) : 0;

  const resolveIntent = (): SegmentPlaybackIntent | null => {
    const config = configRef.current;
    if (manualPlaybackRef.current || config.autoPlay) return "manual";
    const controlledHover = typeof config.hoverActive === "boolean";
    const hovered = controlledHover
      ? Boolean(config.hoverActive || (config.hoverFallback && hoverPreviewRef.current))
      : hoverPreviewRef.current || Boolean(playerRef.current?.matches(":hover"));
    return hovered && !hoverSuppressedRef.current ? "hover" : null;
  };

  const clearTransportRetry = () => {
    if (transportRetryTimerRef.current !== null) window.clearTimeout(transportRetryTimerRef.current);
    transportRetryTimerRef.current = null;
  };

  const syncTransport = (position?: number, requestToken?: number) => {
    const controller = controllerRef.current;
    const config = configRef.current;
    // A click can arrive in the first committed frame, before the controller
    // effect has attached the media decks. Do not mark that command pending
    // until a controller actually accepts it; controllerVersion will replay
    // the still-unhandled manager command after mount.
    if (!controller || !config.source || !transportAttachedRef.current) return false;
    const pendingExplicitRequest = pendingPlaybackRequestRef.current;
    if (requestToken === undefined
      && pendingExplicitRequest
      && (!pendingExplicitRequest.targetKey || pendingExplicitRequest.targetKey === playbackKey)) {
      if (playerRef.current) playerRef.current.dataset.transportEvent = "explicit-request-pending";
      return false;
    }
    const intent = resolveIntent();
    let managerCommandId = requestToken;
    if (intent && managerCommandId === undefined) {
      const current = videoPlaybackManager.getSnapshot();
      if (current.action === "play" && current.ownerId === ownerId && current.targetKey === (playbackKey || null)) managerCommandId = current.id;
      else return;
    }
    if (managerCommandId !== undefined) {
      managerCommandIdRef.current = managerCommandId;
      if (requestToken === undefined) {
        requestToken = managerCommandId;
      }
    }
    if (requestToken !== undefined) {
      if (transportRetryRef.current.token !== requestToken) transportRetryRef.current = { token: requestToken, attempts: 0 };
      pendingPlaybackRequestRef.current = { token: requestToken, targetKey: playbackKey };
    }
    if (playerRef.current) {
      playerRef.current.dataset.transportEvent = "sync";
      playerRef.current.dataset.transportIntent = intent || "none";
      playerRef.current.dataset.manualPlayback = manualPlaybackRef.current ? "true" : "false";
      playerRef.current.dataset.autoPlay = config.autoPlay ? "true" : "false";
    }
    intentRef.current = intent;
    controller.setMuted(intent === "hover" ? true : muted);
    const transportAttempt = ++transportAttemptRef.current;
    clearTransportRetry();
    if (requestToken !== undefined) {
      const retryToken = requestToken;
      const retryPosition = position;
      const retryTarget = playbackKey;
      const retryConfigKey = config.key;
      const delay = 900 + transportRetryRef.current.attempts * 450;
      transportRetryTimerRef.current = window.setTimeout(() => {
        transportRetryTimerRef.current = null;
        const current = videoPlaybackManager.getSnapshot();
        if (transportAttempt !== transportAttemptRef.current
          || current.action !== "play"
          || current.id !== retryToken
          || current.ownerId !== ownerId
          || current.targetKey !== (retryTarget || null)
          || desiredKeyRef.current !== retryConfigKey
          || transportRetryRef.current.attempts >= 4) return;
        transportRetryRef.current.attempts += 1;
        syncTransport(retryPosition, retryToken);
      }, delay);
    }
    void controller.setSegment({
      key: config.key,
      src: config.source,
      start: config.start,
      end: config.end,
      position,
      play: Boolean(intent) && !externalScrubRef.current,
      intent: intent || "manual",
      seamlessEnd: config.seamlessEnd,
    }).then((applied) => {
      if (transportAttempt !== transportAttemptRef.current) return;
      if (requestToken !== undefined && pendingPlaybackRequestRef.current?.token === requestToken) {
        pendingPlaybackRequestRef.current = null;
      }
      if (!applied || desiredKeyRef.current !== config.key) {
        clearTransportRetry();
        const current = videoPlaybackManager.getSnapshot();
        if (requestToken !== undefined
          && current.action === "play"
          && current.id === requestToken
          && current.ownerId === ownerId
          && current.targetKey === (playbackKey || null)
          && transportRetryRef.current.attempts < 4) {
          transportRetryRef.current.attempts += 1;
          transportRetryTimerRef.current = window.setTimeout(() => {
            transportRetryTimerRef.current = null;
            if (transportAttempt !== transportAttemptRef.current) return;
            syncTransport(position, requestToken);
          }, 120);
        }
        return;
      }
      clearTransportRetry();
      transportRetryRef.current = { token: requestToken || 0, attempts: 0 };
      // A playback request is complete only after this exact transport
      // command has won every load/seek/play race. Marking it handled before
      // setSegment resolves lets an ordinary React re-render replace a
      // still-pending explicit scene click with an unpositioned sync. That is
      // what made rapid 03 -> 01/02 switches inherit the old deck time.
      if (requestToken !== undefined) requestedPlaybackTokenRef.current = requestToken;
      controller.preload(directPreloadSource, preloadStart);
    });
    return true;
  };

  const stopPlayback = (suppressHover = true, notifyOwner = true) => {
    clearTransportRetry();
    transportAttemptRef.current += 1;
    manualPlaybackRef.current = false;
    hoverPreviewRef.current = false;
    hoverSuppressedRef.current = suppressHover;
    intentRef.current = null;
    controllerRef.current?.stop();
    setPlaying(false);
    if (notifyOwner) callbacksRef.current.onPlaybackChange?.(false);
  };

  useEffect(() => {
    const deckA = deckARef.current;
    const deckB = deckBRef.current;
    if (!deckA || !deckB) return;
    const controller = new SegmentedVideoController([deckA, deckB], {
      onActiveDeck: (deck) => {
        const duration = Number.isFinite(deck.duration) ? deck.duration : 0;
        setMediaDuration(duration);
        if (duration > 0) callbacksRef.current.onMediaDuration?.(duration);
      },
      onAspectRatio: (ratio) => callbacksRef.current.onAspectRatio?.(ratio),
      // Preparing a replacement deck is transient UI state. It must not tell
      // Video Master that its whole sequence was paused.
      onPreparing: () => {
        setPlaying(false);
        videoPlaybackManager.reportProgress(playbackOwnerIdRef.current, playbackKeyRef.current, { playing: false });
      },
      onPlaybackChange: (nextPlaying) => {
        setPlaying(nextPlaying);
        videoPlaybackManager.reportProgress(playbackOwnerIdRef.current, playbackKeyRef.current, { playing: nextPlaying });
      },
      onProgress: (snapshot) => {
        if (snapshot.key !== desiredKeyRef.current) return;
        setCurrentTime(snapshot.currentTime);
        videoPlaybackManager.reportProgress(playbackOwnerIdRef.current, playbackKeyRef.current, {
          relativeTime: snapshot.relativeTime,
          duration: snapshot.duration,
          playing: snapshot.playing,
        });
        if (!externalScrubRef.current) callbacksRef.current.onTimeChange?.(snapshot.relativeTime, snapshot.duration);
      },
      onEnded: (intent, playbackSessionKey) => {
        if (!configRef.current.seamlessEnd) {
          // A completed manual command must relinquish transport ownership.
          // Leaving this ref armed makes the React update caused by onEnded
          // resolve back to `play: true`, which restarts the last physical
          // clip and lets its late ownership claim pause the scene selected
          // immediately afterwards (the Scene 03 -> Scene 01/02 deadlock).
          if (intentRef.current === intent) intentRef.current = null;
          if (intent === "manual") {
            manualPlaybackRef.current = false;
            // Do not immediately reinterpret the same pointer presence as a
            // fresh hover request and replay the clip that just completed.
            hoverSuppressedRef.current = true;
          }
          const activeDeckDuration = controllerRef.current?.activeDeck.duration;
          completedPlaybackRef.current = {
            key: playbackSessionKey,
            position: Number.isFinite(activeDeckDuration)
              ? Math.min(configRef.current.end, Number(activeDeckDuration))
              : configRef.current.end,
          };
          setPlaying(false);
        }
        callbacksRef.current.onClipEnded?.(intent, playbackSessionKey);
      },
      onPlaybackOwner: (deck) => {
        if (!videoPlaybackManager.claim(playbackOwnerIdRef.current, playbackKeyRef.current, managerCommandIdRef.current, deck)) stopPlayback(true, true);
      },
      onError: () => setPlaying(false),
    });
    controllerRef.current = controller;
    controller.setMuted(muted);
    const unregisterA = videoPlaybackManager.register(ownerId, deckA);
    const unregisterB = videoPlaybackManager.register(ownerId, deckB);
    setControllerVersion((version) => version + 1);
    return () => {
      unregisterA();
      unregisterB();
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // The controller owns the two physical media elements for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (transportAttached) return;
    pendingPlaybackRequestRef.current = null;
    clearTransportRetry();
    transportAttemptRef.current += 1;
    controllerRef.current?.release();
    setPlaying(false);
  }, [transportAttached]);

  useEffect(() => {
    if (!requestedPlayback && (managerCommand.action === "stop" || managerCommand.ownerId !== ownerId)) {
      let active = true;
      queueMicrotask(() => { if (active) stopPlayback(true, true); });
      return () => { active = false; };
    }
    const requestAlreadyPending = Boolean(effectivePlaybackRequest
      && pendingPlaybackRequestRef.current?.token === effectivePlaybackRequest.token
      && (!effectivePlaybackRequest.targetKey || effectivePlaybackRequest.targetKey === playbackKey));
    // React can render several intermediate states for one timeline click
    // (selection, hover session, autoplay and preload). The in-flight command
    // owns that click until it settles. Reissuing the same token here aborts
    // its own metadata/seek/play transaction and makes the first click look
    // ignored until another scene is visited.
    if (requestAlreadyPending) return;
    const requestApplies = Boolean(effectivePlaybackRequest && shouldApplyVideoPlaybackRequest({
      requestToken: effectivePlaybackRequest.token,
      handledToken: requestedPlaybackTokenRef.current,
      targetKey: effectivePlaybackRequest.targetKey,
      currentKey: playbackKey,
    }));
    if (playerRef.current) {
      playerRef.current.dataset.requestApplies = requestApplies ? "true" : "false";
      playerRef.current.dataset.requestToken = String(effectivePlaybackRequest?.token ?? "none");
      playerRef.current.dataset.requestPlaying = effectivePlaybackRequest?.playing ? "true" : "false";
      playerRef.current.dataset.requestTarget = effectivePlaybackRequest?.targetKey || "none";
      playerRef.current.dataset.playbackKey = playbackKey || "none";
      playerRef.current.dataset.selectionActive = selectionActive ? "true" : "false";
    }
    let position = Number.isFinite(requestedRelativeTime)
      ? safeClipStart + Math.min(clipDuration, Math.max(0, Number(requestedRelativeTime)))
      : undefined;
    if (requestApplies && effectivePlaybackRequest) {
      completedPlaybackRef.current = null;
      manualPlaybackRef.current = effectivePlaybackRequest.playing;
      hoverSuppressedRef.current = !effectivePlaybackRequest.playing;
      managerCommandIdRef.current = effectivePlaybackRequest.token;
      if (Number.isFinite(effectivePlaybackRequest.relativeTime)) position = safeClipStart + Math.min(clipDuration, Math.max(0, Number(effectivePlaybackRequest.relativeTime)));
    }
    const completedPlayback = completedPlaybackRef.current;
    if (position === undefined
      && completedPlayback?.key === sessionKey
      && !requestApplies
      && !autoPlay
      && !hoverActive) {
      position = completedPlayback.position;
    }
    setCurrentTime(position ?? safeClipStart);
    syncTransport(position, requestApplies ? effectivePlaybackRequest?.token : undefined);
    // A single effect translates React state into one atomic transport command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, controllerVersion, directPreloadSource, directSource, effectivePlaybackRequest, hoverActive, hoverSession, playbackKey, preloadStart, requestedRelativeTime, requestedSeekToken, safeClipEnd, safeClipStart, seamlessClipEnd, transportAttached]);

  useEffect(() => {
    if (managerCommand.action !== "stop" && managerCommand.ownerId === ownerId) return;
    let active = true;
    queueMicrotask(() => { if (active) stopPlayback(true, true); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerCommand.id, managerCommand.action, managerCommand.ownerId, ownerId]);

  useEffect(() => {
    const wasActive = previousSelectionActiveRef.current;
    previousSelectionActiveRef.current = selectionActive;
    if (wasActive === true && selectionActive === false) stopPlayback(true, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionActive]);

  useEffect(() => () => {
    if (externalScrubReleaseTimerRef.current !== null) window.clearTimeout(externalScrubReleaseTimerRef.current);
    clearTransportRetry();
  }, []);

  const togglePlayback = () => {
    if (!configRef.current.source) return;
    const current = videoPlaybackManager.getSnapshot();
    const targetKey = playbackKey || "media";
    if (current.action === "play" && current.ownerId === ownerId && current.targetKey === targetKey && controllerRef.current?.isPlaying) {
      videoPlaybackManager.pause(ownerId, playbackKey || "media");
      return;
    }
    videoPlaybackManager.play(ownerId, playbackKey || "media", { relativeTime });
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardActive, playing]);

  const controls = <div className={`${controlsPlacement === "external" ? "video-scene-transport" : `inline-video-controls inline-video-controls-${controlsPlacement}`} ${src ? "" : "is-media-empty"} nodrag nopan nowheel`} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button type="button" aria-label={playing ? "Pause video" : "Play video"} disabled={!src} onClick={(event) => { event.preventDefault(); event.stopPropagation(); togglePlayback(); }}>{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</button>
    <input
      className={controlsPlacement === "external" ? "video-scene-position-slider" : undefined}
      type="range"
      min="0"
      max={Math.max(displayedDuration, .01)}
      step={controlsPlacement === "external" ? "any" : ".01"}
      value={Math.min(displayedTime, Math.max(displayedDuration, .01))}
      aria-label="Video position"
      aria-valuetext={`${formatVideoTime(displayedTime)} of ${formatVideoTime(displayedDuration)}`}
      style={{ "--video-progress": `${progress}%` } as CSSProperties}
      onPointerDown={(event) => {
        event.stopPropagation();
        externalScrubRef.current = true;
        if (externalScrubReleaseTimerRef.current !== null) window.clearTimeout(externalScrubReleaseTimerRef.current);
        externalScrubReleaseTimerRef.current = null;
        setExternalScrubTime(displayedTime);
        event.currentTarget.setPointerCapture(event.pointerId);
        controllerRef.current?.pause();
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        externalScrubRef.current = false;
        syncTransport();
        externalScrubReleaseTimerRef.current = window.setTimeout(() => {
          externalScrubReleaseTimerRef.current = null;
          setExternalScrubTime(null);
        }, 80);
      }}
      onPointerCancel={(event) => {
        event.stopPropagation();
        externalScrubRef.current = false;
        setExternalScrubTime(null);
        syncTransport();
      }}
      onBlur={() => {
        if (!externalScrubRef.current) return;
        externalScrubRef.current = false;
        setExternalScrubTime(null);
        syncTransport();
      }}
      onInput={(event) => {
        const nextTime = Number(event.currentTarget.value);
        if (!Number.isFinite(nextTime)) return;
        if (controlsPlacement === "external" && onExternalSeek) {
          if (externalScrubRef.current) setExternalScrubTime(nextTime);
          onExternalSeek(nextTime);
        } else syncTransport(safeClipStart + nextTime);
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
      controllerRef.current?.setMuted(nextMuted);
    }}>{muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
    {controlsPlacement === "external" && externalActions}
  </div>;

  return <div
    ref={playerRef}
    className={`inline-video-player inline-video-${variant} controls-${controlsPlacement} ${playing ? "is-playing" : "is-paused"}`}
    data-playing={playing ? "true" : "false"}
    onMouseEnter={(event) => {
      if (!event.currentTarget.contains(event.target as Node)) return;
      const localHoverCanStart = typeof hoverActive !== "boolean" || hoverSession !== undefined;
      hoverPreviewRef.current = localHoverCanStart;
      if (previousHoverSessionRef.current !== hoverSession) previousHoverSessionRef.current = hoverSession;
      if (localHoverCanStart) hoverSuppressedRef.current = false;
      if (localHoverCanStart) videoPlaybackManager.play(ownerId, playbackKey || "media", { intent: "hover", relativeTime });
    }}
    onMouseLeave={(event) => {
      if (!event.currentTarget.contains(event.target as Node)) return;
      hoverPreviewRef.current = false;
      if (!manualPlaybackRef.current && !configRef.current.autoPlay) {
        event.currentTarget.dataset.transportEvent = "mouseleave-pause";
        intentRef.current = null;
        controllerRef.current?.pause();
        setPlaying(false);
      }
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
    {!transportAttached && directSource && <img className="inline-video-deck inline-video-poster" data-active-deck="true" src={assetThumbnailUrl(src)} alt="" loading="lazy" decoding="async" draggable={false} />}
    <video ref={deckARef} className="inline-video-deck" muted playsInline preload="none" draggable={false} />
    <video ref={deckBRef} className="inline-video-deck" muted playsInline preload="none" draggable={false} />
    <div className="inline-video-shade" aria-hidden="true" />
    {controlsPlacement === "external" ? (controlsPortal ? createPortal(controls, controlsPortal) : null) : controls}
  </div>;
}
