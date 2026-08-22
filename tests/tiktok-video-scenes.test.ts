import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVideoSceneBoundaries, restoreDetectedVideoSegments, videoSceneCutsMatch } from "../src/lib/video-scenes";
import type { VideoSceneSegment } from "../src/lib/types";

test("video scene boundaries remain contiguous and frame-precise", () => {
  const scenes = normalizeVideoSceneBoundaries([
    { time: 1.2374, score: 0.82 },
    { time: 3.9128, score: 0.74 },
    { time: 7.0004, score: 0.91 },
  ], 10.25);
  assert.deepEqual(scenes.map(({ start, end }) => [start, end]), [
    [0, 1.2374],
    [1.2374, 3.9128],
    [3.9128, 7.0004],
    [7.0004, 10.25],
  ]);
});

test("the strongest cut keeps its exact decoded frame number", () => {
  const scenes = normalizeVideoSceneBoundaries([
    { frame: 210, time: 7.0001, score: 0.42 },
    { frame: 211, time: 7.033433, score: 0.91 },
  ], 13.025);

  assert.equal(scenes[1].start, 7.033433);
  assert.equal(scenes[1].frame, 211);
});

test("nearby transition noise collapses to the strongest cut", () => {
  const scenes = normalizeVideoSceneBoundaries([
    { time: 2, score: 0.21 },
    { time: 2.08, score: 0.88 },
    { time: 5, score: 0.65 },
  ], 8, { minimumGapSeconds: 0.16 });
  assert.deepEqual(scenes.map((scene) => scene.start), [0, 2.08, 5]);
  assert.equal(scenes[1].confidence, 0.88);
});

test("scene limit keeps the strongest transitions in chronological order", () => {
  const scenes = normalizeVideoSceneBoundaries([
    { time: 1, score: 0.2 },
    { time: 2, score: 0.9 },
    { time: 3, score: 0.5 },
    { time: 4, score: 0.8 },
  ], 5, { maximumScenes: 3 });
  assert.deepEqual(scenes.map((scene) => scene.start), [0, 2, 4]);
});

test("continuous subject motion does not become extra scenes", () => {
  const scenes = normalizeVideoSceneBoundaries([
    { time: 1.967, score: 0.128142 },
    { time: 4.033, score: 0.192339 },
    { time: 5.333, score: 0.115235 },
    { time: 7.067, score: 0.493286 },
    { time: 7.633, score: 0.166139 },
    { time: 9.967, score: 0.143671 },
  ], 13.025);

  assert.deepEqual(scenes.map(({ start, end }) => [start, end]), [
    [0, 7.067],
    [7.067, 13.025],
  ]);
});

test("scene noise in the opening and closing frames is absorbed", () => {
  const scenes = normalizeVideoSceneBoundaries([
    { time: 0.033, score: 0.92 },
    { time: 4.2, score: 0.81 },
    { time: 9.94, score: 0.89 },
  ], 10, { minimumGapSeconds: 0.16 });

  assert.deepEqual(scenes.map(({ start, end }) => [start, end]), [
    [0, 4.2],
    [4.2, 10],
  ]);
});

test("the immutable import baseline restores moved scene boundaries", () => {
  const detected: VideoSceneSegment[] = [
    { id: "scene-a", index: 1, sequenceIndex: 0, label: "Scene 01", role: "hook", start: 0, end: 7.061, confidence: 1, thumbnailAssetId: "asset-a", thumbnailTime: 0 },
    { id: "scene-b", index: 2, sequenceIndex: 1, label: "Scene 02", role: "cta", start: 7.061, end: 13.025, confidence: .8, thumbnailAssetId: "asset-b", thumbnailTime: 7.061 },
  ];
  const edited = [
    { ...detected[0], end: 6.796 },
    { ...detected[1], start: 6.796 },
  ];
  const restored = restoreDetectedVideoSegments(edited, 13.025, detected);
  assert.deepEqual(restored.map(({ id, start, end }) => ({ id, start, end })), [
    { id: "scene-a", start: 0, end: 7.061 },
    { id: "scene-b", start: 7.061, end: 13.025 },
  ]);
  assert.equal(videoSceneCutsMatch(edited, restored), false);
  assert.equal(videoSceneCutsMatch(restored, restored), true);
});

test("legacy TikTok scenes recover their detected cuts and discard user splits", () => {
  const edited: VideoSceneSegment[] = [
    { id: "video-scene-asset-a", index: 1, sequenceIndex: 0, label: "Scene 01", role: "hook", start: 0, end: 4, confidence: 1, thumbnailAssetId: "asset-a", thumbnailTime: 0 },
    { id: "video-scene-user-split", index: 2, sequenceIndex: 1, label: "Scene 02", role: "scene", start: 4, end: 6.5, confidence: 1, thumbnailAssetId: "asset-a", thumbnailTime: 4 },
    { id: "video-scene-asset-b", index: 3, sequenceIndex: 2, label: "Scene 03", role: "cta", start: 6.5, end: 13.025, confidence: .8, thumbnailAssetId: "asset-b", thumbnailTime: 7.061 },
  ];
  const restored = restoreDetectedVideoSegments(edited, 13.025);
  assert.deepEqual(restored.map(({ id, start, end, label }) => ({ id, start, end, label })), [
    { id: "video-scene-asset-a", start: 0, end: 7.061, label: "Scene 01" },
    { id: "video-scene-asset-b", start: 7.061, end: 13.025, label: "Scene 02" },
  ]);
});
