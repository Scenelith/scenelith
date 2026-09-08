import assert from "node:assert/strict";
import test from "node:test";
import { generationAttemptTime, restoreGeneratorTask } from "../src/lib/generator-task-state";
import type { BackgroundTaskRecord, FrameNode } from "../src/lib/types";
const node: FrameNode = { id: "image", position: { x: 0, y: 0 }, data: { kind: "prompt", title: "Image", status: "ready", generatedAt: "2026-09-08 10:13:49.678+00", outputUrl: "/new.png", generatedOutputs: [{ url: "/old.png", mediaType: "image" }, { url: "/new.png", mediaType: "image" }] } };
const task: BackgroundTaskRecord = { id: "old", kind: "generation", projectId: "p", projectName: "P", nodeId: "image", title: "Image", status: "failed", stageLabel: "Failed", progress: 100, createdAt: "2026-09-08T10:08:13.875Z", updatedAt: "2026-09-08T10:25:19.824Z", error: "Old error" };
test("late failed/running/queued task cannot replace a newer completed image", () => {
  for (const status of ["failed", "running", "queued"] as const) assert.equal(restoreGeneratorTask(node, { ...task, status }), node);
  assert.equal(generationAttemptTime(node.data.generatedAt), Date.parse("2026-09-08T10:13:49.678Z"));
});
test("a new attempt clears the old error and its failure remains visible", () => {
  const failed = { ...node, data: { ...node.data, status: "failed" as const, generationError: "Old error" } };
  const fresh = { ...task, id: "new", createdAt: "2026-09-08T10:30:00Z", status: "queued" as const };
  const queued = restoreGeneratorTask(failed, fresh);
  assert.equal(queued.data.status, "queued"); assert.equal(queued.data.generationError, undefined);
  const stopped = restoreGeneratorTask(queued, { ...fresh, status: "failed", error: "New error" });
  assert.equal(stopped.data.status, "failed"); assert.equal(stopped.data.generationError, "New error");
  assert.equal(restoreGeneratorTask(stopped, { ...task, status: "completed", outputUrl: "/new.png", createdAt: "2026-09-08T10:13:49.678Z" }), stopped);
});
test("known successful attempt heals stale failure without changing selected variation", () => {
  const failed = { ...node, data: { ...node.data, outputUrl: "/old.png", activeGeneratedOutputIndex: 0, status: "failed" as const, generationError: "Stale" } };
  const completed = { ...task, status: "completed" as const, outputUrl: "/new.png", createdAt: "2026-09-08T10:13:49.678Z" };
  const healed = restoreGeneratorTask(failed, completed);
  assert.equal(healed.data.status, "ready"); assert.equal(healed.data.generationError, undefined);
  assert.equal(healed.data.outputUrl, "/old.png"); assert.equal(healed.data.activeGeneratedOutputIndex, 0);
  assert.equal(healed.data.generatedOutputs, failed.data.generatedOutputs);
  assert.equal(restoreGeneratorTask(healed, completed), healed);
});
test("completion uses attempt creation time, and old completion polls never change selection", () => {
  const fresh = { ...task, id: "next", status: "completed" as const, createdAt: "2026-09-08T10:30:00Z", updatedAt: "2026-09-08T10:32:00Z", outputUrl: "/next.png" };
  const ready = restoreGeneratorTask(node, fresh);
  assert.equal(ready.data.generatedAt, fresh.createdAt); assert.equal(ready.data.outputUrl, "/next.png");
  assert.equal(restoreGeneratorTask(ready, { ...task, status: "completed", outputUrl: "/old.png" }), ready);
});
