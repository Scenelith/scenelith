"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { editorPlaybackUrl } from "@/lib/editor-media";
import { shouldAttachVideoTransport, videoPlaybackManager } from "@/lib/video-playback-owner";
import { videoPlaybackReplayTime } from "@/lib/video-playback";

function precise(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}.${String(Math.floor(value % 1 * 1000)).padStart(3, "0")}`;
}

export function VideoMasterPlayer({ src, preloadSources = [], clipStart = 0, clipEnd, seamlessNext = false, backdropUrl, controlsPortal, playbackOwnerId, playbackKey, active, clickToToggle = false, keyboardActive = false, muted: controlledMuted, onMutedChange, playRequestToken, playRequestRelativeTime, requestedRelativeTime, requestedSeekToken, externalCurrentTime, externalDuration, externalActions, onExternalSeek, onAspectRatio, onMediaDuration, onDoubleClick, onPlaybackChange, onTimeChange, onClipEnded }: {
  src: string;
  preloadSources?: string[];
  clipStart?: number;
  clipEnd?: number;
  seamlessNext?: boolean;
  backdropUrl?: string;
  controlsPortal?: HTMLElement | null;
  playbackOwnerId: string;
  playbackKey: string;
  active: boolean;
  clickToToggle?: boolean;
  keyboardActive?: boolean;
  muted?: boolean;
  onMutedChange?: (muted: boolean) => void;
  playRequestToken?: number;
  playRequestRelativeTime?: number;
  requestedRelativeTime?: number;
  requestedSeekToken?: number;
  externalCurrentTime: number;
  externalDuration: number;
  externalActions?: ReactNode;
  onExternalSeek: (time: number) => void;
  onAspectRatio?: (ratio: number) => void;
  onMediaDuration?: (duration: number) => void;
  onDoubleClick?: () => void;
  onPlaybackChange?: (playing: boolean, playbackKey: string) => void;
  onTimeChange?: (relativeTime: number, duration: number) => void;
  onClipEnded?: (playback: "manual", playbackKey: string) => void;
}) {
  const mediaRefs = useRef(new Map<string, HTMLVideoElement>());
  const commandRef = useRef(0);
  const startedCommandRef = useRef(0);
  const completedCommandRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const recoveryRef = useRef({ commandId: 0, attempts: 0 });
  const visualClockRef = useRef<{
    video: HTMLVideoElement;
    commandId: number;
    animationFrame: number | null;
    videoFrame: number | null;
  } | null>(null);
  const activeRef = useRef(active);
  const playbackKeyRef = useRef(playbackKey);
  const playbackSource = useMemo(() => src ? editorPlaybackUrl(src) : "", [src]);
  const poolSignature = [src, ...preloadSources].filter(Boolean).join("\u0000");
  const mediaSources = useMemo(() => Array.from(new Set(
    poolSignature.split("\u0000").filter(Boolean).map(editorPlaybackUrl),
  )), [poolSignature]);
  const [playing, setPlaying] = useState(false);
  const [internalMuted, setInternalMuted] = useState(true);
  const muted = controlledMuted ?? internalMuted;
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [mediaDuration, setMediaDuration] = useState(0);
  const command = useSyncExternalStore(videoPlaybackManager.subscribe, videoPlaybackManager.getSnapshot, videoPlaybackManager.getSnapshot);
  const transportAttached = shouldAttachVideoTransport({ selected: active, ownerId: playbackOwnerId, command });
  const start = Math.max(0, Number(clipStart || 0));
  const activeVideo = () => mediaRefs.current.get(playbackSource) || null;
  const end = Number.isFinite(clipEnd) && Number(clipEnd) > start ? Number(clipEnd) : Math.max(start + .1, mediaDuration);
  const duration = Math.max(.1, end - start);
  const displayDuration = Math.max(.1, Number(externalDuration || duration));
  const displayTime = Math.min(displayDuration, Math.max(0, scrubTime ?? externalCurrentTime));
  const progress = displayTime / displayDuration * 100;
  useLayoutEffect(() => {
    activeRef.current = transportAttached;
    playbackKeyRef.current = playbackKey;
  }, [playbackKey, transportAttached]);

  useEffect(() => {
    mediaRefs.current.forEach((video) => { video.muted = muted; });
  }, [muted]);

  const clearRetry = () => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  };

  const pausePool = (except?: HTMLVideoElement) => {
    mediaRefs.current.forEach((video) => {
      if (video !== except && !video.paused) video.pause();
    });
  };

  const stopVisualClock = (video?: HTMLVideoElement) => {
    const clock = visualClockRef.current;
    if (!clock || (video && clock.video !== video)) return;
    if (clock.animationFrame !== null) cancelAnimationFrame(clock.animationFrame);
    if (clock.videoFrame !== null && typeof clock.video.cancelVideoFrameCallback === "function") {
      clock.video.cancelVideoFrameCallback(clock.videoFrame);
    }
    visualClockRef.current = null;
  };

  const synchronizeVisualTime = (video: HTMLVideoElement, mediaTime: number, commandId: number) => {
    const liveCommand = videoPlaybackManager.getSnapshot();
    if (!activeRef.current
      || commandRef.current !== commandId
      || startedCommandRef.current !== commandId
      || liveCommand.id !== commandId
      || liveCommand.action !== "play"
      || liveCommand.ownerId !== playbackOwnerId
      || liveCommand.targetKey !== playbackKeyRef.current) return false;
    const relative = Math.min(duration, Math.max(0, mediaTime - start));
    videoPlaybackManager.reportProgress(playbackOwnerId, playbackKeyRef.current, {
      relativeTime: relative,
      duration,
      playing: !video.paused,
    });
    onTimeChange?.(relative, duration);
    if (mediaTime < end - .012) return !video.paused;
    if (completedCommandRef.current === commandId) return false;
    completedCommandRef.current = commandId;
    if (!seamlessNext) {
      video.pause();
      queueMicrotask(() => setPlaying(false));
      videoPlaybackManager.complete(playbackOwnerId, playbackKeyRef.current);
      onPlaybackChange?.(false, playbackKeyRef.current);
    }
    onClipEnded?.("manual", playbackKeyRef.current);
    return false;
  };

  const startVisualClock = (video: HTMLVideoElement, commandId: number) => {
    stopVisualClock();
    const clock = { video, commandId, animationFrame: null as number | null, videoFrame: null as number | null };
    visualClockRef.current = clock;
    const requestNextFrame = () => {
      if (visualClockRef.current !== clock || video.paused || video.ended) return;
      if (typeof video.requestVideoFrameCallback === "function") {
        clock.videoFrame = video.requestVideoFrameCallback((_now, metadata) => {
          clock.videoFrame = null;
          if (visualClockRef.current !== clock) return;
          if (synchronizeVisualTime(video, metadata.mediaTime, commandId)) requestNextFrame();
          else if (visualClockRef.current === clock) visualClockRef.current = null;
        });
      } else {
        clock.animationFrame = requestAnimationFrame(() => {
          clock.animationFrame = null;
          if (visualClockRef.current !== clock) return;
          if (synchronizeVisualTime(video, video.currentTime, commandId)) requestNextFrame();
          else if (visualClockRef.current === clock) visualClockRef.current = null;
        });
      }
    };
    synchronizeVisualTime(video, video.currentTime, commandId);
    requestNextFrame();
  };

  const runCommand = (commandId: number, relativeTime: number, attempt = 0) => {
    const video = activeVideo();
    if (!video || !activeRef.current || !playbackSource) return;
    if (recoveryRef.current.commandId !== commandId) recoveryRef.current = { commandId, attempts: 0 };
    const commandKey = playbackKey;
    const commandSource = playbackSource;
    const commandStart = start;
    const commandDuration = duration;
    stopVisualClock();
    commandRef.current = commandId;
    startedCommandRef.current = 0;
    completedCommandRef.current = null;
    clearRetry();
    pausePool(video);
    const target = commandStart + Math.min(commandDuration, Math.max(0, relativeTime));
    const liveCommand = videoPlaybackManager.getSnapshot();
    const canContinueCurrentDecoder = liveCommand.id === commandId
      && liveCommand.continuous === true
      && !video.paused
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (canContinueCurrentDecoder) {
      if (!videoPlaybackManager.claim(playbackOwnerId, commandKey, commandId, video)) return;
      startedCommandRef.current = commandId;
      setPlaying(true);
      onPlaybackChange?.(true, commandKey);
      startVisualClock(video, commandId);
      return;
    }
    // A scene switch is an atomic pause → seek → play transaction, even when
    // it reuses the same physical source. The only exception is a natural
    // contiguous boundary handled above, where the same decoder and media
    // clock must keep running without a seek.
    if (!video.paused) video.pause();
    const stillCurrent = () => activeRef.current
      && playbackKeyRef.current === commandKey
      && commandRef.current === commandId
      && videoPlaybackManager.isCurrent(playbackOwnerId, commandKey, commandId);
    const execute = async () => {
      if (!stillCurrent()) return;
      const physicalEnd = Number.isFinite(video.duration) ? Math.max(0, video.duration - .001) : target;
      const seekTarget = Math.min(target, physicalEnd);
      try {
        if (Math.abs(video.currentTime - seekTarget) > .018) {
          video.currentTime = seekTarget;
          if (video.seeking || Math.abs(video.currentTime - seekTarget) > .018) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                video.removeEventListener("seeked", finish);
                window.clearTimeout(timeout);
                resolve();
              };
              const timeout = window.setTimeout(finish, 400);
              video.addEventListener("seeked", finish, { once: true });
            });
          }
        }
      } catch { /* loadedmetadata will retry the exact command */ }
      if (!stillCurrent()) return;
      try {
        await video.play();
        if (!stillCurrent() || !videoPlaybackManager.claim(playbackOwnerId, commandKey, commandId, video)) return;
      } catch {
        if (attempt >= 4 || !stillCurrent()) return;
        retryTimerRef.current = window.setTimeout(() => runCommand(commandId, relativeTime, attempt + 1), 160 + attempt * 220);
      }
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && !video.error) void execute();
    else {
      video.addEventListener("loadedmetadata", () => {
        if (playbackSource === commandSource) void execute();
      }, { once: true });
      // A freshly opened fullscreen editor owns a new DOM deck. Chromium may
      // leave an auto-preloaded range in NETWORK_EMPTY until it becomes the
      // foreground target. Start that exact deck immediately; repeated scene
      // clicks must not be required to wake it.
      if (video.networkState === HTMLMediaElement.NETWORK_EMPTY
        || video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE
        || video.error) video.load();
    }
  };

  const recoverCurrentCommand = (video: HTMLVideoElement) => {
    const live = videoPlaybackManager.getSnapshot();
    if (!activeRef.current
      || live.action !== "play"
      || live.ownerId !== playbackOwnerId
      || live.targetKey !== playbackKeyRef.current) return;
    const recovery = recoveryRef.current.commandId === live.id
      ? recoveryRef.current
      : { commandId: live.id, attempts: 0 };
    if (recovery.attempts >= 4) return;
    recoveryRef.current = { commandId: live.id, attempts: recovery.attempts + 1 };
    clearRetry();
    retryTimerRef.current = window.setTimeout(() => {
      if (!videoPlaybackManager.isCurrent(playbackOwnerId, playbackKeyRef.current, live.id)) return;
      // A new load follows the stable /api/assets URL and obtains a fresh R2
      // redirect. This repairs a cold or cancelled range without replacing
      // the scene, playback key, or user playhead.
      video.load();
      runCommand(live.id, Number(live.relativeTime || 0), recovery.attempts + 1);
    }, 180 + recovery.attempts * 260);
  };

  useEffect(() => {
    const unregisters = mediaSources.map((source) => {
      const video = mediaRefs.current.get(source);
      return video ? videoPlaybackManager.register(playbackOwnerId, video) : null;
    });
    return () => unregisters.forEach((unregister) => unregister?.());
  }, [mediaSources, playbackOwnerId]);

  useEffect(() => {
    if (!transportAttached) {
      commandRef.current = 0;
      startedCommandRef.current = 0;
      clearRetry();
      stopVisualClock();
      pausePool();
      queueMicrotask(() => setPlaying(false));
      return;
    }
    if (command.ownerId !== playbackOwnerId || command.targetKey !== playbackKey) return;
    if (command.action === "play") {
      if (commandRef.current !== command.id) runCommand(command.id, Number(command.relativeTime || 0));
    } else if (command.action === "pause" || command.action === "stop") {
      commandRef.current = command.id;
      startedCommandRef.current = 0;
      clearRetry();
      activeVideo()?.pause();
      queueMicrotask(() => setPlaying(false));
      onPlaybackChange?.(false, playbackKey);
    }
    // The transport snapshot is the only command trigger. Media boundaries
    // are read from the same committed render that owns playbackKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command.id, command.action, command.ownerId, command.targetKey, playbackKey, playbackOwnerId, playbackSource, transportAttached]);

  useEffect(() => {
    if (!transportAttached || playRequestToken === undefined) return;
    const relativeTime = Math.max(0, Number(playRequestRelativeTime || 0));
    const live = videoPlaybackManager.getSnapshot();
    const issued = live.action === "play" && live.ownerId === playbackOwnerId && live.targetKey === playbackKey
      ? live
      : videoPlaybackManager.play(playbackOwnerId, playbackKey, { relativeTime });
    if (commandRef.current !== issued.id) runCommand(issued.id, relativeTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playRequestRelativeTime, playRequestToken, playbackKey, playbackOwnerId, playbackSource, transportAttached]);

  useEffect(() => () => {
    clearRetry();
    stopVisualClock();
  }, []);

  useEffect(() => {
    const video = activeVideo();
    if (!video || !transportAttached || !Number.isFinite(requestedRelativeTime)) return;
    const target = start + Math.min(duration, Math.max(0, Number(requestedRelativeTime)));
    const seek = () => {
      if (mediaRefs.current.get(playbackSource) !== video) return;
      try { video.currentTime = target; } catch { /* metadata will make the seek legal */ }
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
  }, [duration, playbackSource, requestedRelativeTime, requestedSeekToken, start, transportAttached]);

  useEffect(() => {
    if (transportAttached) return;
    clearRetry();
    stopVisualClock();
    mediaRefs.current.forEach((video) => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    });
  }, [transportAttached]);

  useEffect(() => {
    if (!transportAttached) return;
    mediaRefs.current.forEach((video, source) => {
      if (source === playbackSource) return;
      video.pause();
      // A pool slot is only a reusable DOM shell. Once another physical file
      // becomes active it must not retain decoded data or a Range transport.
      video.removeAttribute("src");
      video.load();
      video.dataset.transportPhase = "released";
    });
  }, [mediaSources, playbackSource, transportAttached]);

  useEffect(() => {
    if (!keyboardActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      const focusedInput = target?.closest("input");
      if (target?.closest("textarea,select,button,a,[contenteditable='true']") || (focusedInput && !focusedInput.classList.contains("video-scene-position-slider"))) return;
      event.preventDefault();
      event.stopPropagation();
      const video = activeVideo();
      if (video && !video.paused) videoPlaybackManager.pause(playbackOwnerId, playbackKey);
      else videoPlaybackManager.play(playbackOwnerId, playbackKey, { relativeTime: videoPlaybackReplayTime(Math.max(0, Number(video?.currentTime || start) - start), duration) });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardActive, playbackKey, playbackOwnerId, playbackSource, start]);

  const toggle = () => {
    const video = activeVideo();
    if (video && !video.paused) videoPlaybackManager.pause(playbackOwnerId, playbackKey);
    else videoPlaybackManager.play(playbackOwnerId, playbackKey, { relativeTime: videoPlaybackReplayTime(Math.max(0, Number(video?.currentTime || start) - start), duration) });
  };

  const scrubAt = (event: ReactPointerEvent<HTMLInputElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const time = Math.max(0, Math.min(displayDuration, (event.clientX - rect.left) / Math.max(1, rect.width) * displayDuration));
    setScrubTime(time);
    onExternalSeek(time);
  };

  const beginScrub = (event: ReactPointerEvent<HTMLInputElement>) => {
    event.stopPropagation();
    pausePool();
    videoPlaybackManager.pause(playbackOwnerId, playbackKey);
    setPlaying(false);
    onPlaybackChange?.(false, playbackKey);
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubAt(event);
  };

  const moveScrub = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    scrubAt(event);
  };

  const finishScrub = (event: ReactPointerEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.type !== "pointercancel") scrubAt(event);
    setScrubTime(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const controls = <div className="video-scene-transport nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()}>
    <button type="button" aria-label={playing ? "Pause video" : "Play video"} disabled={!src} onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggle(); }}>{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</button>
    <input className="video-scene-position-slider" type="range" min="0" max={displayDuration} step="any" value={displayTime} aria-label="Video position" style={{ "--video-progress": `${progress}%` } as CSSProperties} onPointerDown={beginScrub} onPointerMove={moveScrub} onPointerUp={finishScrub} onPointerCancel={finishScrub} onInput={(event) => { const time = Number(event.currentTarget.value); setScrubTime(time); onExternalSeek(time); }} onChange={(event) => { const time = Number(event.currentTarget.value); setScrubTime(time); onExternalSeek(time); }} />
    <code>{precise(displayTime)} <i>/</i> {precise(displayDuration)}</code>
    <button type="button" aria-label={muted ? "Unmute video" : "Mute video"} onClick={(event) => { event.preventDefault(); event.stopPropagation(); const next = !muted; if (controlledMuted === undefined) setInternalMuted(next); onMutedChange?.(next); mediaRefs.current.forEach((video) => { video.muted = next; }); }}>{muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
    {externalActions}
  </div>;

  return <div className={`inline-video-player inline-video-scene controls-external ${playing ? "is-playing" : "is-paused"}`} data-playing={playing ? "true" : "false"} data-playback-key={playbackKey} data-media-pool-size={mediaSources.length} onClick={(event) => { if (!clickToToggle || (event.target as HTMLElement).closest("button,input,textarea,select,a")) return; event.preventDefault(); event.stopPropagation(); toggle(); }} onDoubleClick={(event) => { event.stopPropagation(); onDoubleClick?.(); }}>
    {backdropUrl && <span className="inline-video-backdrop" style={{ backgroundImage: `url("${backdropUrl}")` }} aria-hidden="true" />}
    {!transportAttached && backdropUrl && <img className="inline-video-deck inline-video-poster" data-active-deck="true" src={backdropUrl} alt="" loading="eager" decoding="async" draggable={false} aria-hidden="true" />}
    {mediaSources.map((source) => <video
      key={source}
      ref={(video) => { if (video) mediaRefs.current.set(source, video); else mediaRefs.current.delete(source); }}
      src={transportAttached && source === playbackSource ? source : undefined}
      className="inline-video-deck"
      data-master-source={source}
      data-active-deck={transportAttached && source === playbackSource ? "true" : "false"}
      muted={muted}
      playsInline
      preload={transportAttached && source === playbackSource ? "metadata" : "none"}
      draggable={false}
      onLoadedMetadata={(event) => {
        if (source !== playbackSource) return;
        const video = event.currentTarget;
        if (video.videoWidth && video.videoHeight) onAspectRatio?.(video.videoWidth / video.videoHeight);
        if (Number.isFinite(video.duration)) {
          setMediaDuration(video.duration);
          onMediaDuration?.(video.duration);
        }
      }}
      onPlaying={(event) => {
        if (source !== playbackSource) return;
        const live = videoPlaybackManager.getSnapshot();
        if (!activeRef.current || live.id !== commandRef.current || live.targetKey !== playbackKeyRef.current) { event.currentTarget.pause(); return; }
        if (!videoPlaybackManager.claim(playbackOwnerId, playbackKeyRef.current, live.id, event.currentTarget)) return;
        startedCommandRef.current = live.id;
        recoveryRef.current = { commandId: live.id, attempts: 0 };
        setPlaying(true);
        onPlaybackChange?.(true, playbackKeyRef.current);
        startVisualClock(event.currentTarget, live.id);
      }}
      onWaiting={(event) => {
        if (source !== playbackSource) return;
        stopVisualClock(event.currentTarget);
        setPlaying(false);
      }}
      onError={(event) => {
        if (source !== playbackSource) return;
        stopVisualClock(event.currentTarget);
        setPlaying(false);
        recoverCurrentCommand(event.currentTarget);
      }}
      onPause={(event) => {
        if (source !== playbackSource) return;
        stopVisualClock(event.currentTarget);
        setPlaying(false);
      }}
      onTimeUpdate={(event) => {
        if (source !== playbackSource) return;
        const video = event.currentTarget;
        const liveCommand = videoPlaybackManager.getSnapshot();
        synchronizeVisualTime(video, video.currentTime, liveCommand.id);
      }}
    />)}
    <div className="inline-video-shade" aria-hidden="true" />
    {controlsPortal ? createPortal(controls, controlsPortal) : null}
  </div>;
}
