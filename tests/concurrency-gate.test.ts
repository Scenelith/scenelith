import test from "node:test";
import assert from "node:assert/strict";
import { concurrencyGate } from "../src/lib/concurrency-gate";

test("concurrency gate never runs more than the configured number of jobs", async () => {
  const run = concurrencyGate(`test-${crypto.randomUUID()}`, 2);
  let active = 0;
  let peak = 0;
  const order: number[] = [];

  await Promise.all(Array.from({ length: 7 }, (_, index) => run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    order.push(index);
    active -= 1;
  })));

  assert.equal(peak, 2);
  assert.equal(order.length, 7);
});

test("concurrency gate releases a slot after a failed job", async () => {
  const run = concurrencyGate(`test-${crypto.randomUUID()}`, 1);
  await assert.rejects(run(async () => { throw new Error("expected"); }));
  assert.equal(await run(async () => "next"), "next");
});
