import assert from "node:assert/strict";
import { test } from "node:test";
import { generationCreditCost } from "../src/lib/generation-pricing";

test("image credits mirror the current Kie pricing table", () => {
  assert.equal(generationCreditCost("nano-banana-2-lite", "1K", "5"), 4);
  assert.equal(generationCreditCost("nano-banana-2", "1K", "5"), 8);
  assert.equal(generationCreditCost("nano-banana-2", "2K", "5"), 12);
  assert.equal(generationCreditCost("nano-banana-2", "4K", "5"), 18);
  assert.equal(generationCreditCost("nano-banana-pro", "1K", "5"), 18);
  assert.equal(generationCreditCost("nano-banana-pro", "2K", "5"), 18);
  assert.equal(generationCreditCost("nano-banana-pro", "4K", "5"), 24);
  assert.equal(generationCreditCost("gpt-image-2", "1K", "5"), 6);
  assert.equal(generationCreditCost("gpt-image-2", "2K", "5"), 10);
  assert.equal(generationCreditCost("gpt-image-2", "4K", "5"), 16);
  assert.equal(generationCreditCost("seedream-5-lite", "2K", "5"), 6);
  assert.equal(generationCreditCost("seedream-5-lite", "3K", "5"), 6);
  assert.equal(generationCreditCost("seedream-5-lite", "4K", "5"), 6);
  assert.equal(generationCreditCost("seedream-5-pro", "1K", "5"), 7);
  assert.equal(generationCreditCost("seedream-5-pro", "2K", "5"), 14);
  assert.equal(generationCreditCost("seedream-5-pro", "1K", "5", 1), 7);
  assert.equal(generationCreditCost("seedream-5-pro", "1K", "5", 3), 8);
  assert.equal(generationCreditCost("flux-2-flex", "1K", "5"), 14);
  assert.equal(generationCreditCost("flux-2-pro", "2K", "5"), 24);
  assert.equal(generationCreditCost("flux-2-flex", "2K", "5"), 24);
  assert.equal(generationCreditCost("imagen4-fast", "1K", "5"), 4);
  assert.equal(generationCreditCost("imagen4-ultra", "1K", "5"), 12);
  assert.equal(generationCreditCost("grok-image-2", "1K", "5"), 4);
});

test("image editing uses the same published model price with one source reference", () => {
  assert.equal(generationCreditCost("nano-banana-2-lite", "1K", "5", 1), 4);
  assert.equal(generationCreditCost("nano-banana-2", "1K", "5", 1), 8);
  assert.equal(generationCreditCost("gpt-image-2", "2K", "5", 1), 10);
  assert.equal(generationCreditCost("seedream-5-pro", "1K", "5", 1), 7);
  assert.equal(generationCreditCost("flux-2-flex", "2K", "5", 1), 24);
  assert.equal(generationCreditCost("grok-image-2", "1K", "5", 1), 4);
});

test("video credits account for resolution and duration", () => {
  assert.equal(generationCreditCost("seedance-2-fast", "480P", "5"), 78);
  assert.equal(generationCreditCost("seedance-2-fast", "720P", "5"), 165);
  assert.equal(generationCreditCost("seedance-2", "1080P", "5"), 510);
  assert.equal(generationCreditCost("kling-3", "1080P", "5"), 135);
  assert.equal(generationCreditCost("kling-3", "720P", "5", 0, { generateAudio: false }), 70);
  assert.equal(generationCreditCost("seedance-2", "720P", "5", 1, { hasVideoInput: true, inputVideoDurationSeconds: 7 }), 300);
  assert.equal(generationCreditCost("kling-3-turbo-text", "1080P", "5"), 113);
  assert.equal(generationCreditCost("kling-3-motion", "720P", "5"), 100);
  assert.equal(generationCreditCost("kling-3-motion", "1080P", "5", 2, { hasVideoInput: true, inputVideoDurationSeconds: 12 }), 324);
  assert.equal(generationCreditCost("grok-video-text", "1080P", "6"), 48);
  assert.equal(generationCreditCost("seedance-2-mini", "480P", "5"), 48);
  assert.equal(generationCreditCost("seedance-2-fast", "720P", "5", 1, { hasVideoInput: true }), 100);
  assert.equal(generationCreditCost("seedance-2-5", "480P", "5"), 140);
  assert.equal(generationCreditCost("seedance-2-5", "720P", "5"), 315);
  assert.equal(generationCreditCost("seedance-2-5", "480P", "5", 1, { hasVideoInput: true, inputVideoDurationSeconds: 7 }), 204);
  assert.equal(generationCreditCost("seedance-2-5", "720P", "5", 1, { hasVideoInput: true, inputVideoDurationSeconds: 7 }), 456);
  assert.equal(generationCreditCost("seedance-2-5", "1080P", "5", 1, { hasVideoInput: true, inputVideoDurationSeconds: 7 }), 822);
  assert.throws(() => generationCreditCost("seedance-2-5", "1080P", "5"), /requires a video input/);
  assert.equal(generationCreditCost("grok-video-1-5", "480P", "8"), 20);
  assert.equal(generationCreditCost("grok-video-1-5", "720P", "8"), 36);
  assert.equal(generationCreditCost("wan-2-7", "1080P", "10"), 240);
  assert.equal(generationCreditCost("veo-3-1-fast", "720P", "8"), 60);
  assert.equal(generationCreditCost("veo-3-1-fast", "1080P", "8"), 65);
  assert.equal(generationCreditCost("veo-3-1-fast", "4K", "8"), 180);
  assert.equal(generationCreditCost("veo-3-1", "720P", "8"), 250);
  assert.equal(generationCreditCost("veo-3-1", "1080P", "8"), 255);
  assert.equal(generationCreditCost("veo-3-1", "4K", "8"), 380);
  assert.equal(generationCreditCost("veo-3-1", "4K", "8", 1), 370);
});
