import { videoPromptSystemInstruction } from "../src/lib/generation-prompt-system";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { allowedKieRatios, buildKieInput, getKieModel, normalizeKieTask, startGeneration } from "../src/lib/kie";
import { newKieInputError, newKieModels, newKieReferenceNames, newKieRoleError } from "../src/lib/kie-new-models";
import { prepareNewKieReferences } from "../src/lib/kie-reference-validation";
import { admitGeneration, generationDispatchPayload } from "../src/lib/generation-admission";
import { generationCreditCost } from "../src/lib/generation-pricing";
import { incompatibleReferenceRoles } from "../src/lib/generator-reference-modes";
import { canvasGenerationModels, canvasNodeOutputType, defaultCanvasNodeData } from "../src/lib/mcp/canvas-capabilities";
import type { VideoMasterClip } from "../src/lib/types";
import { videoMasterGenerationDurationChoices, videoMasterReferencePreparationDuration } from "../src/lib/video-master";

const prompt = "Keep the same subject and move the camera slowly.";
const ref = (role = "reference-image", durationSeconds?: number) => ({ assetUrl: `https://example.test/${role}`, label: "@Subject", role, durationSeconds });
const error = (id: string, references: ReturnType<typeof ref>[], overrides = {}) => newKieInputError(id, { prompt, references, ...overrides });

test("GPT Image 2.5 variants dispatch full edit arrays and resolution-specific ratios", () => {
  for (const variant of ["flare", "sunburst"]) {
    const id = `gpt-image-2-5-${variant}`;
    assert.deepEqual(buildKieInput(id, { prompt, resolution: "4K", aspectRatio: "auto" }, [ref()]), { prompt, input_urls: [ref().assetUrl], resolution: "4K", aspect_ratio: "auto" });
    assert.deepEqual(buildKieInput(id, { prompt, resolution: "2K", aspectRatio: "1:1" }, []), { prompt, resolution: "2K", aspect_ratio: "1:1" });
    for (const ratio of ["27:16", "16:27", "9:8", "8:9"]) {
      assert.ok(allowedKieRatios(getKieModel(id), "1K", true).includes(ratio));
      assert.throws(() => buildKieInput(id, { prompt, resolution: "2K", aspectRatio: ratio }, []), /unsupported aspect ratio/);
    }
    assert.equal(error(id, Array.from({ length: 16 }, () => ref())), null);
    assert.match(error(id, Array.from({ length: 17 }, () => ref()))!, /at most 16/);
  }
});

test("WAN 3 encodes uppercase quality, numeric duration, audio and independent media arrays", () => {
  for (const id of ["wan-3", "wan-3-prime"]) {
    const references = [ref(), ref("reference-video", 7.25), ref("reference-audio", 4)];
    assert.deepEqual(buildKieInput(id, { prompt, resolution: "1080P", aspectRatio: "adaptive", duration: "12", generateAudio: false }, references), {
      prompt, reference_image_urls: [ref().assetUrl], reference_video_urls: [ref("reference-video").assetUrl], reference_audio_urls: [ref("reference-audio").assetUrl], resolution: "1080P", aspect_ratio: "adaptive", duration: 12, audio: false,
    });
    const frames = buildKieInput(id, { prompt }, [ref("start-frame"), ref("end-frame")]);
    assert.equal(frames.first_frame_url, ref("start-frame").assetUrl);
    assert.equal(frames.last_frame_url, ref("end-frame").assetUrl);
    assert.equal("reference_image_urls" in frames, false);
    assert.match(error(id, [ref("start-frame"), ref()])!, /cannot be combined/);
    assert.match(error(id, [ref("reference-audio", 3)])!, /together with an audio/);
    assert.match(error(id, [ref("reference-video")])!, /measured duration/);
    assert.match(error(id, [ref("reference-video", 8), ref("reference-video", 8)])!, /total at most 15/);
    assert.match(error(id, [ref("reference-video", 15)], { duration: "16" })!, /must not exceed 30/);
    assert.equal(error(id, [ref("reference-video", 15)], { duration: "15" }), null);
  }
  assert.deepEqual(newKieReferenceNames("wan-3", [ref(), ref("reference-video", 3), ref(), ref("reference-audio", 3)]), ["Image1", "Video1", "Image2", "Audio1"]);
});

test("PixVerse V6 uses each mode's required fields without silently treating images as frames", () => {
  const input = { prompt, duration: "5", resolution: "540P", generateAudio: true };
  const base = { prompt, duration: 5, quality: "540p", generate_audio_switch: true };
  assert.deepEqual(buildKieInput("pixverse-v6-text", input, []), { ...base, aspect_ratio: "16:9" });
  assert.deepEqual(buildKieInput("pixverse-v6-image", input, [ref(), ref()]), { ...base, image_urls: [ref().assetUrl, ref().assetUrl] });
  assert.deepEqual(buildKieInput("pixverse-v6-transition", input, [ref("start-frame"), ref("end-frame")]), { ...base, first_frame_image_url: ref("start-frame").assetUrl, last_frame_image_url: ref("end-frame").assetUrl });
  assert.deepEqual(buildKieInput("pixverse-v6-extend", input, [ref("reference-video")]), { ...base, video_url: ref("reference-video").assetUrl });
  assert.deepEqual(buildKieInput("pixverse-v6-reference", input, [ref(), ref()]), { ...base, aspect_ratio: "16:9", image_references: [1, 2].map((i) => ({ image_url: ref().assetUrl, ref_name: `image${i}`, type: "subject" })) });
  assert.match(error("pixverse-v6-transition", [ref("start-frame")])!, /connect End frame/);
  assert.match(newKieRoleError("pixverse-v6-transition", [ref(), ref()])!, /unsupported input/);
  assert.match(error("pixverse-v6-extend", [])!, /connect Video to extend/);
  assert.match(error("pixverse-v6-text", [], { prompt: "Hi" })!, /at least 3/);
  assert.match(error("pixverse-v6-text", [], { duration: "16" })!, /duration must/);
});

test("Omni encodes a measured clip and its slot budget, with no fabricated audio-file inputs", () => {
  for (const id of ["gemini-omni-video", "gemini-omni-flash-1-1"]) {
    assert.deepEqual(buildKieInput(id, { prompt, duration: "6", resolution: "4K", generateAudio: false }, [ref(), ref("reference-video", 7.25)]), {
      prompt, duration: "6", resolution: "4k", aspect_ratio: "16:9", image_urls: [ref().assetUrl], video_list: [{ url: ref("reference-video").assetUrl, start: 0, ends: 7.25 }],
    });
    assert.equal(error(id, [...Array.from({ length: 5 }, () => ref()), ref("reference-video", 10)]), null);
    assert.match(error(id, [...Array.from({ length: 6 }, () => ref()), ref("reference-video", 10)])!, /at most 5 images/);
    assert.match(error(id, [ref("reference-video", 10.1)])!, /at most 10s/);
    assert.match(error(id, [ref("reference-video")])!, /measured duration/);
    assert.match(error(id, [ref("reference-audio", 5)])!, /unsupported input/);
    assert.deepEqual(videoMasterGenerationDurationChoices(getKieModel(id), undefined, true), []);
    assert.deepEqual(videoMasterGenerationDurationChoices(getKieModel(id), undefined, false), [4, 6, 8, 10]);
  }
  assert.match(error("gemini-omni-video", [ref("start-frame")])!, /unsupported input/);
  assert.match(error("gemini-omni-flash-1-1", [ref("end-frame")])!, /start frame/);
  assert.match(error("gemini-omni-flash-1-1", [ref("start-frame"), ref("reference-video", 5)])!, /cannot be combined/);
  const frames = buildKieInput("gemini-omni-flash-1-1", { prompt }, [ref("start-frame"), ref("end-frame")]);
  assert.equal(frames.first_frame_url, ref("start-frame").assetUrl);
  assert.equal(frames.last_frame_url, ref("end-frame").assetUrl);
  assert.equal("image_urls" in frames, false);
});

test("quotes match Kie credit tables including audio, fusion, input duration and fixed Omni video pricing", () => {
  assert.equal(generationCreditCost("gpt-image-2-5-flare", "4K", "5"), 16);
  assert.equal(generationCreditCost("gpt-image-2-5-sunburst", "2K", "5"), 10);
  assert.equal(generationCreditCost("wan-3", "720P", "5", 1, { hasVideoInput: true, inputVideoDurationSeconds: 7.25 }), 196);
  assert.equal(generationCreditCost("wan-3-prime", "1080P", "5", 1, { hasVideoInput: true, inputVideoDurationSeconds: 7.25 }), 618);
  assert.equal(generationCreditCost("pixverse-v6-image", "540P", "5", 1, { generateAudio: false }), 28);
  assert.equal(generationCreditCost("pixverse-v6-image", "540P", "5", 1, { generateAudio: true }), 36);
  assert.equal(generationCreditCost("pixverse-v6-reference", "720P", "5", 2, { generateAudio: true }), 54);
  for (const id of ["gemini-omni-video", "gemini-omni-flash-1-1"]) {
    for (const [duration, price] of [[4, 63], [6, 84], [8, 105], [10, 126]]) {
      assert.equal(generationCreditCost(id, "720P", String(duration)), price);
      assert.equal(generationCreditCost(id, "4K", String(duration)), price + 84);
      assert.equal(generationCreditCost(id, "720P", String(duration), 1, { hasVideoInput: true }), 168);
      assert.equal(generationCreditCost(id, "4K", String(duration), 1, { hasVideoInput: true }), 252);
    }
  }
});

test("catalogues expose eleven models, correct output types and disjoint frame/reference modes", () => {
  assert.equal(newKieModels.length, 11);
  const capabilities = canvasGenerationModels();
  for (const model of newKieModels) {
    const data = defaultCanvasNodeData(model.mediaType === "image" ? "image_generator" : "video_generator", { modelId: model.id });
    assert.equal(canvasNodeOutputType(data), model.mediaType);
    assert.deepEqual(capabilities.find((entry) => entry.id === model.id)?.outputPorts, [{ id: `${model.mediaType}-output`, kind: model.mediaType }]);
    assert.ok(generationCreditCost(model.id, model.defaultResolution!, model.defaultDuration || "5") > 0);
  }
  assert.deepEqual(incompatibleReferenceRoles("wan-3", "reference-audio"), ["start-frame", "end-frame"]);
  assert.deepEqual(incompatibleReferenceRoles("gemini-omni-flash-1-1", "start-frame"), ["reference-image", "reference-video"]);
  const task = normalizeKieTask({ code: 200, data: { taskId: "result", state: "success", model: "pixverse-v6/extend", resultJson: JSON.stringify({ resultUrls: ["https://example.test/output.mp4"] }) } });
  assert.equal(task.status, "success");
  assert.deepEqual(task.generated, ["https://example.test/output.mp4"]);
});

test("bad new-model inputs fail at admission before any database/usage reservation", async () => {
  const result = await admitGeneration({
    userId: "unused", projectId: "unused", nodeId: "unused", model: getKieModel("pixverse-v6-transition"), prompt,
    references: [], operation: "generation", aspectRatio: "auto", resolution: "720P", duration: "5", generateAudio: false, hasVideoInput: false, inputVideoDurationSeconds: 0,
  });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.status, 400); assert.match(result.error, /connect Start frame/); }
});

test("preflight measures WAN images and distinguishes an opaque alpha channel from transparency", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kie-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "opaque.png");
  await sharp({ create: { width: 240, height: 240, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toFile(path);
  const references = await prepareNewKieReferences("wan-3", [{ path, mimeType: "image/png", label: "Subject", role: "reference-image" }]);
  assert.equal(newKieInputError("wan-3", { prompt, references }), null);
  await sharp({ create: { width: 240, height: 240, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 0 } } }).png().toFile(path);
  const transparent = await prepareNewKieReferences("wan-3", [{ path, mimeType: "image/png", label: "Subject", role: "reference-image" }]);
  assert.match(newKieInputError("wan-3", { prompt, references: transparent })!, /transparency/);
  const bmpPath = join(dir, "reference.bmp");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, bmpPath]);
  const bitmap = await prepareNewKieReferences("wan-3", [{ path: bmpPath, mimeType: "image/bmp", label: "Subject", role: "reference-image" }]);
  assert.equal(newKieInputError("wan-3", { prompt, references: bitmap }), null);
});

test("all new routes submit the expected provider model; GPT switches text/edit automatically", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kie-dispatch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "reference.png");
  await writeFile(path, "fixture");
  for (const name of ["KIE_API_KEY", "KIE_API_KEY_FILE", "REDIS_URL"] as const) {
    const before = process.env[name];
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
    delete process.env[name];
  }
  process.env.KIE_API_KEY = "test-provider-key";
  const requests: { model: string; input: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("file-stream-upload")) return Response.json({ code: 200, data: { downloadUrl: "https://example.test/upload.png" } });
    assert.equal(String(url), "https://api.kie.ai/api/v1/jobs/createTask");
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ code: 200, data: { taskId: "new-task" } });
  });
  for (const model of newKieModels) {
    const references = (model.inputPorts || []).filter((port) => port.required).map((port) => ({ path, mimeType: `${port.kind}/${port.kind === "video" ? "mp4" : "png"}`, label: "@Subject", role: port.id, sizeBytes: 7 }));
    await startGeneration({ modelId: model.id, prompt, references });
    assert.equal(requests.at(-1)?.model, model.providerModel);
  }
  for (const variant of ["flare", "sunburst"]) {
    await startGeneration({ modelId: `gpt-image-2-5-${variant}`, prompt, references: [{ path, mimeType: "image/png", label: "@Subject", role: "reference-image", sizeBytes: 7 }] });
    assert.equal(requests.at(-1)?.model, `gpt-image-2-5-${variant}-image-to-image`);
  }
  const references = [{ path, mimeType: "video/mp4", label: "@Clip", role: "reference-video", sizeBytes: 7, durationSeconds: 5.25 }];
  const payload = generationDispatchPayload({ userId: "unused", projectId: "unused", nodeId: "unused", model: getKieModel("gemini-omni-video"), prompt, references, aspectRatio: "16:9", resolution: "720P", duration: "8", generateAudio: true, operation: "generation", hasVideoInput: true, inputVideoDurationSeconds: 5.25 });
  await startGeneration(payload);
  assert.deepEqual(requests.at(-1)?.input.video_list, [{ url: "https://example.test/upload.png", start: 0, ends: 5.25 }]);
});

test("Omni preserves the full source when its mandatory output-duration field is shorter", () => {
  const clip = { duration: 9.5, generationDuration: 4 } as VideoMasterClip;
  assert.equal(videoMasterReferencePreparationDuration(getKieModel("gemini-omni-video"), clip), 9.5);
  assert.equal(videoMasterReferencePreparationDuration(getKieModel("seedance-2"), clip), 4);
});

test("Omni prompt assistance does not promise the ignored requested output duration", () => {
  const instruction = videoPromptSystemInstruction({ modelId: "gemini-omni-video", duration: "4", references: [{ role: "reference-video" }] });
  assert.match(instruction, /output duration is automatic/);
  assert.doesNotMatch(instruction, /feasible within 4 seconds/);
});
