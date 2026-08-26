import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const canvasSource = readFileSync(new URL("../src/components/CanvasApp.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/components/TikTokAutomationPanel.tsx", import.meta.url), "utf8");
const legacyRouteSource = readFileSync(new URL("../src/app/api/automations/tiktok/plan/route.ts", import.meta.url), "utf8");
const workflowDetailRouteSource = readFileSync(new URL("../src/app/api/automation-workflows/[workflowId]/route.ts", import.meta.url), "utf8");
const workflowRunsSource = readFileSync(new URL("../src/lib/automation-workflows/runs.ts", import.meta.url), "utf8");

test("canvas run submission does not inject legacy built-in node ids", () => {
  for (const legacyKey of [
    "tiktok-source.source",
    "identity.identity",
    "creative-settings.mode",
    "generate-images.modelId",
  ]) assert.doesNotMatch(canvasSource, new RegExp(`['\"]${legacyKey.replace(".", "\\.")}['\"]`));
  assert.match(canvasSource, /inputs: runtimeOverrides/);
});

test("automation panel renders the selected workflow input contract", () => {
  assert.doesNotMatch(panelSource, /builtInInputKeys/);
  assert.match(panelSource, /runInputs\.map/);
  assert.match(panelSource, /runtimeValuesByWorkflow/);
  assert.match(panelSource, /selectedWorkflow\?\.publishedVersionId/);
});

test("legacy TikTok API adapts into the versioned workflow runtime instead of creating legacy jobs", () => {
  assert.match(legacyRouteSource, /enqueueAutomationWorkflowRun/);
  assert.doesNotMatch(legacyRouteSource, /enqueueTikTokAutomationJob/);
});

test("run-only roles cannot see or execute drafts and each version keeps its own input contract", () => {
  assert.match(panelSource, /capabilities\.edit/);
  assert.match(panelSource, /draftRunInputs/);
  assert.match(panelSource, /inputsFor\(productionRunInputs\)/);
  assert.match(workflowDetailRouteSource, /canViewDraft = capabilities\.edit \|\| capabilities\.publish/);
  assert.match(workflowDetailRouteSource, /draftRunInputs/);
  assert.match(workflowRunsSource, /runKind === "test".*automation\.edit/s);
});
