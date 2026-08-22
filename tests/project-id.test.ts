import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { persistedProjectIdSchema } from "../src/lib/project-id";
import { tiktokAutomationPlanSchema } from "../src/lib/tiktok-automation-runner";

const legacyProjectId = "qa-video-master-prod-20260812";

test("persisted project ids accept UUID and legacy canvas formats", () => {
  assert.equal(persistedProjectIdSchema.safeParse("00000000-0000-4000-8000-000000000001").success, true);
  assert.equal(persistedProjectIdSchema.safeParse(legacyProjectId).success, true);
});

test("persisted project ids reject empty or oversized values", () => {
  assert.equal(persistedProjectIdSchema.safeParse("   ").success, false);
  assert.equal(persistedProjectIdSchema.safeParse("x".repeat(161)).success, false);
});

test("TikTok automation accepts a legacy persisted canvas id", () => {
  const parsed = tiktokAutomationPlanSchema.safeParse({
    projectId: legacyProjectId,
    sourceNodeId: "source-node",
    sourceAssetIds: [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ],
    personaId: null,
    modelId: "nano-banana-2",
    preferences: {
      mode: "concept",
      newOutfit: true,
      newLocation: true,
      textStrategy: "rewrite",
      creativeBrief: "Keep the format",
    },
  });
  assert.equal(parsed.success, true);
});

test("canvas API schemas never require project ids to be UUIDs", () => {
  const files = [
    "../src/app/api/assets/segment/route.ts",
    "../src/app/api/assistant/route.ts",
    "../src/app/api/hooks/extract/route.ts",
    "../src/app/api/hooks/route.ts",
    "../src/app/api/import/tiktok/route.ts",
    "../src/app/api/import/tiktok/stats/route.ts",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /projectId:\s*z\.string\(\)\.uuid\(\)/, file);
    assert.doesNotMatch(source, /projectIds:\s*z\.array\(z\.string\(\)\.uuid\(\)\)/, file);
    assert.match(source, /persistedProjectIdSchema/, file);
  }
});

test("cross-canvas media uses asset access and writes derivatives into the target canvas", () => {
  const segmentRoute = readFileSync(new URL("../src/app/api/assets/segment/route.ts", import.meta.url), "utf8");
  const automationRunner = readFileSync(new URL("../src/lib/tiktok-automation-runner.ts", import.meta.url), "utf8");
  assert.match(segmentRoute, /userCanAccessAsset\(auth\.user\.id, source\.id\)/);
  assert.match(segmentRoute, /`workspaces\/\$\{workspaceId\}\/projects\/\$\{projectId\}\/video-segments`/);
  assert.doesNotMatch(segmentRoute, /WHERE id = \? AND project_id = \?/);
  assert.doesNotMatch(automationRunner, /asset\.project_id !== input\.projectId/);
  assert.match(automationRunner, /userCanAccessAsset\(userId, assetId\)/);
});
