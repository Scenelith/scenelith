import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentVideoPlaybackSession, resolvePendingSeek, resolveVideoPlaybackIntent, resolveVideoPlaybackToggle, setVideoPlaybackTime, shouldApplyVideoPlaybackRequest, shouldPreserveContinuousPlayback, videoPlaybackReplayTime, videoSegmentReplayTime } from "../src/lib/video-playback";

test("a cold imported decoder cannot abort the timeline click before Play", () => {
  const cold = { readyState: 0, currentTime: 0 };
  assert.equal(setVideoPlaybackTime(cold, 7.067), false);
  assert.equal(cold.currentTime, 0);

  const loaded = { readyState: 2, currentTime: 0 };
  assert.equal(setVideoPlaybackTime(loaded, 7.067), true);
  assert.equal(loaded.currentTime, 7.067);

  const throwing = { readyState: 2, get currentTime() { return 0; }, set currentTime(_value: number) { throw new Error("decoder reset"); } };
  assert.equal(setVideoPlaybackTime(throwing, 7.067), false);
});

test("late media events cannot mutate the newly selected scene", () => {
  assert.equal(isCurrentVideoPlaybackSession({
    sessionKey: "scene-03|upload.mp4|0|5",
    desiredSessionKey: "scene-01|source.mp4|0|7.061",
    configuredSessionKey: "scene-01|source.mp4|0|7.061",
    currentSource: "https://app.test/upload.mp4",
    expectedSource: "https://app.test/source.mp4",
  }), false);
  assert.equal(isCurrentVideoPlaybackSession({
    sessionKey: "scene-01|source.mp4|0|7.061",
    desiredSessionKey: "scene-01|source.mp4|0|7.061",
    configuredSessionKey: "scene-01|source.mp4|0|7.061",
    currentSource: "https://app.test/source.mp4",
    expectedSource: "https://app.test/source.mp4",
  }), true);
});

test("events from another segment of the same source are still obsolete", () => {
  assert.equal(isCurrentVideoPlaybackSession({
    sessionKey: "scene-01|source.mp4|0|7.061",
    desiredSessionKey: "scene-02|source.mp4|7.061|13.025",
    configuredSessionKey: "scene-02|source.mp4|7.061|13.025",
    currentSource: "https://app.test/source.mp4",
    expectedSource: "https://app.test/source.mp4",
  }), false);
});

test("a playback command can only be consumed by its target media session", () => {
  assert.equal(shouldApplyVideoPlaybackRequest({ requestToken: 4, handledToken: 3, targetKey: "scene-02:original", currentKey: "scene-01:original" }), false);
  assert.equal(shouldApplyVideoPlaybackRequest({ requestToken: 4, handledToken: 3, targetKey: "scene-02:original", currentKey: "scene-02:original" }), true);
  assert.equal(shouldApplyVideoPlaybackRequest({ requestToken: 4, handledToken: 4, targetKey: "scene-02:original", currentKey: "scene-02:original" }), false);
});

test("manual playback remains authoritative during source and readiness changes", () => {
  assert.equal(resolveVideoPlaybackIntent({ manualRequested: true, autoPlay: false, hovered: false, hoverSuppressed: false }), "manual");
  assert.equal(resolveVideoPlaybackIntent({ manualRequested: false, autoPlay: true, hovered: false, hoverSuppressed: false }), "manual");
});

test("hover playback starts without a scene-selection side effect", () => {
  assert.equal(resolveVideoPlaybackIntent({ manualRequested: false, autoPlay: false, hovered: true, hoverSuppressed: false }), "hover");
  assert.equal(resolveVideoPlaybackIntent({ manualRequested: false, autoPlay: false, hovered: false, hoverSuppressed: false }), null);
});

test("an explicit pause suppresses hover until the pointer leaves", () => {
  assert.equal(resolveVideoPlaybackIntent({ manualRequested: false, autoPlay: false, hovered: true, hoverSuppressed: true }), null);
  assert.equal(resolveVideoPlaybackIntent({ manualRequested: false, autoPlay: false, hovered: false, hoverSuppressed: false }), null);
});

test("hover autoplay preserves one continuous stream across adjacent scenes", () => {
  assert.equal(shouldPreserveContinuousPlayback({
    sourceUnchanged: true,
    intent: "hover",
    paused: false,
    currentTime: 8,
    clipStart: 8,
    clipEnd: 14,
  }), true);
});

test("a source change or stopped intent requires a fresh media start", () => {
  assert.equal(shouldPreserveContinuousPlayback({ sourceUnchanged: false, intent: "hover", paused: false, currentTime: 8, clipStart: 8, clipEnd: 14 }), false);
  assert.equal(shouldPreserveContinuousPlayback({ sourceUnchanged: true, intent: null, paused: false, currentTime: 8, clipStart: 8, clipEnd: 14 }), false);
});

test("a no-op seek settles immediately instead of freezing playback progress", () => {
  assert.equal(resolvePendingSeek({ pendingTime: 7.061, currentTime: 7.061, seeking: false }), "settled");
  assert.equal(resolvePendingSeek({ pendingTime: 7.061, currentTime: 7.061, seeking: true }), "waiting");
});

test("an unfinished seek waits for the browser or retries the exact target", () => {
  assert.equal(resolvePendingSeek({ pendingTime: 7.061, currentTime: 0, seeking: true }), "waiting");
  assert.equal(resolvePendingSeek({ pendingTime: 7.061, currentTime: 0, seeking: false }), "retry");
  assert.equal(resolvePendingSeek({ pendingTime: null, currentTime: 2, seeking: false }), "idle");
});

test("a click pauses any playing video and restarts a paused video", () => {
  assert.equal(resolveVideoPlaybackToggle({ paused: true, manualRequested: false }), "start");
  assert.equal(resolveVideoPlaybackToggle({ paused: false, manualRequested: false }), "pause");
  assert.equal(resolveVideoPlaybackToggle({ paused: false, manualRequested: true }), "pause");
});

test("a completed clip replays from zero while a paused clip resumes", () => {
  assert.equal(videoPlaybackReplayTime(3, 3), 0);
  assert.equal(videoPlaybackReplayTime(2.97, 3), 0);
  assert.equal(videoPlaybackReplayTime(1.42, 3), 1.42);
});

test("a completed source scene replays from its own boundary instead of the full-video end", () => {
  assert.equal(videoSegmentReplayTime(13.025, 7.067, 13.025), 7.067);
  assert.equal(videoSegmentReplayTime(8.42, 7.067, 13.025), 8.42);
  assert.equal(videoSegmentReplayTime(2, 7.067, 13.025), 7.067);
});
