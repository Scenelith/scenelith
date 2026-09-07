import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generationDispatchPayload, type GenerationAdmissionInput } from "../src/lib/generation-admission";
import { startGeneration } from "../src/lib/kie";

test("Grok Image 2 dispatch sends one direct edit task with the uploaded reference", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "grok-reference-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "reference.png");
  await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  const names = ["KIE_API_KEY", "KIE_API_KEY_FILE", "PUBLIC_URL", "REDIS_URL"] as const;
  const previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  }));
  process.env.KIE_API_KEY = "test-provider-key";
  process.env.PUBLIC_URL = "https://canvas.example.test/";
  delete process.env.KIE_API_KEY_FILE;
  delete process.env.REDIS_URL;
  const uploadedUrl = "https://uploads.example.test/reference.png";
  const requests: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    assert.equal(init?.method, "POST");
    if (address === "https://kieai.redpandaai.co/api/file-stream-upload") {
      assert.ok(init?.body instanceof FormData);
      assert.ok(init.body.get("file") instanceof Blob);
      requests.push({ url: address, body: "upload" });
      return Response.json({ code: 200, data: { downloadUrl: uploadedUrl } });
    }
    assert.equal(address, "https://api.kie.ai/api/v1/jobs/createTask", "unexpected provider request");
    requests.push({ url: address, body: JSON.parse(String(init?.body)) });
    return Response.json({ code: 200, data: { taskId: "direct-task", state: "generating" } });
  });
  const admission: GenerationAdmissionInput = {
    userId: "user", projectId: "canvas", nodeId: "image-generator", operation: "generation",
    model: { id: "grok-image-2", mediaType: "image", providerPath: "/api/v1/jobs/createTask" },
    prompt: "Keep the reference composition and change the wall to blue.",
    references: [{ path, mimeType: "image/png", label: "@Source_1", role: "reference-image" }],
    aspectRatio: "9:16", resolution: "1K", duration: "5", generateAudio: false,
    hasVideoInput: false, inputVideoDurationSeconds: 0,
  };
  const payload = generationDispatchPayload(admission);
  assert.equal("providerWorkflow" in payload, false);
  const task = await startGeneration(payload);
  assert.equal(task.task_id, "direct-task");
  assert.equal(requests.length, 2, "one upload and exactly one generation request");
  const editBody = {
    model: "grok-imagine-image-2-0/image-edit",
    callBackUrl: "https://canvas.example.test/api/webhooks/kie",
    input: { prompt: admission.prompt, aspect_ratio: "9:16", image_urls: [uploadedUrl] },
  };
  assert.deepEqual(requests[1].body, editBody);

  // Jobs queued before an upgrade may still carry the obsolete workflow data.
  // Their original reference must still be uploaded/sent, without a segment task.
  for (const stage of ["segment-map", "image-edit"]) {
    const queued = { ...payload, providerWorkflow: { kind: "grok-image-edit", stage, segmentTaskId: "old-segment" } };
    const before = requests.length;
    await startGeneration(queued);
    assert.equal(requests.length, before + 1, "cached reference needs only one direct task");
    assert.deepEqual(requests.at(-1)?.body, editBody);
  }

  const beforeText = requests.length;
  await startGeneration(generationDispatchPayload({ ...admission, references: [] }));
  assert.equal(requests.length, beforeText + 1, "text-only generation does not upload a reference");
  assert.deepEqual(requests.at(-1)?.body, {
    model: "grok-imagine-image-2-0/text-to-image",
    callBackUrl: "https://canvas.example.test/api/webhooks/kie",
    input: { prompt: admission.prompt, aspect_ratio: "9:16" },
  });
  const beforeRejected = requests.length;
  await assert.rejects(startGeneration({ ...payload, references: [...payload.references, ...payload.references] }), /accepts at most 1 reference inputs/);
  assert.equal(requests.length, beforeRejected, "invalid reference counts never reach the provider");
});
