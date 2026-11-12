import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { allowedKieRatios, buildKieInput, getKieModel, normalizeKieTask, startGeneration } from "../src/lib/kie";
import { newKieInputError, newKieReferenceNames } from "../src/lib/kie-new-models";
import { generationCreditCost } from "../src/lib/generation-pricing";
import { incompatibleReferenceRoles } from "../src/lib/generator-reference-modes";
import { canvasGenerationModels } from "../src/lib/mcp/canvas-capabilities";

const prompt = "Keep the subject and follow the connected references.";
const reference = (role = "reference-image", durationSeconds?: number) => ({ assetUrl: `https://example.test/${role}`, label: "@Subject", role, durationSeconds });
const invalid = (modelId: string, references: ReturnType<typeof reference>[] = [], settings = {}) => newKieInputError(modelId, { prompt, references, ...settings });

test("November models are available through the shared Canvas and MCP catalogue", () => {
  const catalogue = canvasGenerationModels();
  for (const id of ["minimax-h3-image", "seedream-5-5", "gpt-image-2-6-flare", "gpt-image-2-6-sunburst", "gpt-image-2-6-economy", "kling-4-flash-keyframe", "kling-4-flash-reference", "gemini-omni-flash-1-2"]) {
    assert.ok(catalogue.some(model => model.id === id));
    const model = getKieModel(id);
    assert.equal(invalid(id), null);
    assert.ok(generationCreditCost(id, model.defaultResolution!, model.defaultDuration || "5") > 0);
  }
});

test("GPT Image 2.6 supports raster editing, with Economy's restricted request fields", () => {
  for (const variant of ["flare", "sunburst"]) {
    const id = `gpt-image-2-6-${variant}`;
    assert.deepEqual(buildKieInput(id, { prompt, resolution: "4K", aspectRatio: "3:1", background: "transparent" }, [reference()]), {
      prompt, input_urls: [reference().assetUrl], aspect_ratio: "3:1", resolution: "4K", quality: "medium", output_format: "png", background: "transparent",
    });
    assert.equal(invalid(id, [], { prompt: "a".repeat(32000) }), null);
    assert.match(invalid(id, [], { prompt: "a".repeat(32001) })!, /exceeds 32000/);
    assert.match(invalid(id, [], { background: "transparent", outputFormat: "jpeg" })!, /PNG or WebP/);
  }
  assert.deepEqual(buildKieInput("gpt-image-2-6-economy", { prompt }, []), { prompt, aspect_ratio: "auto", output_format: "png" });
  assert.match(invalid("gpt-image-2-6-economy", [], { resolution: "2K" })!, /unsupported resolution/);
  assert.match(invalid("gpt-image-2-6-economy", [], { aspectRatio: "3:4" })!, /unsupported aspect ratio/);
  assert.match(invalid("gpt-image-2-6-economy", [], { outputFormat: "webp" })!, /unsupported output format/);
});

test("Seedream 5.5 uses size tiers and bills every input image", () => {
  const id = "seedream-5-5";
  assert.deepEqual(buildKieInput(id, { prompt, resolution: "1.5K", aspectRatio: "auto" }, [reference()]), { prompt, image_urls: [reference().assetUrl], aspect_ratio: "auto", size: "1.5K", output_format: "png" });
  assert.equal(allowedKieRatios(getKieModel(id), "1.5K", false).includes("auto"), false);
  assert.match(invalid(id, [], { aspectRatio: "auto" })!, /unsupported aspect ratio/);
  assert.match(invalid(id, [], { prompt: "Hi" })!, /at least 5/);
  assert.match(newKieInputError(id, { prompt, references: [{ ...reference(), sizeBytes: 10 * 1024 * 1024 + 1 }] })!, /10 MB/);
  assert.equal(generationCreditCost(id, "1.5K", "5", 2), 7);
  assert.equal(generationCreditCost(id, "2K", "5", 10), 21);
});

test("MiniMax H3 encodes picture bindings and generation options", () => {
  const id = "minimax-h3-image";
  assert.deepEqual(newKieReferenceNames(id, [reference(), reference()]), ["<Picture 1>", "<Picture 2>"]);
  assert.deepEqual(buildKieInput(id, { prompt, seed: 42, enhancePrompt: false, outputFormat: "jpeg" }, [reference()]), {
    prompt, image_urls: [reference().assetUrl], aspect_ratio: "auto", resolution: "2K", output_format: "jpeg", expand_prompt: false, seed: 42,
  });
  assert.match(newKieInputError(id, { prompt, references: [{ ...reference(), width: 8001, height: 8000 }] })!, /64 megapixels/);
  assert.equal(generationCreditCost(id, "2K", "5", 1), 3);
  assert.equal(generationCreditCost(id, "4K", "5", 16), 14);
});

test("Kling Flash accepts only its supported ports and enforces the total video budget", () => {
  const keyframe = "kling-4-flash-keyframe";
  assert.deepEqual(buildKieInput(keyframe, { prompt: "Animate @Subject", duration: "20" }, [reference("start-frame")]), { prompt: "Animate @first_frame", duration: 20, resolution: "720p", first_frame_url: reference("start-frame").assetUrl });
  assert.match(invalid(keyframe, [reference("end-frame")])!, /unsupported input/);
  assert.match(invalid(keyframe, [reference()])!, /unsupported input/);
  assert.match(invalid(keyframe, [], { duration: "21" })!, /duration must/);
  assert.match(invalid(keyframe, [], { resolution: "1080P" })!, /unsupported resolution/);
  const id = "kling-4-flash-reference";
  assert.equal(invalid(id, [reference("reference-video", 10), reference("reference-video", 10)]), null);
  assert.match(invalid(id, [reference("reference-video", 10), reference("reference-video", 10.1)])!, /total at most 20s/);
  assert.match(invalid(id, [reference("reference-audio", 3)])!, /unsupported input/);
  const body = buildKieInput(id, { prompt: "Follow @Subject", duration: "5" }, [reference("reference-video", 3)]);
  assert.equal("voices" in body, false);
  assert.equal(body.prompt, "Follow @video_1");
  assert.equal(generationCreditCost(id, "720P", "5", 1, { hasVideoInput: true, inputVideoDurationSeconds: 3 }), 113);
});

test("Omni 1.2 omits duration in video-edit mode and uses a URL array", () => {
  const id = "gemini-omni-flash-1-2";
  assert.deepEqual(buildKieInput(id, { prompt, duration: "3", seed: 10000 }, [reference(), reference("reference-video", 12.25)]), { prompt, resolution: "720p", aspect_ratio: "16:9", image_urls: [reference().assetUrl], video_list: [reference("reference-video").assetUrl], seeds: 10000 });
  assert.equal(invalid(id, Array.from({ length: 6 }, () => reference())), null);
  assert.match(invalid(id, Array.from({ length: 7 }, () => reference()))!, /at most 6/);
  assert.match(invalid(id, [reference("reference-video", 15.01)])!, /at most 15s/);
  assert.match(invalid(id, [reference("start-frame"), reference("end-frame")], { duration: "11" })!, /at most 10 seconds/);
  assert.match(invalid(id, [reference("start-frame"), reference()])!, /cannot be combined/);
  assert.deepEqual(incompatibleReferenceRoles(id, "reference-image"), ["start-frame", "end-frame"]);
  assert.equal(generationCreditCost(id, "720P", "3", 1, { hasVideoInput: true, inputVideoDurationSeconds: 12.25 }), 111);
});

test("provider credit consumption is normalized only from a valid numeric value", () => {
  for (const credits of [0, 7.345]) assert.equal(normalizeKieTask({ data: { creditsConsumed: credits } }).providerCredits, credits);
  for (const credits of [null, "7.3", -1, Infinity, NaN]) assert.equal(normalizeKieTask({ data: { creditsConsumed: credits } }).providerCredits, undefined);
});

test("normal provider dispatch selects exact text and editing model identifiers", async t => {
  const dir = await mkdtemp(join(tmpdir(), "kie-november-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "reference.png");
  await sharp({ create: { width: 640, height: 960, channels: 3, background: "red" } }).png().toFile(path);
  for (const name of ["KIE_API_KEY", "KIE_API_KEY_FILE", "REDIS_URL"] as const) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    delete process.env[name];
  }
  process.env.KIE_API_KEY = "test-key";
  const requests: { model: string; input: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("file-stream-upload")) return Response.json({ code: 200, data: { downloadUrl: "https://example.test/reference.png" } });
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ code: 200, data: { taskId: "task" } });
  });
  const images = [{ path, mimeType: "image/png", role: "reference-image", label: "@Subject" }];
  for (const variant of ["flare", "sunburst", "economy"]) {
    for (const references of [[], images]) {
      await startGeneration({ modelId: `gpt-image-2-6-${variant}`, prompt, references });
      assert.equal(requests.at(-1)?.model, `gpt-image-2-6/${variant}-${references.length ? "image-to-image" : "text-to-image"}`);
    }
  }
  for (const [id, route] of [["minimax-h3-image", "minimax-h3/image-edit"], ["seedream-5-5", "seedream/5-5-image-to-image"]]) {
    await startGeneration({ modelId: id, prompt, references: images });
    assert.equal(requests.at(-1)?.model, route);
  }
});
