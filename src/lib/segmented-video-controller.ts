export type SegmentPlaybackIntent = "manual" | "hover";

export type SegmentPlaybackCommand = {
  /** External transport command that authorized this physical decoder run. */
  authorityId?: number;
  key: string;
  src: string;
  start: number;
  end: number;
  play: boolean;
  intent: SegmentPlaybackIntent;
  position?: number;
  seamlessEnd?: boolean;
};

export type SegmentPlaybackSnapshot = {
  commandId: number;
  key: string;
  deck: HTMLVideoElement;
  deckIndex: number;
  playing: boolean;
  currentTime: number;
  relativeTime: number;
  duration: number;
};

export type SegmentPlaybackControllerCallbacks = {
  onActiveDeck?: (deck: HTMLVideoElement, deckIndex: number) => void;
  onAspectRatio?: (ratio: number) => void;
  onPreparing?: () => void;
  onPlaybackChange?: (playing: boolean) => void;
  onProgress?: (snapshot: SegmentPlaybackSnapshot) => void;
  onEnded?: (intent: SegmentPlaybackIntent, key: string) => void;
  onPlaybackOwner?: (deck: HTMLVideoElement, key: string, authorityId?: number) => void;
  onError?: (error: unknown) => void;
};

const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const NETWORK_NO_SOURCE = 3;
const SEEK_TOLERANCE = .035;
const END_TOLERANCE = .012;
const READY_TIMEOUT_MS = 12_000;

type DeckSource = {
  src: string;
  preloadToken: number;
};

function boundedMediaTime(media: HTMLVideoElement, requestedTime: number) {
  const duration = Number.isFinite(media.duration) ? Math.max(0, media.duration) : 0;
  if (!duration) return Math.max(0, requestedTime);
  return Math.min(Math.max(0, requestedTime), Math.max(0, duration - .001));
}

function effectiveSegmentEnd(media: HTMLVideoElement, command: SegmentPlaybackCommand) {
  const mediaDuration = Number.isFinite(media.duration) && media.duration > 0
    ? media.duration
    : command.end;
  return Math.max(command.start + .001, Math.min(command.end, mediaDuration));
}

/**
 * Imperative two-deck transport for an editor timeline.
 *
 * React may describe a segment, but it never sequences load/seek/play. Every
 * transport command invalidates the previous command. A late browser event or
 * play() promise from an interrupted clip therefore cannot revive that clip.
 */
export class SegmentedVideoController {
  private readonly decks: [HTMLVideoElement, HTMLVideoElement];
  private readonly deckSources: [DeckSource, DeckSource] = [
    { src: "", preloadToken: 0 },
    { src: "", preloadToken: 0 },
  ];
  private callbacks: SegmentPlaybackControllerCallbacks;
  private activeDeckIndex = 0;
  private pendingDeckIndex: number | null = null;
  private readonly deckCommandIds: [number, number] = [0, 0];
  private commandId = 0;
  private commandAbort: AbortController | null = null;
  private currentCommand: SegmentPlaybackCommand | null = null;
  private activeCommand: SegmentPlaybackCommand | null = null;
  // Native media events can arrive while a newly selected deck is still
  // seeking or while play() is unresolved. They must not be allowed to end
  // that command (and advance the editor) until the command actually owns a
  // playing deck.
  private playbackArmedCommandId = -1;
  private endedCommandId = -1;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private readonly cleanupListeners: Array<() => void> = [];

  constructor(decks: [HTMLVideoElement, HTMLVideoElement], callbacks: SegmentPlaybackControllerCallbacks = {}) {
    this.decks = decks;
    this.callbacks = callbacks;
    decks.forEach((deck, index) => {
      deck.muted = true;
      deck.playsInline = true;
      deck.preload = "auto";
      const onTimeUpdate = () => this.emitProgress(index);
      const onEnded = () => this.finishIfCurrent(index);
      const onPause = () => {
        // `pause` is queued by the media element. By the time it is delivered,
        // this physical deck may already have been reused and playing a newer
        // scene. The event describes the old action; the current media state
        // is the authority. Without this check, a late event from Scene 03 ->
        // Scene 01 flips React back to paused after Scene 01 has started.
        if (!deck.paused) return;
        if (index === this.activeDeckIndex && this.pendingDeckIndex === null) this.callbacks.onPlaybackChange?.(false);
      };
      deck.addEventListener("timeupdate", onTimeUpdate);
      deck.addEventListener("ended", onEnded);
      deck.addEventListener("pause", onPause);
      this.cleanupListeners.push(() => {
        deck.removeEventListener("timeupdate", onTimeUpdate);
        deck.removeEventListener("ended", onEnded);
        deck.removeEventListener("pause", onPause);
      });
    });
    this.applyDeckVisibility(0);
  }

  setCallbacks(callbacks: SegmentPlaybackControllerCallbacks) {
    this.callbacks = callbacks;
  }

  get activeDeck() {
    return this.decks[this.activeDeckIndex];
  }

  get isPlaying() {
    return !this.activeDeck.paused && !this.activeDeck.ended;
  }

  get activeSource() {
    return this.deckSources[this.activeDeckIndex].src;
  }

  setMuted(muted: boolean) {
    this.decks.forEach((deck) => { deck.muted = muted; });
  }

  async setSegment(command: SegmentPlaybackCommand) {
    if (this.destroyed || !command.src) return false;
    // `currentCommand` is the latest requested command and may still be
    // waiting for metadata or a seek. Playback continuity must only be based
    // on the command that actually owns the visible deck. Treating a pending
    // request as active can preserve an unrelated deck position (commonly the
    // end of the source after Scene 03 -> Scene 01) and makes the next play()
    // start at the wrong boundary.
    const previousActiveCommand = this.activeCommand;
    const operation = this.beginCommand(command);
    const targetIndex = this.deckIndexForSource(command.src);
    const target = this.decks[targetIndex];
    const previousActive = this.activeDeck;
    const targetTimeBelongsToSegment = target.currentTime >= command.start - .14
      && target.currentTime < command.end - END_TOLERANCE;
    const preserveCurrentPosition = !Number.isFinite(command.position)
      && previousActiveCommand?.key === command.key
      && targetIndex === this.activeDeckIndex
      && this.deckSources[targetIndex].src === command.src
      && targetTimeBelongsToSegment;
    const rawRequestedPosition = Number.isFinite(command.position)
      ? Number(command.position)
      : preserveCurrentPosition
        ? target.currentTime
        : command.start;
    // A segment key and its media clock are one state. Never allow a command
    // for Scene 02 to carry Scene 01's absolute time (for example 0.892 for a
    // 7.067-13.025 segment). Master Player already enforces this by converting
    // relative time inside its clip; source timelines use the same invariant
    // here at the shared transport boundary.
    const requestedPosition = Math.max(command.start, Math.min(command.end - .001, rawRequestedPosition));
    const canContinue = targetIndex === this.activeDeckIndex
      && this.deckSources[targetIndex].src === command.src
      && !target.paused
      && command.play
      && (!Number.isFinite(command.position) || Math.abs(target.currentTime - requestedPosition) <= .12)
      && target.currentTime >= command.start - .14
      && target.currentTime < command.end - END_TOLERANCE;

    this.pendingDeckIndex = targetIndex;
    const changingSegment = previousActiveCommand?.key !== command.key;
    const replacingActiveDeck = targetIndex !== this.activeDeckIndex
      || this.deckSources[this.activeDeckIndex].src !== command.src;
    const canKeepVisibleDeck = Boolean(
      changingSegment
      && !replacingActiveDeck
      && previousActiveCommand?.src === command.src
      && !previousActive.paused
      && command.play,
    );
    if (replacingActiveDeck || (changingSegment && !canKeepVisibleDeck)) {
      // A selected editor segment becomes the only visual truth immediately.
      // Never leave the previous clip (often an uploaded third scene) visible
      // while the requested source is loading or seeking.
      this.pauseDecks();
      this.applyDeckVisibility(null);
      this.callbacks.onPreparing?.();
    }
    target.dataset.transportCommand = String(operation);
    this.deckCommandIds[targetIndex] = operation;
    target.dataset.segmentKey = command.key;
    target.dataset.transportRequestedPlay = command.play ? "true" : "false";
    target.dataset.transportIntent = command.intent;
    target.dataset.transportRequestedPosition = requestedPosition.toFixed(6);
    target.dataset.transportPreservedPosition = preserveCurrentPosition ? "true" : "false";
    target.dataset.transportPhase = "preparing";
    if (!canContinue) {
      if (!this.prepareSource(targetIndex, command.src)) return false;
      if (!await this.waitForMetadata(target, operation)) return false;
      if (!this.isCurrent(operation)) return false;
      this.reportAspectRatio(target);
      if (!await this.seek(target, requestedPosition, operation)) return false;
      // `play()` is the browser's native request for current media data. Do
      // not wait for HAVE_CURRENT_DATA before issuing it: a suspended deck can
      // stay at HAVE_METADATA until playback itself wakes its range loader.
      // Reloading an already assigned source here aborts the old range request
      // and creates the production-only cancel/reload loop seen after rapid
      // Scene 03 -> Scene 01/02 switches. Paused preview commands still wait
      // for a decoded frame because they do not have play() to wake the deck.
      if (!command.play && !await this.waitForCurrentData(target, operation)) return false;
    }

    if (!this.isCurrent(operation)) return false;
    this.activeDeckIndex = targetIndex;
    this.pendingDeckIndex = null;
    this.activeCommand = this.currentCommand;
    target.dataset.transportPhase = command.play ? "starting" : "paused";
    this.applyDeckVisibility(targetIndex);
    this.callbacks.onActiveDeck?.(target, targetIndex);
    this.emitProgress(targetIndex, true);

    if (!command.play) {
      this.pauseDecks();
      this.callbacks.onPlaybackChange?.(false);
      return true;
    }

    if (previousActive !== target) previousActive.pause();
    return this.playPreparedDeck(target, targetIndex, operation);
  }

  pause() {
    if (this.destroyed) return;
    this.invalidateCommand(false);
    this.pauseDecks();
    this.activeDeck.dataset.transportPhase = "paused";
    this.callbacks.onPlaybackChange?.(false);
  }

  stop() {
    if (this.destroyed) return;
    this.invalidateCommand(true);
    this.currentCommand = null;
    this.activeCommand = null;
    this.pauseDecks();
    this.activeDeck.dataset.transportPhase = "stopped";
    this.callbacks.onPlaybackChange?.(false);
  }

  /**
   * Relinquish object-storage transport without destroying the reusable
   * controller. Pausing alone leaves Chromium Range requests open; a canvas
   * node that no longer owns the foreground lease must detach its sources.
   */
  release() {
    if (this.destroyed) return;
    this.invalidateCommand(true);
    this.currentCommand = null;
    this.activeCommand = null;
    this.pauseDecks();
    this.deckSources.forEach((source, index) => {
      source.src = "";
      source.preloadToken += 1;
      const deck = this.decks[index];
      deck.removeAttribute("src");
      deck.load();
      deck.dataset.transportPhase = "released";
    });
    this.applyDeckVisibility(null);
    this.callbacks.onPlaybackChange?.(false);
  }

  preload(src: string | undefined, start = 0) {
    if (this.destroyed || !src || src === this.activeSource) return;
    const existingIndex = this.deckSources.findIndex((deck) => deck.src === src);
    const targetIndex = existingIndex >= 0 ? existingIndex : 1 - this.activeDeckIndex;
    if (targetIndex === this.activeDeckIndex || targetIndex === this.pendingDeckIndex) return;
    const target = this.decks[targetIndex];
    if (!this.prepareSource(targetIndex, src)) return;
    const preloadToken = ++this.deckSources[targetIndex].preloadToken;
    const position = () => {
      if (this.destroyed || this.deckSources[targetIndex].src !== src || this.deckSources[targetIndex].preloadToken !== preloadToken) return;
      const bounded = boundedMediaTime(target, start);
      if (Math.abs(target.currentTime - bounded) > SEEK_TOLERANCE) {
        try { target.currentTime = bounded; } catch { /* metadata can still be settling */ }
      }
    };
    if (target.readyState >= HAVE_METADATA) position();
    else target.addEventListener("loadedmetadata", position, { once: true });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.invalidateCommand(true);
    this.pauseDecks();
    this.cleanupListeners.splice(0).forEach((cleanup) => cleanup());
    this.decks.forEach((deck) => {
      deck.removeAttribute("src");
      deck.load();
    });
  }

  private beginCommand(command: SegmentPlaybackCommand) {
    this.invalidateCommand(false);
    this.commandId += 1;
    this.commandAbort = new AbortController();
    this.currentCommand = {
      ...command,
      start: Math.max(0, Number(command.start || 0)),
      end: Math.max(Number(command.start || 0) + .1, Number(command.end || 0)),
    };
    this.endedCommandId = -1;
    return this.commandId;
  }

  private invalidateCommand(increment: boolean) {
    this.commandAbort?.abort();
    this.commandAbort = null;
    this.pendingDeckIndex = null;
    this.playbackArmedCommandId = -1;
    this.stopProgressMonitor();
    if (increment) this.commandId += 1;
  }

  private isCurrent(operation: number) {
    return !this.destroyed && operation === this.commandId && !this.commandAbort?.signal.aborted;
  }

  private deckIndexForSource(src: string) {
    if (this.deckSources[this.activeDeckIndex].src === src) return this.activeDeckIndex;
    const otherIndex = 1 - this.activeDeckIndex;
    if (this.deckSources[otherIndex].src === src) return otherIndex;
    return otherIndex;
  }

  private prepareSource(index: number, src: string) {
    const deck = this.decks[index];
    if (this.deckSources[index].src === src) {
      // A direct object-storage URL can expire or a connection can be cut
      // while this physical deck remains assigned to the stable API URL.
      // Re-assigning only a demonstrably failed source obtains a fresh signed
      // redirect without reloading healthy decks during ordinary React syncs.
      if (!deck.error && deck.networkState !== NETWORK_NO_SOURCE) return true;
      deck.pause();
      this.deckSources[index] = { src: "", preloadToken: this.deckSources[index].preloadToken + 1 };
      deck.removeAttribute("src");
      deck.load();
    }
    deck.pause();
    this.deckSources[index] = { src, preloadToken: this.deckSources[index].preloadToken + 1 };
    try {
      deck.src = src;
      deck.load();
      return true;
    } catch (error) {
      this.callbacks.onError?.(error);
      return false;
    }
  }

  private async waitForMetadata(deck: HTMLVideoElement, operation: number) {
    if (deck.readyState >= HAVE_METADATA) return true;
    return this.waitFor(deck, ["loadedmetadata", "durationchange"], () => deck.readyState >= HAVE_METADATA, operation);
  }

  private async waitForCurrentData(deck: HTMLVideoElement, operation: number) {
    if (deck.readyState >= HAVE_CURRENT_DATA && !deck.seeking) return true;
    return this.waitFor(deck, ["loadeddata", "canplay", "seeked"], () => deck.readyState >= HAVE_CURRENT_DATA && !deck.seeking, operation);
  }

  private async seek(deck: HTMLVideoElement, requestedTime: number, operation: number) {
    if (!this.isCurrent(operation)) return false;
    const target = boundedMediaTime(deck, requestedTime);
    if (Math.abs(deck.currentTime - target) <= SEEK_TOLERANCE && !deck.seeking) return true;
    try { deck.currentTime = target; }
    catch (error) {
      this.callbacks.onError?.(error);
      return false;
    }
    if (!deck.seeking && Math.abs(deck.currentTime - target) <= SEEK_TOLERANCE) return true;
    return this.waitFor(deck, ["seeked", "timeupdate", "canplay"], () => !deck.seeking && Math.abs(deck.currentTime - target) <= .12, operation);
  }

  private waitFor(deck: HTMLVideoElement, events: string[], ready: () => boolean, operation: number) {
    if (ready()) return Promise.resolve(true);
    const signal = this.commandAbort?.signal;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        events.forEach((event) => deck.removeEventListener(event, onEvent));
        deck.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onEvent = () => { if (ready()) finish(this.isCurrent(operation)); };
      const onError = () => {
        this.callbacks.onError?.(deck.error || new Error("Video failed to load"));
        finish(false);
      };
      const onAbort = () => finish(false);
      const timeout = setTimeout(() => {
        this.callbacks.onError?.(new Error(`Video transport timed out waiting for ${events.join("/")}`));
        finish(false);
      }, READY_TIMEOUT_MS);
      events.forEach((event) => deck.addEventListener(event, onEvent));
      deck.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      onEvent();
    });
  }

  private async playPreparedDeck(deck: HTMLVideoElement, deckIndex: number, operation: number) {
    if (!this.isCurrent(operation)) return false;
    try {
      await deck.play();
    } catch (firstError) {
      if (!this.isCurrent(operation)) return false;
      if (!await this.waitForCurrentData(deck, operation)) return false;
      try { await deck.play(); }
      catch (error) {
        if (this.isCurrent(operation)) {
          this.callbacks.onError?.(error || firstError);
          this.callbacks.onPlaybackChange?.(false);
        }
        return false;
      }
    }
    if (!this.isCurrent(operation)) {
      // play() is asynchronous and browsers are allowed to settle its promise
      // after a newer transport command has already reused this physical deck.
      // A stale command may only pause a deck while it still owns that deck;
      // otherwise it would stop the newly selected scene at random.
      if (this.deckCommandIds[deckIndex] === operation) deck.pause();
      return false;
    }
    const currentCommand = this.currentCommand;
    if (!currentCommand) return false;
    this.callbacks.onPlaybackOwner?.(deck, currentCommand.key, currentCommand.authorityId);
    this.playbackArmedCommandId = operation;
    deck.dataset.transportPhase = "playing";
    this.callbacks.onPlaybackChange?.(true);
    // An extremely short segment may finish before play() settles. Reconcile
    // once after arming so that a real end is still delivered, while stale
    // ended/timeupdate events from the seek window remain harmless.
    this.emitProgress(deckIndex, true);
    if (!this.isCurrent(operation) || this.endedCommandId === operation) return true;
    this.startProgressMonitor(operation);
    return true;
  }

  private reportAspectRatio(deck: HTMLVideoElement) {
    if (deck.videoWidth > 0 && deck.videoHeight > 0) this.callbacks.onAspectRatio?.(deck.videoWidth / deck.videoHeight);
  }

  private applyDeckVisibility(activeIndex: number | null) {
    this.decks.forEach((deck, index) => {
      const active = index === activeIndex;
      deck.dataset.activeDeck = active ? "true" : "false";
      deck.setAttribute("aria-hidden", active ? "false" : "true");
    });
  }

  private pauseDecks() {
    this.stopProgressMonitor();
    this.decks.forEach((deck) => deck.pause());
  }

  private emitProgress(deckIndex: number, force = false) {
    const command = this.currentCommand;
    if (!command || deckIndex !== this.activeDeckIndex || this.pendingDeckIndex !== null || (!force && this.endedCommandId === this.commandId)) return;
    const deck = this.decks[deckIndex];
    if (this.deckSources[deckIndex].src !== command.src) return;
    deck.dataset.transportCurrentTime = Number.isFinite(deck.currentTime) ? deck.currentTime.toFixed(6) : "nan";
    deck.dataset.transportPaused = deck.paused ? "true" : "false";
    deck.dataset.transportEnded = deck.ended ? "true" : "false";
    const segmentEnd = effectiveSegmentEnd(deck, command);
    const duration = Math.max(.001, segmentEnd - command.start);
    const relativeTime = Math.min(duration, Math.max(0, deck.currentTime - command.start));
    this.callbacks.onProgress?.({
      commandId: this.commandId,
      key: command.key,
      deck,
      deckIndex,
      playing: !deck.paused && !deck.ended,
      currentTime: deck.currentTime,
      relativeTime,
      duration,
    });
    // `HTMLMediaElement.ended` is not segment-scoped. Chromium can keep it
    // true after a source reached its physical end and while an editor seek
    // back into an earlier segment is settling. Treating that stale flag as
    // the end of the newly selected segment immediately advances the React
    // timeline again (Scene 03 -> Scene 02 -> Scene 03) before play() gets a
    // chance to clear it. The media clock is the only valid boundary for a
    // timeline segment.
    if (deck.currentTime >= segmentEnd - END_TOLERANCE) this.finishIfCurrent(deckIndex);
  }

  private finishIfCurrent(deckIndex: number) {
    const command = this.currentCommand;
    if (!command
      || deckIndex !== this.activeDeckIndex
      || this.pendingDeckIndex !== null
      || this.endedCommandId === this.commandId
      || this.playbackArmedCommandId !== this.commandId) return;
    const deck = this.decks[deckIndex];
    if (this.deckSources[deckIndex].src !== command.src) return;
    // A user-uploaded clip can be shorter than the provisional timeline
    // duration stored before metadata was available (for example 3.041667s
    // represented as a 5s scene). Waiting for the declared end leaves the
    // transport permanently armed after the browser has fired native `ended`.
    // Use the real media boundary while retaining the command/deck/armed
    // checks above, which reject stale `ended` events from interrupted clips.
    const segmentEnd = effectiveSegmentEnd(deck, command);
    if (deck.currentTime < segmentEnd - END_TOLERANCE) return;
    this.endedCommandId = this.commandId;
    deck.dataset.transportPhase = "ended";
    this.stopProgressMonitor();
    if (!command.seamlessEnd) deck.pause();
    this.callbacks.onProgress?.({
      commandId: this.commandId,
      key: command.key,
      deck,
      deckIndex,
      playing: Boolean(command.seamlessEnd && !deck.paused),
      currentTime: segmentEnd,
      relativeTime: segmentEnd - command.start,
      duration: segmentEnd - command.start,
    });
    if (!command.seamlessEnd) this.callbacks.onPlaybackChange?.(false);
    // The React editor must be able to reject completion from the scene that
    // owned playback before a newer click was committed. Returning the exact
    // transport key makes completion a scoped command result instead of a
    // global, anonymous `ended` notification.
    this.callbacks.onEnded?.(command.intent, command.key);
  }

  private startProgressMonitor(operation: number) {
    this.stopProgressMonitor();
    // One stable clock follows the active transport command. A video-frame
    // callback belongs to a physical deck and can silently stop after that
    // deck is paused/reused, leaving the media playing while the editor
    // playhead stays frozen. The transport interval is deck-independent and
    // is explicitly invalidated with the command.
    this.progressTimer = setInterval(() => {
      if (!this.isCurrent(operation) || this.activeDeck.paused) {
        this.stopProgressMonitor();
        return;
      }
      this.emitProgress(this.activeDeckIndex);
    }, 50);
  }

  private stopProgressMonitor() {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }
}
