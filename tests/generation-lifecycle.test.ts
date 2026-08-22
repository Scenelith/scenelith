import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generationTimedOut,
  generationTimeoutMessage,
  generationTimeoutMs,
  isGenerationTimeoutError,
  publicGenerationErrorMessage,
} from "../src/lib/generation-lifecycle";

test("generation timeout windows are media-specific", () => {
  assert.equal(generationTimeoutMs("image"), 5 * 60 * 1000);
  assert.equal(generationTimeoutMs("video"), 45 * 60 * 1000);
});

test("image timeout starts at five minutes without firing early", () => {
  const now = Date.parse("2026-08-04T16:00:00.000Z");
  assert.equal(generationTimedOut("2026-08-04T15:55:00.001Z", "image", now), false);
  assert.equal(generationTimedOut("2026-08-04T15:55:00.000Z", "image", now), true);
});

test("video timeout starts at forty-five minutes", () => {
  const now = Date.parse("2026-08-04T16:00:00.000Z");
  assert.equal(generationTimedOut("2026-08-04T15:15:00.001Z", "video", now), false);
  assert.equal(generationTimedOut("2026-08-04T15:15:00.000Z", "video", now), true);
});

test("timeout failures can be recognized for late callback protection", () => {
  const message = generationTimeoutMessage("image");
  assert.equal(isGenerationTimeoutError(message), true);
  assert.doesNotMatch(message, /Kie|provider/i);
  assert.equal(isGenerationTimeoutError("Kie.ai did not finish this image within 5 minutes. Credits were returned; run the node again."), true);
  assert.equal(isGenerationTimeoutError("Provider failed"), false);
});

test("generation errors never expose the infrastructure provider", () => {
  assert.equal(publicGenerationErrorMessage("Kie.ai provider rejected the task"), "Generation service rejected the task");
});
