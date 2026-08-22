export type VideoPlaybackAction = "play" | "pause" | "complete" | "stop";
export type VideoPlaybackIntent = "manual" | "sequence" | "hover";

export type VideoPlaybackCommand = {
  id: number;
  ownerId: string | null;
  targetKey: string | null;
  action: VideoPlaybackAction;
  intent: VideoPlaybackIntent;
  relativeTime?: number;
  continuous?: boolean;
};

export type VideoPlaybackTarget = {
  targetKey: string;
  relativeTime?: number;
};

export type VideoPlaybackProgress = {
  ownerId: string | null;
  targetKey: string | null;
  relativeTime: number;
  duration: number;
  playing: boolean;
  revision: number;
};

/**
 * Canvas media is a view until it owns the foreground transport.
 *
 * A selected node may attach one paused decoder so its controls and exact
 * duration are ready. Once any node starts playing, that command owns the
 * only attached canvas transport; every other node must fall back to its
 * persisted poster/thumbnail instead of keeping an object-storage range open.
 */
export function shouldAttachVideoTransport(input: {
  selected: boolean;
  ownerId: string;
  command: VideoPlaybackCommand;
}) {
  const foregroundOwner = input.command.action === "play" ? input.command.ownerId : null;
  return foregroundOwner ? foregroundOwner === input.ownerId : input.selected;
}

const EMPTY_PLAYBACK_PROGRESS: VideoPlaybackProgress = {
  ownerId: null,
  targetKey: null,
  relativeTime: 0,
  duration: 0,
  playing: false,
  revision: 0,
};

type RegisteredMedia = {
  ownerId: string;
  media: HTMLMediaElement;
};

/**
 * The single authority for foreground video playback.
 *
 * Components may own decoders, but they never decide whether an async play,
 * pause or media event is still current. Every user/sequence command receives
 * a monotonically increasing id. A media element can only claim playback for
 * that exact command; late play promises and events are rejected and paused.
 */
export class VideoPlaybackManager {
  private command: VideoPlaybackCommand = {
    id: 0,
    ownerId: null,
    targetKey: null,
    action: "stop",
    intent: "manual",
  };
  private readonly listeners = new Set<() => void>();
  private readonly registeredMedia = new Map<HTMLMediaElement, RegisteredMedia>();
  private readonly lastTargets = new Map<string, VideoPlaybackTarget>();
  private readonly progress = new Map<string, VideoPlaybackProgress>();
  private readonly progressListeners = new Map<string, Set<() => void>>();

  getSnapshot = () => this.command;

  /**
   * The last explicit target for an editor survives while another node owns
   * playback. Persisted React data can arrive late, so live transport
   * selection must come from the transport authority when a node is resumed.
   */
  getLastTarget(ownerId: string) {
    return this.lastTargets.get(ownerId) || null;
  }

  getProgressSnapshot = (ownerId: string) => this.progress.get(ownerId) || EMPTY_PLAYBACK_PROGRESS;

  subscribeProgress(ownerId: string, listener: () => void) {
    const listeners = this.progressListeners.get(ownerId) || new Set<() => void>();
    listeners.add(listener);
    this.progressListeners.set(ownerId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.progressListeners.delete(ownerId);
    };
  }

  reportProgress(ownerId: string, targetKey: string, progress: { relativeTime?: number; duration?: number; playing?: boolean }) {
    if (this.command.ownerId !== ownerId || this.command.targetKey !== targetKey) return;
    this.setProgress(ownerId, targetKey, progress);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  play(ownerId: string, targetKey: string, options: { relativeTime?: number; intent?: VideoPlaybackIntent; continuous?: boolean } = {}) {
    const requestedTime = Number.isFinite(options.relativeTime) ? Math.max(0, Number(options.relativeTime)) : undefined;
    // Every explicit Play gesture receives a new command id. Preparation is
    // idempotent in the media controllers, so superseding a cold command does
    // not reload an already assigned source. A time-based "pending" debounce
    // made a failed first attempt indistinguishable from an in-flight one and
    // left freshly imported nodes unable to retry until a page reload.
    this.lastTargets.set(ownerId, {
      targetKey,
      ...(requestedTime !== undefined ? { relativeTime: requestedTime } : {}),
    });
    const previous = this.progress.get(ownerId);
    this.setProgress(ownerId, targetKey, {
      relativeTime: requestedTime !== undefined
        ? requestedTime
        : previous?.targetKey === targetKey ? previous.relativeTime : 0,
      duration: previous?.targetKey === targetKey ? previous.duration : 0,
      playing: false,
    });
    const command = this.commit({
      ownerId,
      targetKey,
      action: "play",
      intent: options.intent || "manual",
      ...(requestedTime !== undefined ? { relativeTime: requestedTime } : {}),
      ...(options.continuous ? { continuous: true } : {}),
    });
    return command;
  }

  pause(ownerId: string, targetKey?: string) {
    if (this.command.ownerId !== ownerId) {
      this.pauseRegisteredMedia(ownerId);
      return this.command;
    }
    const command = this.commit({
      ownerId,
      targetKey: targetKey || (this.command.ownerId === ownerId ? this.command.targetKey : null),
      action: "pause",
      intent: "manual",
    });
    if (command.targetKey) this.setProgress(ownerId, command.targetKey, { playing: false });
    this.pauseRegisteredMedia(ownerId);
    return command;
  }

  stop(ownerId: string) {
    if (this.command.ownerId !== ownerId) {
      this.pauseRegisteredMedia(ownerId);
      return this.command;
    }
    const previousTarget = this.progress.get(ownerId)?.targetKey;
    const command = this.commit({ ownerId, targetKey: null, action: "stop", intent: "manual" });
    if (previousTarget) this.setProgress(ownerId, previousTarget, { playing: false });
    this.pauseRegisteredMedia(ownerId);
    return command;
  }

  complete(ownerId: string, targetKey: string) {
    if (this.command.ownerId !== ownerId) return this.command;
    return this.commit({ ownerId, targetKey, action: "complete", intent: this.command.intent });
  }

  stopAll() {
    const command = this.commit({ ownerId: null, targetKey: null, action: "stop", intent: "manual" });
    this.registeredMedia.forEach(({ media }) => media.pause());
    this.progress.forEach((entry, ownerId) => this.setProgress(ownerId, entry.targetKey || "", { playing: false }));
    return command;
  }

  register(ownerId: string, media: HTMLMediaElement) {
    this.registeredMedia.set(media, { ownerId, media });
    return () => {
      const current = this.registeredMedia.get(media);
      if (current?.ownerId === ownerId) this.registeredMedia.delete(media);
    };
  }

  /** Returns false and pauses the media when the async claim is stale. */
  claim(ownerId: string, targetKey: string, commandId: number, media: HTMLMediaElement) {
    const current = this.command;
    const authorized = current.id === commandId
      && current.action === "play"
      && current.ownerId === ownerId
      && current.targetKey === targetKey;
    if (!authorized) {
      media.pause();
      return false;
    }
    this.setProgress(ownerId, targetKey, { playing: true });
    this.registeredMedia.forEach((registered) => {
      if (registered.media !== media) registered.media.pause();
    });
    return true;
  }

  isCurrent(ownerId: string, targetKey: string, commandId: number, action: VideoPlaybackAction = "play") {
    return this.command.id === commandId
      && this.command.ownerId === ownerId
      && this.command.targetKey === targetKey
      && this.command.action === action;
  }

  private pauseRegisteredMedia(ownerId: string) {
    this.registeredMedia.forEach((registered) => {
      if (registered.ownerId === ownerId) registered.media.pause();
    });
  }

  private setProgress(ownerId: string, targetKey: string, patch: { relativeTime?: number; duration?: number; playing?: boolean }) {
    const previous = this.progress.get(ownerId) || EMPTY_PLAYBACK_PROGRESS;
    const next: VideoPlaybackProgress = {
      ownerId,
      targetKey,
      relativeTime: Number.isFinite(patch.relativeTime) ? Math.max(0, Number(patch.relativeTime)) : previous.relativeTime,
      duration: Number.isFinite(patch.duration) ? Math.max(0, Number(patch.duration)) : previous.duration,
      playing: patch.playing ?? previous.playing,
      revision: previous.revision + 1,
    };
    if (next.targetKey === previous.targetKey
      && Math.abs(next.relativeTime - previous.relativeTime) < .002
      && Math.abs(next.duration - previous.duration) < .002
      && next.playing === previous.playing) return;
    this.progress.set(ownerId, next);
    this.progressListeners.get(ownerId)?.forEach((listener) => listener());
  }

  private commit(next: Omit<VideoPlaybackCommand, "id">) {
    this.command = { ...next, id: this.command.id + 1 };
    // Stop every decoder outside the new owner synchronously, before React can
    // render the selected node. This removes the selection/play ordering race.
    if (this.command.action === "play" && this.command.ownerId) {
      this.registeredMedia.forEach((registered) => {
        if (registered.ownerId !== this.command.ownerId) registered.media.pause();
      });
      this.progress.forEach((entry, ownerId) => {
        if (ownerId !== this.command.ownerId && entry.targetKey) this.setProgress(ownerId, entry.targetKey, { playing: false });
      });
    }
    this.listeners.forEach((listener) => listener());
    return this.command;
  }
}

export const videoPlaybackManager = new VideoPlaybackManager();

// Compatibility helpers for the remaining simple media cards. They all share
// the same manager-backed stop path while they are migrated to explicit ids.
const legacyOwnerIds = new WeakMap<HTMLMediaElement, string>();
const legacyUnregisters = new WeakMap<HTMLMediaElement, () => void>();
let legacyOwnerSequence = 0;

function legacyOwnerId(owner: HTMLMediaElement) {
  const existing = legacyOwnerIds.get(owner);
  if (existing) return existing;
  const created = `legacy-video-${++legacyOwnerSequence}`;
  legacyOwnerIds.set(owner, created);
  legacyUnregisters.set(owner, videoPlaybackManager.register(created, owner));
  return created;
}

export function claimVideoPlayback(owner: HTMLMediaElement) {
  const ownerId = legacyOwnerId(owner);
  const command = videoPlaybackManager.play(ownerId, "legacy");
  videoPlaybackManager.claim(ownerId, "legacy", command.id, owner);
}

export function stopAllVideoPlayback() {
  videoPlaybackManager.stopAll();
}

export function subscribeToVideoPlaybackClaims(owner: HTMLMediaElement, onOwnershipLost: () => void) {
  const ownerId = legacyOwnerId(owner);
  const unsubscribe = videoPlaybackManager.subscribe(() => {
    const command = videoPlaybackManager.getSnapshot();
    if (command.action === "stop" || command.ownerId !== ownerId) onOwnershipLost();
  });
  return () => {
    unsubscribe();
    legacyUnregisters.get(owner)?.();
    legacyUnregisters.delete(owner);
    legacyOwnerIds.delete(owner);
  };
}

export function subscribeToVideoPlaybackGroup(owners: () => HTMLMediaElement[], onOwnershipLost: () => void) {
  const ownerIds = () => owners().map(legacyOwnerId);
  const unsubscribe = videoPlaybackManager.subscribe(() => {
    const command = videoPlaybackManager.getSnapshot();
    if (command.action === "stop" || !command.ownerId || !ownerIds().includes(command.ownerId)) onOwnershipLost();
  });
  return () => {
    unsubscribe();
    owners().forEach((owner) => {
      legacyUnregisters.get(owner)?.();
      legacyUnregisters.delete(owner);
      legacyOwnerIds.delete(owner);
    });
  };
}
