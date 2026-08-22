import assert from "node:assert/strict";
import test from "node:test";
import { shouldAttachVideoTransport, VideoPlaybackManager } from "../src/lib/video-playback-owner";

function fakeMedia() {
  return {
    paused: false,
    pauseCalls: 0,
    pause() {
      this.paused = true;
      this.pauseCalls += 1;
    },
  } as unknown as HTMLMediaElement & { pauseCalls: number };
}

test("the latest foreground command is the only command allowed to claim playback", () => {
  const manager = new VideoPlaybackManager();
  const first = fakeMedia();
  const third = fakeMedia();
  manager.register("master", first);
  manager.register("master", third);

  const oldCommand = manager.play("master", "scene-3");
  const currentCommand = manager.play("master", "scene-1");

  assert.equal(manager.claim("master", "scene-3", oldCommand.id, third), false);
  assert.equal(third.pauseCalls, 1);
  assert.equal(manager.claim("master", "scene-1", currentCommand.id, first), true);
});

test("a new node command synchronously pauses every previous foreground decoder", () => {
  const manager = new VideoPlaybackManager();
  const source = fakeMedia();
  const master = fakeMedia();
  manager.register("source", source);
  manager.register("master", master);

  const sourceCommand = manager.play("source", "scene-1");
  assert.equal(manager.claim("source", "scene-1", sourceCommand.id, source), true);
  source.paused = false;

  manager.play("master", "clip-3");
  assert.equal(source.paused, true);
  assert.ok(source.pauseCalls >= 1);
});

test("a stale component cannot overwrite the current owner while it unmounts", () => {
  const manager = new VideoPlaybackManager();
  manager.play("source", "scene-2");
  const masterCommand = manager.play("master", "clip-1");

  manager.stop("source");

  assert.equal(manager.getSnapshot().id, masterCommand.id);
  assert.equal(manager.getSnapshot().ownerId, "master");
  assert.equal(manager.getSnapshot().targetKey, "clip-1");
  assert.equal(manager.getSnapshot().action, "play");
});

test("each editor remembers its last live target while another node owns playback", () => {
  const manager = new VideoPlaybackManager();
  manager.play("master", "clip-1:original", { relativeTime: 1.25 });

  manager.play("source", "scene-2");

  assert.deepEqual(manager.getLastTarget("master"), {
    targetKey: "clip-1:original",
    relativeTime: 1.25,
  });
  assert.equal(manager.getSnapshot().ownerId, "source");
});

test("only an explicit contiguous handoff carries decoder continuity", () => {
  const manager = new VideoPlaybackManager();

  const contiguous = manager.play("master", "clip-2:original", { relativeTime: 0, continuous: true });
  assert.equal(contiguous.continuous, true);

  const manual = manager.play("master", "clip-1:original", { relativeTime: 0 });
  assert.equal(manual.continuous, undefined);
});

test("a repeated explicit click supersedes a failed cold scene command", () => {
  const manager = new VideoPlaybackManager();
  const first = manager.play("master", "clip-2:original", { relativeTime: 0 });
  const repeated = manager.play("master", "clip-2:original", { relativeTime: 0 });

  assert.ok(repeated.id > first.id);
  assert.equal(manager.isCurrent("master", "clip-2:original", first.id), false);
  assert.equal(manager.isCurrent("master", "clip-2:original", repeated.id), true);
});

test("transport progress is authoritative and rejects reports from an inactive node", () => {
  const manager = new VideoPlaybackManager();
  manager.play("master", "clip-1:original", { relativeTime: 0 });
  manager.reportProgress("master", "clip-1:original", { relativeTime: 1.5, duration: 7.1, playing: true });

  assert.equal(manager.getProgressSnapshot("master").relativeTime, 1.5);
  assert.equal(manager.getProgressSnapshot("master").playing, true);

  manager.play("source", "scene-2");
  manager.reportProgress("master", "clip-1:original", { relativeTime: 6.9, playing: true });

  assert.equal(manager.getProgressSnapshot("master").relativeTime, 1.5);
  assert.equal(manager.getProgressSnapshot("master").playing, false);
});

test("pause keeps the current playhead and changes only transport state", () => {
  const manager = new VideoPlaybackManager();
  manager.play("master", "clip-2:original");
  manager.reportProgress("master", "clip-2:original", { relativeTime: 2.25, duration: 6, playing: true });

  manager.pause("master", "clip-2:original");

  assert.deepEqual(manager.getProgressSnapshot("master"), {
    ownerId: "master",
    targetKey: "clip-2:original",
    relativeTime: 2.25,
    duration: 6,
    playing: false,
    revision: 3,
  });
});

test("pause invalidates late play claims for the same scene", () => {
  const manager = new VideoPlaybackManager();
  const media = fakeMedia();
  manager.register("master", media);
  const play = manager.play("master", "clip-2");
  manager.pause("master", "clip-2");

  assert.equal(manager.claim("master", "clip-2", play.id, media), false);
  assert.equal(manager.getSnapshot().action, "pause");
});

test("completion invalidates late play without issuing a transport pause or seek", () => {
  const manager = new VideoPlaybackManager();
  const media = fakeMedia();
  manager.register("master", media);
  const play = manager.play("master", "clip-3");

  const complete = manager.complete("master", "clip-3");

  assert.equal(complete.action, "complete");
  assert.equal(media.pauseCalls, 0);
  assert.equal(manager.claim("master", "clip-3", play.id, media), false);
});

test("stop all invalidates every owner and pauses every registered decoder", () => {
  const manager = new VideoPlaybackManager();
  const one = fakeMedia();
  const two = fakeMedia();
  manager.register("source", one);
  manager.register("master", two);
  manager.play("master", "clip-3");
  one.paused = false;
  two.paused = false;

  manager.stopAll();

  assert.equal(manager.getSnapshot().ownerId, null);
  assert.equal(manager.getSnapshot().action, "stop");
  assert.equal(one.paused, true);
  assert.equal(two.paused, true);
});

test("only the selected node or the foreground owner may attach a media transport", () => {
  const manager = new VideoPlaybackManager();
  assert.equal(shouldAttachVideoTransport({ selected: true, ownerId: "source", command: manager.getSnapshot() }), true);
  assert.equal(shouldAttachVideoTransport({ selected: false, ownerId: "master", command: manager.getSnapshot() }), false);

  const foreground = manager.play("master", "scene-1");
  assert.equal(shouldAttachVideoTransport({ selected: true, ownerId: "source", command: foreground }), false);
  assert.equal(shouldAttachVideoTransport({ selected: false, ownerId: "master", command: foreground }), true);
});
