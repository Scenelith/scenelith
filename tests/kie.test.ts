import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { allowedKieRatios, allowedKieResolutions, assertKiePromptLength, buildKieInput, getKieModel, kieModels, kieProviderPrompt, normalizeKieTask, startGeneration, verifyKieWebhook } from "../src/lib/kie";

test("legacy saved model IDs resolve to supported Kie models", () => {
  assert.equal(getKieModel("nano-banana-pro-flash").id, "nano-banana-2");
  assert.equal(getKieModel("wan-2-7-i2v").id, "wan-2-7");
  assert.equal(getKieModel("kling-v3-pro").id, "kling-3");
  assert.equal(getKieModel("flux-2-pro").id, "flux-2-flex");
});

test("unified Kie task responses and Veo responses normalize identically", () => {
  assert.deepEqual(normalizeKieTask({ data: { taskId: "task-1", state: "success", resultJson: '{"resultUrls":["https://cdn.test/image.png"]}' } }), {
    task_id: "task-1",
    status: "success",
    generated: ["https://cdn.test/image.png"],
    error: undefined,
  });
  assert.deepEqual(normalizeKieTask({ data: { taskId: "veo-1", successFlag: 1, response: { resultUrls: ["https://cdn.test/video.mp4"] } } }), {
    task_id: "veo-1",
    status: "success",
    generated: ["https://cdn.test/video.mp4"],
    error: undefined,
  });
  assert.deepEqual(normalizeKieTask({ code: 500, msg: "Provider rejected the prompt", data: { taskId: "veo-2" } }), {
    task_id: "veo-2",
    status: "fail",
    generated: [],
    error: "Provider rejected the prompt",
  });
});

test("provider prompt transport preserves the exact automation request and ordered reference labels", () => {
  const request = '{"task":"Keep this exact request","preserve":["Exact framing"]}';
  assert.equal(kieProviderPrompt(request, []), request);
  assert.equal(
    kieProviderPrompt(request, ["@Source_composition_1_1", "@Main_identity_1_2"]),
    `REFERENCE_MAP (bindings are exact; never swap images):\n1: @Source_composition_1_1\n2: @Main_identity_1_2\nUSER_REQUEST:\n${request}`,
  );
});

test("image format validation distinguishes text-only requests from requests with references", () => {
  const model = getKieModel("flux-2-flex");
  assert.equal(allowedKieRatios(model, "1K", true).includes("auto"), true);
  assert.equal(allowedKieRatios(model, "1K", false).includes("auto"), false);
});

test("provider dispatch rejects excess references instead of silently truncating them", async () => {
  await assert.rejects(startGeneration({
    modelId: "imagen4-fast",
    prompt: "Exact request",
    references: [{ path: "reference.png", mimeType: "image/png", label: "Reference" }],
    aspectRatio: "9:16",
    resolution: "1K",
  }), /accepts at most 0 reference inputs/);
});

test("model adapters use the documented reference fields", () => {
  assert.deepEqual(buildKieInput("nano-banana-2-lite", { prompt: "Fast product draft", aspectRatio: "4:5", resolution: "1K" }, ["https://cdn.test/ref.png"]), {
    prompt: "Fast product draft",
    image_urls: ["https://cdn.test/ref.png"],
    aspect_ratio: "4:5",
  });
  assert.deepEqual(buildKieInput("gpt-image-2", { prompt: "Product poster", aspectRatio: "4:5", resolution: "2K" }, ["https://cdn.test/ref.png"]), {
    prompt: "Product poster",
    input_urls: ["https://cdn.test/ref.png"],
    aspect_ratio: "4:5",
    resolution: "2K",
  });
  assert.deepEqual(buildKieInput("gpt-image-2", { prompt: "Product poster", aspectRatio: "16:9", resolution: "1K" }, []), {
    prompt: "Product poster",
    aspect_ratio: "16:9",
    resolution: "1K",
  });
  assert.deepEqual(buildKieInput("grok-image-2", { prompt: "Editorial portrait", aspectRatio: "2:3", resolution: "1K" }, []), {
    prompt: "Editorial portrait",
    aspect_ratio: "2:3",
  });
  assert.deepEqual(buildKieInput("seedream-5-lite", { prompt: "Editorial portrait", aspectRatio: "3:4", resolution: "4K" }, []), {
    prompt: "Editorial portrait",
    aspect_ratio: "3:4",
    quality: "ultra",
    output_format: "png",
    nsfw_checker: false,
  });
  assert.deepEqual(buildKieInput("seedream-5-lite", { prompt: "Editorial portrait", aspectRatio: "3:4", resolution: "3K" }, ["https://cdn.test/ref.png"]), {
    prompt: "Editorial portrait",
    image_urls: ["https://cdn.test/ref.png"],
    aspect_ratio: "3:4",
    quality: "high",
    output_format: "png",
    nsfw_checker: false,
  });
  assert.deepEqual(buildKieInput("flux-2-pro", { prompt: "Product photograph", aspectRatio: "1:1", resolution: "2K" }, []), {
    prompt: "Product photograph",
    aspect_ratio: "1:1",
    resolution: "2K",
    nsfw_checker: false,
  });
  const wan = buildKieInput("wan-2-7", { prompt: "Slow push in", resolution: "1080P", duration: "5" }, [
    { assetUrl: "https://cdn.test/first.png", label: "first", role: "start-frame" },
    { assetUrl: "https://cdn.test/last.png", label: "last", role: "end-frame" },
  ]);
  assert.equal(wan.first_frame_url, "https://cdn.test/first.png");
  assert.equal(wan.last_frame_url, "https://cdn.test/last.png");
  assert.equal("ratio" in wan, false);

  const seedance = buildKieInput("seedance-2-fast", { prompt: "Camera move", aspectRatio: "9:16", resolution: "720P", duration: "8", generateAudio: true }, [
    { assetUrl: "https://cdn.test/start.png", label: "start", role: "start-frame" },
    { assetUrl: "https://cdn.test/end.png", label: "end", role: "end-frame" },
    { assetUrl: "https://cdn.test/reference.mp4", label: "motion", role: "reference-video" },
  ]);
  assert.equal(seedance.first_frame_url, "https://cdn.test/start.png");
  assert.equal(seedance.last_frame_url, "https://cdn.test/end.png");
  assert.deepEqual(seedance.reference_video_urls, ["https://cdn.test/reference.mp4"]);
  assert.equal(seedance.generate_audio, true);

  const seedance25 = buildKieInput("seedance-2-5", { prompt: "Use all supplied media", aspectRatio: "adaptive", resolution: "480P", duration: "30", generateAudio: false }, [
    { assetUrl: "https://cdn.test/look.png", label: "look", role: "reference-image" },
    { assetUrl: "https://cdn.test/motion.mp4", label: "motion", role: "reference-video" },
    { assetUrl: "https://cdn.test/timing.mp3", label: "timing", role: "reference-audio" },
  ]);
  assert.deepEqual(seedance25.reference_image_urls, ["https://cdn.test/look.png"]);
  assert.deepEqual(seedance25.reference_video_urls, ["https://cdn.test/motion.mp4"]);
  assert.deepEqual(seedance25.reference_audio_urls, ["https://cdn.test/timing.mp3"]);
  assert.equal(seedance25.resolution, "480p");
  assert.equal(seedance25.aspect_ratio, "adaptive");
  assert.equal(seedance25.duration, 30);
  assert.equal(seedance25.output_format, "mp4");

  assert.deepEqual(buildKieInput("kling-3-motion", { prompt: "Match this motion", resolution: "1080P" }, [
    { assetUrl: "https://cdn.test/subject.png", label: "subject", role: "start-frame" },
    { assetUrl: "https://cdn.test/motion.mp4", label: "motion", role: "reference-video" },
  ]), {
    prompt: "Match this motion",
    input_urls: ["https://cdn.test/subject.png"],
    video_urls: ["https://cdn.test/motion.mp4"],
    mode: "1080p",
    character_orientation: "image",
    background_source: "input_video",
  });
});

test("image catalogue mirrors documented references, quality and ratio controls", () => {
  assert.equal(getKieModel("nano-banana-2-lite").maxReferences, 10);
  assert.equal(getKieModel("nano-banana-2-lite").defaultRatio, "auto");
  assert.equal(getKieModel("nano-banana-2-lite").maxPromptLength, 20_000);
  assert.equal(getKieModel("nano-banana-2").maxPromptLength, 20_000);
  assert.equal(getKieModel("nano-banana-pro").maxPromptLength, 10_000);
  assert.equal(getKieModel("gpt-image-2").maxPromptLength, 20_000);
  assert.equal(getKieModel("seedream-5-lite").maxPromptLength, 3_000);
  assert.deepEqual(getKieModel("nano-banana-2").ratiosByResolution?.["4K"], ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
  assert.equal(getKieModel("nano-banana-pro").maxReferences, 8);
  assert.equal(getKieModel("gpt-image-2").maxReferences, 16);
  assert.equal(getKieModel("gpt-image-2").ratiosByResolution?.["4K"].includes("1:1"), false);
  assert.equal(getKieModel("gpt-image-2").referenceRatiosByResolution?.["2K"].includes("3:1"), true);
  assert.deepEqual(getKieModel("seedream-5-lite").resolutions, ["2K", "3K", "4K"]);
  assert.deepEqual(getKieModel("seedream-5-pro").resolutions, ["1K", "2K"]);
  assert.equal(getKieModel("flux-2-pro").id, "flux-2-flex");
  assert.deepEqual(getKieModel("flux-2-flex").referenceOnlyRatios, ["auto"]);
  assert.equal(getKieModel("imagen4-fast").defaultRatio, "16:9");
  assert.equal(getKieModel("imagen4-ultra").defaultRatio, "1:1");
  const grokImage2 = getKieModel("grok-image-2");
  assert.equal(grokImage2.providerModel, "grok-imagine-image-2-0/text-to-image");
  assert.deepEqual(grokImage2.ratios, ["1:1", "2:3", "3:2", "16:9", "9:16"]);
  assert.equal(grokImage2.maxReferences, 1);
  assert.deepEqual(grokImage2.inputPorts?.map((port) => port.id), ["reference-image"]);
});

test("video catalogue mirrors the documented duration ranges and defaults", () => {
  const expected: Record<string, { first?: string; last?: string; values?: string[]; defaultDuration?: string }> = {
    "seedance-2-fast": { first: "4", last: "15", defaultDuration: "5" },
    "seedance-2-mini": { first: "4", last: "15", defaultDuration: "5" },
    "seedance-2": { first: "4", last: "15", defaultDuration: "5" },
    "seedance-2-5": { first: "4", last: "30", defaultDuration: "5" },
    "kling-3": { first: "3", last: "15", defaultDuration: "5" },
    "kling-3-turbo-text": { first: "3", last: "15", defaultDuration: "5" },
    "kling-3-turbo-image": { first: "3", last: "15", defaultDuration: "5" },
    "grok-video-text": { first: "6", last: "30", defaultDuration: "6" },
    "grok-video-image": { first: "6", last: "30", defaultDuration: "6" },
    "grok-video-1-5": { first: "1", last: "15", defaultDuration: "8" },
    "wan-2-7": { first: "2", last: "15", defaultDuration: "5" },
    "veo-3-1-fast": { values: ["4", "6", "8"], defaultDuration: "8" },
    "veo-3-1": { values: ["4", "6", "8"], defaultDuration: "8" },
  };
  for (const [id, constraints] of Object.entries(expected)) {
    const model = kieModels.find((item) => item.id === id);
    assert.ok(model, `${id} is in the catalogue`);
    assert.equal(model.defaultDuration, constraints.defaultDuration, `${id} default duration`);
    if (constraints.values) assert.deepEqual(model.durations, constraints.values, `${id} duration choices`);
    if (constraints.first) assert.equal(model.durations?.[0], constraints.first, `${id} minimum duration`);
    if (constraints.last) assert.equal(model.durations?.at(-1), constraints.last, `${id} maximum duration`);
  }
  assert.equal(getKieModel("kling-3-motion").durationSource, "reference-video");
});

test("generation catalogue mirrors documented prompt limits", () => {
  const limits: Record<string, number> = {
    "nano-banana-2-lite": 20_000,
    "nano-banana-2": 20_000,
    "nano-banana-pro": 10_000,
    "gpt-image-2": 20_000,
    "seedream-5-lite": 3_000,
    "seedream-5-pro": 5_000,
    "flux-2-flex": 5_000,
    "imagen4-fast": 5_000,
    "imagen4-ultra": 5_000,
    "seedance-2-fast": 20_000,
    "seedance-2-mini": 20_000,
    "seedance-2": 20_000,
    "seedance-2-5": 30_000,
    "kling-3-turbo-text": 2_500,
    "kling-3-turbo-image": 2_500,
    "kling-3-motion": 2_500,
    "grok-video-text": 5_000,
    "grok-video-image": 5_000,
    "grok-video-1-5": 4_096,
    "wan-2-7": 5_000,
  };
  for (const [id, limit] of Object.entries(limits)) {
    assert.equal(getKieModel(id).maxPromptLength || 5_000, limit, `${id} prompt limit`);
  }
});

test("provider request validation uses each model's documented prompt limit", () => {
  assert.doesNotThrow(() => assertKiePromptLength("nano-banana-2", "x".repeat(10_220)));
  assert.throws(
    () => assertKiePromptLength("nano-banana-2", "x".repeat(20_001)),
    /Nano Banana 2 accepts prompts up to 20,000 characters/,
  );
  assert.doesNotThrow(() => assertKiePromptLength("kling-3-turbo-text", "x".repeat(2_500)));
  assert.throws(
    () => assertKiePromptLength("kling-3-turbo-text", "x".repeat(2_501)),
    /Kling 3\.0 Turbo · Text accepts prompts up to 2,500 characters/,
  );
});

test("video catalogue exposes only documented quality, ratio and input controls", () => {
  const seedance = getKieModel("seedance-2");
  assert.deepEqual(seedance.resolutions, ["480P", "720P", "1080P", "4K"]);
  assert.deepEqual(seedance.ratios, ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"]);
  assert.deepEqual(seedance.inputPorts?.map((port) => port.id), ["start-frame", "end-frame", "reference-video", "reference-audio", "reference-image"]);
  assert.equal(seedance.defaultGenerateAudio, true);
  assert.deepEqual(getKieModel("seedance-2-fast").resolutions, ["480P", "720P"]);
  assert.deepEqual(getKieModel("seedance-2-mini").resolutions, ["480P", "720P"]);
  const seedance25 = getKieModel("seedance-2-5");
  assert.equal(seedance25.providerModel, "bytedance/seedance-2-5");
  assert.deepEqual(seedance25.resolutions, ["480P", "720P", "1080P"]);
  assert.deepEqual(seedance25.videoInputOnlyResolutions, ["1080P"]);
  assert.deepEqual(allowedKieResolutions(seedance25, false), ["480P", "720P"]);
  assert.deepEqual(allowedKieResolutions(seedance25, true), ["480P", "720P", "1080P"]);
  assert.equal(seedance25.defaultRatio, "adaptive");
  assert.equal(seedance25.maxReferences, 50);
  assert.deepEqual(seedance25.inputPorts?.map(({ id, max }) => [id, max]), [
    ["start-frame", 1],
    ["end-frame", 1],
    ["reference-video", 10],
    ["reference-audio", 10],
    ["reference-image", 30],
  ]);
  assert.deepEqual(seedance25.referenceMediaDuration, { minSeconds: 2, maxSeconds: 30, maxTotalSeconds: 30 });

  assert.deepEqual(getKieModel("kling-3").resolutions, ["720P", "1080P", "4K"]);
  assert.deepEqual(getKieModel("kling-3").ratios, ["16:9", "9:16", "1:1"]);
  assert.equal(getKieModel("kling-3").defaultGenerateAudio, false);
  assert.deepEqual(getKieModel("kling-3-motion").inputPorts?.map((port) => port.id), ["start-frame", "reference-video"]);

  assert.deepEqual(getKieModel("grok-video-text").resolutions, ["480P", "720P", "1080P"]);
  assert.deepEqual(new Set(getKieModel("grok-video-image").ratios), new Set(["2:3", "3:2", "1:1", "16:9", "9:16"]));
  assert.deepEqual(getKieModel("grok-video-1-5").ratios, ["auto", "16:9", "9:16", "1:1", "3:2", "2:3"]);
  assert.equal(getKieModel("grok-video-1-5").defaultResolution, "480P");
  assert.deepEqual(getKieModel("grok-video-1-5").resolutions, ["480P", "720P"]);
  assert.equal(getKieModel("grok-video-1-5").maxReferences, 7);

  assert.deepEqual(getKieModel("wan-2-7").resolutions, ["720P", "1080P"]);
  assert.deepEqual(getKieModel("wan-2-7").ratios, ["16:9", "9:16", "1:1", "4:3", "3:4"]);
  assert.deepEqual(getKieModel("wan-2-7").inputPorts?.map((port) => port.id), ["start-frame", "end-frame", "reference-video", "reference-audio"]);

  for (const id of ["veo-3-1-fast", "veo-3-1"]) {
    assert.deepEqual(getKieModel(id).resolutions, ["720P", "1080P", "4K"]);
    assert.deepEqual(getKieModel(id).ratios, ["16:9", "9:16", "auto"]);
  }
  assert.deepEqual(getKieModel("veo-3-1-fast").inputPorts?.map((port) => port.id), ["start-frame", "end-frame", "reference-image"]);
  assert.deepEqual(getKieModel("veo-3-1").inputPorts?.map((port) => port.id), ["start-frame", "end-frame"]);
});

test("Grok 1.5 payload supports text-only generation and exact documented defaults", () => {
  assert.deepEqual(buildKieInput("grok-video-1-5", { prompt: "Orbit around the subject" }, []), {
    prompt: "Orbit around the subject",
    aspect_ratio: "auto",
    resolution: "480p",
    duration: 8,
  });
  assert.deepEqual(buildKieInput("grok-video-1-5", { prompt: "Animate", resolution: "720P", duration: "1" }, [
    { assetUrl: "https://cdn.test/start.png", label: "start", role: "reference-image" },
  ]), {
    prompt: "Animate",
    image_urls: ["https://cdn.test/start.png"],
    resolution: "720p",
    duration: 1,
  });
});

test("Kie webhook HMAC verifies task id and rejects stale timestamps", () => {
  process.env.KIE_WEBHOOK_HMAC_KEY = "test-secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "test-secret").update(`task-1.${timestamp}`).digest("base64");
  assert.equal(verifyKieWebhook("task-1", new Headers({ "X-Webhook-Timestamp": timestamp, "X-Webhook-Signature": signature })), true);
  assert.equal(verifyKieWebhook("task-2", new Headers({ "X-Webhook-Timestamp": timestamp, "X-Webhook-Signature": signature })), false);
  const stale = String(Math.floor(Date.now() / 1000) - 301);
  const staleSignature = createHmac("sha256", "test-secret").update(`task-1.${stale}`).digest("base64");
  assert.equal(verifyKieWebhook("task-1", new Headers({ "X-Webhook-Timestamp": stale, "X-Webhook-Signature": staleSignature })), false);
  delete process.env.KIE_WEBHOOK_HMAC_KEY;
});
