import assert from "node:assert/strict";
import { test } from "node:test";
import { tiktokPlanningReserveCredits } from "@/lib/automation-pricing";

test("automation planning reserves scale with OpenRouter model prices", () => {
  assert.equal(tiktokPlanningReserveCredits(2), 16);
  assert.equal(tiktokPlanningReserveCredits(5), 28);
  assert.equal(tiktokPlanningReserveCredits(5, "openai/gpt-5.6-luna-pro"), 9);
  assert.equal(tiktokPlanningReserveCredits(2, "qwen/qwen3.8-max"), 64);
});
