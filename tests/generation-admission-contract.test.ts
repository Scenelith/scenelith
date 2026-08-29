import assert from "node:assert/strict";
import { test } from "node:test";
import { generationDispatchPayload, type GenerationAdmissionInput } from "../src/lib/generation-admission";

test("generation admission forwards user-controlled payload fields without rewriting them", () => {
  const input: GenerationAdmissionInput = {
    userId: "user",
    projectId: "project",
    nodeId: "automation-run-slide-1",
    prompt: '{"task":"Exact user-authored request"}',
    model: { id: "nano-banana-2", mediaType: "image", providerPath: "/api/v1/jobs/createTask" },
    references: [{ path: "workspace/source.png", mimeType: "image/png", role: "reference-image", label: "@Source_1" }],
    operation: "generation",
    aspectRatio: "9:16",
    resolution: "1K",
    duration: "5",
    generateAudio: false,
    hasVideoInput: false,
    inputVideoDurationSeconds: 0,
  };
  assert.deepEqual(generationDispatchPayload(input), {
    modelId: "nano-banana-2",
    prompt: input.prompt,
    references: input.references,
    aspectRatio: "9:16",
    resolution: "1K",
    duration: "5",
    generateAudio: false,
    providerWorkflow: undefined,
    targetClipId: undefined,
    targetSourceAssetId: undefined,
  });
});
