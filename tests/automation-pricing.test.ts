import assert from "node:assert/strict";
import { test } from "node:test";
import { tiktokPlanningReserveCredits } from "@/lib/automation-pricing";

test("automation planning reserves scale with OpenRouter model prices", () => {
  assert.equal(tiktokPlanningReserveCredits(2), 32);
  assert.equal(tiktokPlanningReserveCredits(5), 56);
  assert.equal(tiktokPlanningReserveCredits(5, "openai/gpt-5.6-luna-pro"), 17);
  assert.throws(()=>tiktokPlanningReserveCredits(2, "qwen/qwen3.8-max"), /not available/);
});
