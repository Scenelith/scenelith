import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreVideoMasterTask } from "../src/lib/video-master-task-state";
import type { BackgroundTaskRecord, FrameNode } from "../src/lib/types";

const node: FrameNode = { id: "master", type: "frameNode", position: { x: 0, y: 0 }, data: {
  kind: "videoMaster", title: "Master", status: "ready", videoMasterSelectedClipId: "a",
  videoMasterClips: ["a", "b"].map((id) => ({ id, title: id, role: "scene", origin: "generated", duration: 6,
    prompt: "Turn", outputUrl: `/old-${id}.mp4`, generatedOutputs: [{ url: `/old-${id}.mp4`, modelId: "grok-video-1-5" }] })),
} };
const task: BackgroundTaskRecord = { id: "new-run", kind: "generation", projectId: "canvas", projectName: "Canvas", nodeId: "master",
  targetClipId: "a", title: "Video generation", status: "running", stageLabel: "Generating video", progress: 30,
  createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:05Z" };

test("MCP task restores the animation target with existing variations and no foreground launch", () => {
  const restored = restoreVideoMasterTask(node, task);
  assert.equal(restored.data.status, "working");
  assert.equal(restored.data.videoMasterGeneratingClipId, "a");
  assert.equal(restored.data.videoMasterClips, node.data.videoMasterClips);
  assert.equal(restoreVideoMasterTask(restored, task), restored);
});

test("queued task targets its actual scene independently of the selected scene", () => {
  const restored = restoreVideoMasterTask(node, { ...task, targetClipId: "b", status: "queued" });
  assert.equal(restored.data.videoMasterGeneratingClipId, "b");
  assert.equal(restored.data.videoMasterSelectedClipId, "a");
  assert.equal(restored.data.status, "queued");
  assert.equal(restored.data.queueReason, "provider");
});

test("completed task history cannot clear a new run or write scene outputs onto the Master node", () => {
  const active = restoreVideoMasterTask(node, task);
  assert.equal(restoreVideoMasterTask(active, { ...task, id: "old-run", status: "completed", outputUrl: "/old-a.mp4" }), active);
  assert.equal(active.data.outputUrl, undefined);
});

test("failed tasks stop the animation and missing scenes do not invent a target", () => {
  const failed = restoreVideoMasterTask(node, { ...task, status: "failed", error: "Stopped" });
  assert.equal(failed.data.status, "failed");
  assert.equal(failed.data.generationError, "Stopped");
  assert.equal(restoreVideoMasterTask(node, { ...task, targetClipId: "deleted" }), node);
});

test("an older in-flight task response cannot restart animation after completion", () => {
  const completed = { ...node, data: { ...node.data, generatedAt: task.createdAt } };
  assert.equal(restoreVideoMasterTask(completed, task), completed);
});
