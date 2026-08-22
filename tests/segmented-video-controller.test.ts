import assert from "node:assert/strict";
import test from "node:test";
import { SegmentedVideoController } from "../src/lib/segmented-video-controller";

class FakeVideo extends EventTarget {
  dataset: Record<string, string> = {};
  src = "";
  currentSrc = "";
  muted = true;
  playsInline = true;
  preload = "auto";
  paused = true;
  ended = false;
  seeking = false;
  readyState = 0;
  duration = 30;
  videoWidth = 1080;
  videoHeight = 1920;
  error: MediaError | null = null;
  loadCount = 0;
  playCount = 0;
  private mediaTime = 0;
  private heldPlay: { promise: Promise<void>; resolve: () => void } | null = null;
  private delayedPauseEvents = 0;
  private playFailuresRemaining = 0;

  get currentTime() { return this.mediaTime; }
  set currentTime(value: number) {
    this.mediaTime = value;
    this.seeking = true;
    queueMicrotask(() => {
      this.seeking = false;
      this.dispatchEvent(new Event("seeked"));
      this.dispatchEvent(new Event("timeupdate"));
    });
  }

  setAttribute() {}
  removeAttribute(name: string) { if (name === "src") { this.src = ""; this.currentSrc = ""; } }

  load() {
    this.loadCount += 1;
    this.currentSrc = this.src;
    this.readyState = 4;
    queueMicrotask(() => {
      this.dispatchEvent(new Event("loadedmetadata"));
      this.dispatchEvent(new Event("loadeddata"));
      this.dispatchEvent(new Event("canplay"));
    });
  }

  makeReady() {
    this.readyState = 4;
    this.dispatchEvent(new Event("loadedmetadata"));
    this.dispatchEvent(new Event("loadeddata"));
    this.dispatchEvent(new Event("canplay"));
  }

  holdNextPlay() {
    let release = () => undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.heldPlay = { promise, resolve: release };
    return release;
  }

  delayNextPauseEvent() {
    this.delayedPauseEvents += 1;
  }

  failNextPlays(count = 1) {
    this.playFailuresRemaining = Math.max(0, count);
  }

  flushDelayedPauseEvents() {
    while (this.delayedPauseEvents > 0) {
      this.delayedPauseEvents -= 1;
      this.dispatchEvent(new Event("pause"));
    }
  }

  emitNativePauseEvent() {
    this.dispatchEvent(new Event("pause"));
  }

  async play() {
    this.playCount += 1;
    if (this.playFailuresRemaining > 0) {
      this.playFailuresRemaining -= 1;
      this.paused = true;
      throw new Error("cold decoder did not start");
    }
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
    const held = this.heldPlay;
    this.heldPlay = null;
    if (held) await held.promise;
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    if (!this.delayedPauseEvents) this.dispatchEvent(new Event("pause"));
  }
}

function mediaPair() {
  return [new FakeVideo(), new FakeVideo()] as const;
}

test("retrying the same cold command reuses its assigned source and starts playback", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  // playPreparedDeck makes one native retry itself. Fail both attempts so the
  // durable React transport has to repeat the same command.
  decks[1].failNextPlays(2);

  const command = { authorityId: 41, key: "scene-1", src: "original.mp4", start: 0, end: 7.061, position: 0, play: true, intent: "manual" as const };
  const firstApplied = await controller.setSegment(command);
  const loadCountAfterColdFailure = decks[1].loadCount;
  const secondApplied = await controller.setSegment(command);

  assert.equal(firstApplied, false);
  assert.equal(secondApplied, true);
  assert.equal(decks[1].loadCount, loadCountAfterColdFailure, "a healthy assigned source must not be downloaded again");
  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  controller.destroy();
});

test("releasing a background controller detaches every object-storage source", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7, play: false, intent: "manual" });
  controller.preload("next.mp4", 0);
  await Promise.resolve();

  controller.release();

  assert.deepEqual(decks.map((deck) => deck.currentSrc), ["", ""]);
  assert.deepEqual(decks.map((deck) => deck.dataset.transportPhase), ["released", "released"]);
  controller.destroy();
});

test("an unfinished uploaded scene can be interrupted by any original segment", async () => {
  const decks = mediaPair();
  const active: Array<{ src: string; time: number }> = [];
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement], {
    onActiveDeck: (deck) => active.push({ src: deck.currentSrc, time: deck.currentTime }),
  });

  await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  controller.preload("uploaded.mp4", 0);
  await Promise.resolve();
  await controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });
  assert.equal(controller.activeSource, "uploaded.mp4");

  await controller.setSegment({ key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });
  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.ok(Math.abs(controller.activeDeck.currentTime - 7.061) < .001);
  assert.equal(decks.find((deck) => deck.currentSrc === "uploaded.mp4")?.paused, true);
  assert.deepEqual(active.at(-1), { src: "original.mp4", time: 7.061 });
  controller.destroy();
});

test("returning from an uploaded scene wakes an assigned source without reloading it", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);

  await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  await controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });

  const originalDeck = decks.find((deck) => deck.currentSrc === "original.mp4");
  assert.ok(originalDeck);
  const loadCountBeforeReturn = originalDeck.loadCount;
  originalDeck.pause();
  originalDeck.readyState = 1;
  originalDeck.currentTime = 0;
  await Promise.resolve();

  // The requested time already equals currentTime. play() must wake Chromium's
  // range loader without replacing src/load() and canceling the same request.
  const applied = await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });

  assert.equal(applied, true);
  assert.equal(originalDeck.loadCount, loadCountBeforeReturn);
  assert.equal(originalDeck.playCount, 2);
  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.ok(Math.abs(controller.activeDeck.currentTime) < .001);
  controller.destroy();
});

test("a provisional scene duration cannot leave a shorter uploaded file permanently armed", async () => {
  const decks = mediaPair();
  const ended: Array<{ intent: string; key: string }> = [];
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement], {
    onEnded: (intent, key) => ended.push({ intent, key }),
  });

  const pending = controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });
  await pending;
  const uploadedDeck = controller.activeDeck as unknown as FakeVideo;
  uploadedDeck.duration = 3.041667;
  uploadedDeck.currentTime = uploadedDeck.duration;
  uploadedDeck.ended = true;
  uploadedDeck.paused = true;
  uploadedDeck.dispatchEvent(new Event("ended"));

  assert.deepEqual(ended, [{ intent: "manual", key: "scene-3" }]);

  await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.ok(Math.abs(controller.activeDeck.currentTime) < .001);
  controller.destroy();
});

test("a source that previously ended cannot auto-advance a newly selected earlier segment", async () => {
  const decks = mediaPair();
  const endedIntents: string[] = [];
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement], {
    onEnded: (intent) => endedIntents.push(intent),
  });

  await controller.setSegment({ key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });
  const originalDeck = decks.find((deck) => deck.currentSrc === "original.mp4");
  assert.ok(originalDeck);
  originalDeck.currentTime = originalDeck.duration;
  originalDeck.ended = true;
  originalDeck.paused = true;

  await controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });
  await controller.setSegment({ key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });

  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.ok(Math.abs(controller.activeDeck.currentTime - 7.061) < .001);
  assert.deepEqual(endedIntents, []);
  controller.destroy();
});

test("segment completion reports the exact transport key that owned it", async () => {
  const decks = mediaPair();
  const ended: Array<{ intent: string; key: string }> = [];
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement], {
    onEnded: (intent, key) => ended.push({ intent, key }),
  });

  await controller.setSegment({ key: "scene-2-session", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });
  controller.activeDeck.currentTime = 13.025;
  controller.activeDeck.dispatchEvent(new Event("timeupdate"));

  assert.deepEqual(ended, [{ intent: "manual", key: "scene-2-session" }]);
  controller.destroy();
});

test("ended and timeupdate events cannot advance a scene while its play promise is still pending", async () => {
  const decks = mediaPair();
  const endedIntents: string[] = [];
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement], {
    onEnded: (intent) => endedIntents.push(intent),
  });

  await controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });
  const originalDeck = decks.find((deck) => deck.currentSrc !== "uploaded.mp4") || decks.find((deck) => deck.paused);
  assert.ok(originalDeck);
  const releasePlay = originalDeck.holdNextPlay();
  const pending = controller.setSegment({ key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });
  for (let tick = 0; tick < 8 && originalDeck.playCount === 0; tick += 1) await Promise.resolve();
  assert.equal(originalDeck.playCount, 1);

  // Chromium can deliver the old source-end events in this window. The new
  // editor command is not armed yet and must not auto-select Scene 03.
  originalDeck.currentTime = originalDeck.duration;
  originalDeck.ended = true;
  originalDeck.dispatchEvent(new Event("timeupdate"));
  originalDeck.dispatchEvent(new Event("ended"));
  assert.deepEqual(endedIntents, []);

  originalDeck.currentTime = 7.061;
  originalDeck.ended = false;
  releasePlay();
  await pending;
  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.deepEqual(endedIntents, []);
  controller.destroy();
});

test("a late play promise from scene 3 cannot stop or reclaim scene 2", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: false, intent: "manual" });
  controller.preload("uploaded.mp4", 0);
  await Promise.resolve();
  const uploadedDeck = decks.find((deck) => deck.currentSrc === "uploaded.mp4");
  assert.ok(uploadedDeck);
  const releaseScene3 = uploadedDeck.holdNextPlay();
  const staleScene3 = controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });
  await Promise.resolve();

  const scene2 = controller.setSegment({ key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });
  await scene2;
  releaseScene3();
  await staleScene3;

  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.ok(Math.abs(controller.activeDeck.currentTime - 7.061) < .001);
  assert.equal(uploadedDeck.paused, true);
  controller.destroy();
});

test("decoder ownership is reported with the exact external command that started it", async () => {
  const decks = mediaPair();
  const claims: Array<{ key: string; authorityId?: number }> = [];
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement], {
    onPlaybackOwner: (_deck, key, authorityId) => claims.push({ key, authorityId }),
  });

  await controller.setSegment({ authorityId: 41, key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  await controller.setSegment({ authorityId: 42, key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });

  assert.deepEqual(claims, [
    { key: "scene-1", authorityId: 41 },
    { key: "scene-2", authorityId: 42 },
  ]);
  controller.destroy();
});

test("an aborted play promise cannot pause a newer scene that reused the same deck", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  await controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });

  const originalDeck = decks.find((deck) => deck.currentSrc !== "uploaded.mp4") || decks.find((deck) => deck.paused);
  assert.ok(originalDeck);
  const releaseStalePlay = originalDeck.holdNextPlay();
  const staleScene2 = controller.setSegment({ key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });
  for (let tick = 0; tick < 8 && originalDeck.playCount === 0; tick += 1) await Promise.resolve();
  assert.equal(originalDeck.playCount, 1, "the interrupted command reached its pending play() promise");

  const currentScene1 = controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  await currentScene1;
  releaseStalePlay();
  await staleScene2;

  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.ok(Math.abs(controller.activeDeck.currentTime) < .001);
  controller.destroy();
});

test("a repeated pending scene request starts at its boundary instead of preserving a stale deck position", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  await controller.setSegment({ key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });
  const originalDeck = decks.find((deck) => deck.currentSrc === "original.mp4");
  assert.ok(originalDeck);
  originalDeck.currentTime = 13.024;
  await Promise.resolve();
  await controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });

  // Simulate production requesting metadata again after switching sources.
  // The first Scene 01 command remains pending and is replaced by an identical
  // click before it can become the active command.
  originalDeck.readyState = 0;
  const firstPendingScene1 = controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  await Promise.resolve();
  const repeatedScene1 = controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  await Promise.resolve();

  assert.equal(originalDeck.dataset.transportPreservedPosition, "false");
  assert.equal(originalDeck.dataset.transportRequestedPosition, "0.000000");
  originalDeck.makeReady();
  await repeatedScene1;
  await firstPendingScene1;

  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.ok(Math.abs(controller.activeDeck.currentTime) < .001);
  controller.destroy();
});

test("rapid arbitrary scene switching keeps only the last command active", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  const scenes = [
    { key: "scene-1", src: "original.mp4", start: 0, end: 7.061 },
    { key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025 },
    { key: "scene-3", src: "uploaded.mp4", start: 0, end: 5 },
  ];
  for (let index = 0; index < 100; index += 1) {
    const scene = scenes[index % scenes.length];
    await controller.setSegment({ ...scene, play: true, intent: "manual" });
    assert.equal(controller.activeSource, scene.src);
    assert.equal(controller.isPlaying, true);
    assert.ok(Math.abs(controller.activeDeck.currentTime - scene.start) < .001);
  }
  controller.destroy();
  assert.ok(decks[0].loadCount + decks[1].loadCount <= 68, "two decks reuse already loaded adjacent segments");
});

test("a delayed pause event from an old scene cannot mark the new scene paused", async () => {
  const decks = mediaPair();
  const playbackChanges: boolean[] = [];
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement], {
    onPlaybackChange: (playing) => playbackChanges.push(playing),
  });

  await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  const originalDeck = decks.find((deck) => deck.currentSrc === "original.mp4");
  assert.ok(originalDeck);
  originalDeck.delayNextPauseEvent();
  await controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });
  await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });

  originalDeck.flushDelayedPauseEvents();

  assert.equal(controller.activeSource, "original.mp4");
  assert.equal(controller.isPlaying, true);
  assert.equal(playbackChanges.at(-1), true);
  controller.destroy();
});

test("a native pause event still reports a genuinely paused active scene", async () => {
  const decks = mediaPair();
  const playbackChanges: boolean[] = [];
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement], {
    onPlaybackChange: (playing) => playbackChanges.push(playing),
  });

  await controller.setSegment({ key: "scene-1", src: "original.mp4", start: 0, end: 7.061, play: true, intent: "manual" });
  const originalDeck = decks.find((deck) => deck.currentSrc === "original.mp4");
  assert.ok(originalDeck);
  originalDeck.paused = true;
  originalDeck.emitNativePauseEvent();

  assert.equal(playbackChanges.at(-1), false);
  controller.destroy();
});

test("pausing and resuming the same scene preserves the editor playhead", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  const scene = { key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, intent: "manual" as const };

  await controller.setSegment({ ...scene, play: true });
  controller.activeDeck.currentTime = 9.375;
  await Promise.resolve();
  await controller.setSegment({ ...scene, play: false });
  assert.equal(controller.isPlaying, false);
  assert.ok(Math.abs(controller.activeDeck.currentTime - 9.375) < .001);

  await controller.setSegment({ ...scene, play: true });
  assert.equal(controller.isPlaying, true);
  assert.ok(Math.abs(controller.activeDeck.currentTime - 9.375) < .001);
  controller.destroy();
});

test("a scene command cannot carry another scene's absolute media time", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);

  await controller.setSegment({
    key: "scene-2",
    src: "original.mp4",
    start: 7.061,
    end: 13.025,
    position: .892,
    play: true,
    intent: "manual",
  });

  assert.equal(controller.activeDeck.dataset.segmentKey, "scene-2");
  assert.equal(controller.activeDeck.dataset.transportRequestedPosition, "7.061000");
  assert.ok(Math.abs(controller.activeDeck.currentTime - 7.061) < .001);
  assert.equal(controller.isPlaying, true);
  controller.destroy();
});

test("an unpositioned repeat cannot preserve the end boundary as a playable position", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  const scene = { key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, intent: "manual" as const };

  await controller.setSegment({ ...scene, play: true, position: scene.start });
  controller.activeDeck.currentTime = scene.end - .001;
  await Promise.resolve();
  await controller.setSegment({ ...scene, play: true });

  assert.equal(controller.activeDeck.dataset.transportPreservedPosition, "false");
  assert.equal(controller.activeDeck.dataset.transportRequestedPosition, "7.061000");
  assert.ok(Math.abs(controller.activeDeck.currentTime - scene.start) < .001);
  assert.equal(controller.isPlaying, true);
  controller.destroy();
});

test("the previous scene is hidden immediately while a different source prepares", async () => {
  const decks = mediaPair();
  const controller = new SegmentedVideoController(decks as unknown as [HTMLVideoElement, HTMLVideoElement]);
  await controller.setSegment({ key: "scene-3", src: "uploaded.mp4", start: 0, end: 5, play: true, intent: "manual" });
  const uploadedDeckIndex = decks.findIndex((deck) => deck.currentSrc === "uploaded.mp4");
  const originalDeck = decks[1 - uploadedDeckIndex];
  originalDeck.readyState = 0;
  originalDeck.load = function loadWithoutReadiness() {
    this.loadCount += 1;
    this.currentSrc = this.src;
  };

  const pending = controller.setSegment({ key: "scene-2", src: "original.mp4", start: 7.061, end: 13.025, play: true, intent: "manual" });
  await Promise.resolve();
  assert.equal(decks[0].dataset.activeDeck, "false");
  assert.equal(decks[1].dataset.activeDeck, "false");
  assert.equal(decks.find((deck) => deck.currentSrc === "uploaded.mp4")?.paused, true);
  controller.stop();
  await pending;
  controller.destroy();
});
