import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantModels, DEFAULT_ASSISTANT_MODEL_ID, getAssistantModel, getTikTokAutomationPlanningModel, tiktokAutomationPlanningModels } from "../src/lib/assistant-models";

test("assistant catalogue exposes the exact requested OpenRouter slugs", () => {
  assert.deepEqual(assistantModels.map((model) => model.id), [
    "google/gemini-3.7-flash",
    "qwen/qwen3.8-max",
    "qwen/qwen3.7-flash",
    "google/gemini-3.6-flash",
    "moonshotai/kimi-k3",
    "openai/gpt-5.6-luna-pro",
    "openai/gpt-5.6-terra-pro",
    "openai/gpt-5.6-sol-pro",
    "x-ai/grok-4.5",
    "anthropic/claude-sonnet-5",
    "z-ai/glm-5.2",
  ]);
});

test("text-only GLM is excluded from visual planning capability", () => {
  assert.equal(getAssistantModel("z-ai/glm-5.2").supportsVision, false);
  assert.equal(getAssistantModel("qwen/qwen3.8-max").supportsVision, true);
  assert.equal(getAssistantModel("qwen/qwen3.7-flash").supportsVision, true);
  assert.equal(getAssistantModel("google/gemini-3.7-flash").supportsVision, true);
});

test("TikTok automation exposes only Gemini 3 planning models", () => {
  assert.deepEqual(tiktokAutomationPlanningModels.map((model) => model.id), [
    "google/gemini-3.7-flash",
    "google/gemini-3.6-flash",
  ]);
  assert.equal(getTikTokAutomationPlanningModel("google/gemini-3.7-flash").label, "Gemini 3.7 Flash");
  assert.throws(() => getTikTokAutomationPlanningModel("qwen/qwen3.8-max"), /not available/);
});

test("saved legacy Gemini selections migrate to Gemini 3.7", () => {
  assert.equal(getAssistantModel("google/gemini-3.1-flash-lite").id, DEFAULT_ASSISTANT_MODEL_ID);
  assert.equal(getAssistantModel("google/gemini-3.1-flash-lite-preview").id, DEFAULT_ASSISTANT_MODEL_ID);
  assert.equal(getAssistantModel("google/gemini-3.5-flash-lite").id, DEFAULT_ASSISTANT_MODEL_ID);
  assert.equal(getAssistantModel("google/gemini-3.5-flash-lite-preview").id, DEFAULT_ASSISTANT_MODEL_ID);
  assert.equal(getTikTokAutomationPlanningModel("google/gemini-3.1-flash-lite").id, DEFAULT_ASSISTANT_MODEL_ID);
  assert.equal(assistantModels.some((model) => String(model.id).includes("gemini-3.1")), false);
  assert.equal(assistantModels.some((model) => String(model.id).includes("gemini-3.5")), false);
});
