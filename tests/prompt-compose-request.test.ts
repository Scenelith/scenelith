import assert from "node:assert/strict";
import test from "node:test";
import { promptComposeRequestSchema, promptComposeValidationMessage } from "../src/lib/prompt-compose-request";

const projectId = "00000000-0000-4000-8000-000000000001";

test("prompt assistant accepts the same upper reference bound as generation", () => {
  const references = Array.from({ length: 50 }, (_, index) => ({
    assetId: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
    token: `@reference_${index + 1}`,
    title: `Reference ${index + 1}`,
    role: "reference-image" as const,
  }));
  const parsed = promptComposeRequestSchema.safeParse({ projectId, brief: "Use these references", references });
  assert.equal(parsed.success, true);
});

test("prompt assistant accepts legacy persisted canvas ids", () => {
  const parsed = promptComposeRequestSchema.safeParse({
    projectId: "qa-video-master-prod-20260812",
    brief: "Replace the subject using the connected references",
    references: [],
  });
  assert.equal(parsed.success, true);
});

test("reference validation errors are not reported as an empty prompt", () => {
  const parsed = promptComposeRequestSchema.safeParse({
    projectId,
    brief: "Replace the subject",
    references: [{ assetId: "missing-id", token: "@subject_1", title: "Subject" }],
  });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  assert.equal(promptComposeValidationMessage(parsed.error), "One or more connected references are invalid. Reconnect them and try again.");
});

test("Video Master prompt assistant accepts scene timing, format and video duration context", () => {
  const parsed = promptComposeRequestSchema.safeParse({
    projectId,
    brief: "Use @subject_1 as the same person and preserve the source beat",
    mediaType: "video",
    modelId: "seedance-2-5",
    duration: "4",
    videoMasterContext: {
      nodeId: "master-1",
      clipId: "scene-1",
      clipTitle: "Scene 01",
      timelineDurationSeconds: 3,
      generationDurationSeconds: 4,
      sourceKind: "source-segment",
      sourceAspectRatio: "9:16",
      outputAspectRatio: "9:16",
      outputRatioChanged: false,
    },
    sceneSource: {
      assetId: "00000000-0000-4000-8000-000000000003",
      token: "@Scene_03_2",
      title: "Scene 03",
      durationSeconds: 3,
    },
    references: [{
      assetId: "00000000-0000-4000-8000-000000000002",
      token: "@subject_1",
      title: "Source scene",
      role: "reference-video",
      durationSeconds: 3,
    }],
  });
  assert.equal(parsed.success, true);
});

test("Video Master prompt assistant accepts exact fractional motion-reference duration", () => {
  assert.equal(promptComposeRequestSchema.safeParse({
    projectId,
    brief: "Replace the subject while preserving this motion",
    mediaType: "video",
    modelId: "kling-3-motion",
    duration: "7.1",
  }).success, true);
});
