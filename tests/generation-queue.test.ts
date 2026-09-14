import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationCapacityQueue, canRestoreForegroundTask, settleWithConcurrency } from "@/lib/generation-queue";

test("generation batches obey instance concurrency", async () => {
  let active = 0;
  let peak = 0;
  const results = await settleWithConcurrency([0, 1, 2, 3, 4], 2, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  assert.equal(peak, 2);
  assert.equal(results.every((result) => result.status === "fulfilled"), true);
});

test("one failed generation does not stop the rest of the queue", async () => {
  const completed: number[] = [];
  const results = await settleWithConcurrency([0, 1, 2], 1, async (item) => {
    if (item === 1) throw new Error("provider failed");
    completed.push(item);
  });
  assert.deepEqual(completed, [0, 2]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
});

test("separate launches and batches share capacity until their jobs finish", async () => {
  const queue = new GenerationCapacityQueue();
  const signal = new AbortController().signal;
  const first = await queue.acquire(2, signal);
  const second = await queue.acquire(2, signal);
  let thirdStarted = false;
  let fourthStarted = false;
  const third = queue.acquire(2, signal).then((release) => { thirdStarted = true; return release; });
  const fourth = queue.acquire(2, signal).then((release) => { fourthStarted = true; return release; });
  await Promise.resolve();
  assert.equal(thirdStarted, false);
  assert.equal(fourthStarted, false);
  first();
  const releaseThird = await third;
  assert.equal(fourthStarted, false, "finishing one node cannot start or clear all other nodes");
  first(); // A duplicate cleanup must not release someone else's capacity.
  await Promise.resolve();
  assert.equal(fourthStarted, false);
  second();
  const releaseFourth = await fourth;
  releaseThird(); releaseFourth();
});

test("cancelled queued nodes never acquire a released slot", async () => {
  const queue = new GenerationCapacityQueue();
  const controller = new AbortController();
  const first = await queue.acquire(1, new AbortController().signal);
  const cancelled = queue.acquire(1, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  first();
  const next = await queue.acquire(1, new AbortController().signal);
  next();
});

test("old background results cannot reset an unaccepted attempt; accepted tasks still recover", () => {
  const attempts = new Map<string, string | null>([["waiting", null], ["running", "new"]]);
  assert.equal(canRestoreForegroundTask({ nodeId: "waiting", id: "old-success" }, attempts), false);
  assert.equal(canRestoreForegroundTask({ nodeId: "running", id: "old-failure" }, attempts), false);
  assert.equal(canRestoreForegroundTask({ nodeId: "running", id: "new" }, attempts), true);
  assert.equal(canRestoreForegroundTask({ nodeId: "background", id: "recovered" }, attempts), true);
});
