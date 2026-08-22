import assert from "node:assert/strict";
import { test } from "node:test";
import { settleWithConcurrency } from "@/lib/generation-queue";

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
