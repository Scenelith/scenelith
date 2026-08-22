import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantModelCreditDescription, DEFAULT_ASSISTANT_MODEL_ID, getAssistantModel } from "@/lib/assistant-models";
import { assistantRequestReserveCredits, providerCostToUsageUnits } from "@/lib/automation-pricing";

test("self-hosted assistant models use the operator provider account", () => {
  assert.equal(assistantRequestReserveCredits({ modelId: DEFAULT_ASSISTANT_MODEL_ID, inputCharacters: 20_000, imageCount: 14 }), 0);
  assert.equal(assistantRequestReserveCredits({ modelId: "openai/gpt-5.6-sol-pro", inputCharacters: 20_000, imageCount: 14 }), 0);
  assert.equal(assistantModelCreditDescription(getAssistantModel("openai/gpt-5.6-sol-pro")), "Provider-billed");
});

test("provider cost is normalized into neutral public usage units", () => {
  assert.equal(providerCostToUsageUnits(0.050089), 6);
  assert.equal(providerCostToUsageUnits(0.05), 5);
  assert.equal(providerCostToUsageUnits(1), 100);
  assert.equal(providerCostToUsageUnits(0), 0);
});
