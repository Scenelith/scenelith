import assert from "node:assert/strict";
import { test } from "node:test";
import { KIE_GENERATION_INTERVAL_MS, plannedKieStartAt } from "../src/lib/kie-rate-limit";

test("Kie generation starts stay below 20 requests in every 10 second window", () => {
  const starts = [0];
  for (let index = 1; index < 100; index += 1) {
    starts.push(plannedKieStartAt(starts[index - 1], 0));
  }
  assert.equal(KIE_GENERATION_INTERVAL_MS, 520);
  for (let index = 0; index < starts.length; index += 1) {
    const inWindow = starts.filter((start) => start >= starts[index] && start < starts[index] + 10_000);
    assert.ok(inWindow.length <= 20);
  }
});

test("idle time is not followed by an unnecessary provider delay", () => {
  assert.equal(plannedKieStartAt(1_000, 5_000), 5_000);
});
