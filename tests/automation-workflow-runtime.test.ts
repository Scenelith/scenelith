import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAutomationGraph, type AutomationNodeHandlers } from "../src/lib/automation-workflows/runtime";
import { buildAutomationGenerationPrompt, coreAutomationNodeHandlers } from "../src/lib/automation-workflows/node-handlers";
import { createDefaultTikTokWorkflowGraph } from "../src/lib/automation-workflows/default-tiktok";
import { AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION, AUTOMATION_NO_TEXT_AVOID_INSTRUCTION, AUTOMATION_SOURCE_REFERENCE_INSTRUCTION } from "../src/lib/generation-prompt-contract";
import { validateAutomationStructuredValue } from "../src/lib/automation-workflows/json-schema";
import { parseAutomationSlidePlanSet } from "../src/lib/automation-workflows/slide-plan-contract";
import type { AutomationWorkflowGraph } from "../src/lib/automation-workflows/types";
import { validateAutomationWorkflowGraph } from "../src/lib/automation-workflows/validation";
import { DEFAULT_AUTOMATION_CREATIVE_CONTROLS } from "../src/lib/automation-workflows/creative-direction-contract";

const context = { runId: "run", userId: "user", workspaceId: "workspace", projectId: "project", runtimeInputs: { "source.source": "canvas-source" } };

function checkedPlanSet() {
  return {
    schemaVersion: 2 as const,
    contract: null,
    decisions: null,
    slides: [{
      index: 1,
      role: "scene",
      prompt: {
        title: "Slide 1",
        task: "Create slide 1.",
        reference_plan: [{ token: "@Source_composition_1_1", title: "Source composition 1", role: "source composition", instruction: AUTOMATION_SOURCE_REFERENCE_INSTRUCTION }],
        subject: { identity: "", appearance: [], pose: "source pose", expression: "natural" },
        scene: { environment: "source", composition: "source", lighting: "source", camera: "source" },
        preserve: ["Preserve the source composition."],
        change: [], avoid: [], output: { format: "image", style: "source" },
      },
      referenceAssetIds: [],
      text: { strategy: "keep" as const, sourceText: "", overlayText: "", instruction: "Keep the source without adding text." },
      confidence: 1,
    }],
  };
}

function linearGraph(aiConfig: Record<string, unknown> = {}): AutomationWorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "run", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "source", type: "input.tiktok-source", version: 1, name: "Source", description: "", position: { x: 100, y: 0 }, groupId: null, config: { source: "source" }, bindings: {}, disabled: false },
      { id: "plan", type: "ai.structured-task", version: 2, name: "Plan", description: "", position: { x: 200, y: 0 }, groupId: null, config: { modelId: "google/gemini-3.7-flash", userPrompt: "Create the plan.", ...aiConfig }, bindings: {}, disabled: false },
      { id: "validate", type: "logic.validate-slide-plans", version: 1, name: "Validate", description: "", position: { x: 300, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "generate", type: "generation.image", version: 1, name: "Generate", description: "", position: { x: 400, y: 0 }, groupId: null, config: { modelId: "image-model" }, bindings: {}, disabled: false },
      { id: "output", type: "output.add-to-canvas", version: 1, name: "Output", description: "", position: { x: 500, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    ],
    edges: [
      { id: "a", source: "run", sourcePort: "run", target: "source", targetPort: "run" },
      { id: "b", source: "source", sourcePort: "source", target: "plan", targetPort: "primary" },
      { id: "c", source: "plan", sourcePort: "result", target: "validate", targetPort: "data" },
      { id: "c-validated", source: "validate", sourcePort: "plans", target: "generate", targetPort: "plans" },
      { id: "d", source: "source", sourcePort: "source", target: "generate", targetPort: "source" },
      { id: "e", source: "generate", sourcePort: "assets", target: "output", targetPort: "assets" },
    ],
    groups: [],
  };
}

test("runtime resolves ask-on-run values and carries typed outputs in dependency order", async () => {
  const graph: AutomationWorkflowGraph = {
    schemaVersion: 1,
    nodes: [
      { id: "run", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "source", type: "input.tiktok-source", version: 1, name: "Source", description: "", position: { x: 100, y: 0 }, groupId: null, config: {}, bindings: { source: { mode: "ask-on-run", required: true, label: "Source" } }, disabled: false },
      { id: "plan", type: "ai.structured-task", version: 2, name: "Plan", description: "", position: { x: 200, y: 0 }, groupId: null, config: { modelId: "google/gemini-3.7-flash", userPrompt: "Create the plan." }, bindings: {}, disabled: false },
      { id: "validate", type: "logic.validate-slide-plans", version: 1, name: "Validate", description: "", position: { x: 300, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "generate", type: "generation.image", version: 1, name: "Generate", description: "", position: { x: 400, y: 0 }, groupId: null, config: { modelId: "image-model" }, bindings: {}, disabled: false },
      { id: "output", type: "output.add-to-canvas", version: 1, name: "Output", description: "", position: { x: 500, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    ],
    edges: [
      { id: "a", source: "run", sourcePort: "run", target: "source", targetPort: "run" },
      { id: "b", source: "source", sourcePort: "source", target: "plan", targetPort: "primary" },
      { id: "c", source: "plan", sourcePort: "result", target: "validate", targetPort: "data" },
      { id: "c-validated", source: "validate", sourcePort: "plans", target: "generate", targetPort: "plans" },
      { id: "c-source", source: "source", sourcePort: "source", target: "generate", targetPort: "source" },
      { id: "d", source: "generate", sourcePort: "assets", target: "output", targetPort: "assets" },
      { id: "e", source: "source", sourcePort: "source", target: "output", targetPort: "source" },
    ],
    groups: [],
  };
  const calls: string[] = [];
  const handlers: AutomationNodeHandlers = {
    "core.manual-trigger@1": async () => { calls.push("run"); return { run: { id: "run" } }; },
    "input.tiktok-source@1": async ({ config }) => { calls.push("source"); return { source: { id: config.source } }; },
    "ai.structured-task@2": async ({ inputs }) => { calls.push("plan"); return { result: inputs.primary }; },
    "logic.validate-slide-plans@1": async () => { calls.push("validate"); return { plans: checkedPlanSet() }; },
    "generation.image@1": async ({ inputs }) => { calls.push("generate"); return { assets: inputs.plans }; },
    "output.add-to-canvas@1": async ({ inputs }) => { calls.push("output"); return { result: inputs.source }; },
  };
  const result = await executeAutomationGraph({ graph, context, handlers });
  assert.deepEqual(calls, ["run", "source", "plan", "validate", "generate", "output"]);
  assert.deepEqual(result.outputs.get("output")?.result, { id: "canvas-source" });
});

test("runtime resumes from durable completed node outputs", async () => {
  const graph: AutomationWorkflowGraph = {
    schemaVersion: 1,
    nodes: [
      { id: "run", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "source", type: "input.tiktok-source", version: 1, name: "Source", description: "", position: { x: 100, y: 0 }, groupId: null, config: { source: "saved-source" }, bindings: {}, disabled: false },
      { id: "validate", type: "logic.validate-slide-plans", version: 1, name: "Validate", description: "", position: { x: 200, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "generate", type: "generation.image", version: 1, name: "Generate", description: "", position: { x: 300, y: 0 }, groupId: null, config: { modelId: "image-model" }, bindings: {}, disabled: false },
      { id: "output", type: "output.add-to-canvas", version: 1, name: "Output", description: "", position: { x: 400, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    ],
    edges: [
      { id: "a", source: "run", sourcePort: "run", target: "source", targetPort: "run" },
      { id: "b", source: "source", sourcePort: "source", target: "validate", targetPort: "data" },
      { id: "b-validated", source: "validate", sourcePort: "plans", target: "generate", targetPort: "plans" },
      { id: "c", source: "source", sourcePort: "source", target: "generate", targetPort: "source" },
      { id: "d", source: "generate", sourcePort: "assets", target: "output", targetPort: "assets" },
      { id: "e", source: "source", sourcePort: "source", target: "output", targetPort: "source" },
    ],
    groups: [],
  };
  const calls: string[] = [];
  const initialOutputs = new Map<string, Record<string, unknown>>([
    ["run", { run: { id: "saved-run" } }],
    ["source", { source: { id: "saved-source" } }],
    ["validate", { plans: checkedPlanSet() }],
    ["generate", { assets: { items: [] } }],
  ]);
  const result = await executeAutomationGraph({
    graph,
    context,
    initialOutputs,
    handlers: {
      "core.manual-trigger@1": async () => { calls.push("run"); return { run: {} }; },
      "input.tiktok-source@1": async () => { calls.push("source"); return { source: {} }; },
      "output.add-to-canvas@1": async ({ inputs }) => { calls.push("output"); return { result: inputs.source }; },
    },
  });
  assert.deepEqual(calls, ["output"]);
  assert.deepEqual(result.outputs.get("output")?.result, { id: "saved-source" });
});

test("runtime exposes the retry attempt so handlers can switch to a fallback", async () => {
  const graph: AutomationWorkflowGraph = {
    schemaVersion: 1,
    nodes: [
      { id: "run", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "source", type: "input.tiktok-source", version: 1, name: "Source", description: "", position: { x: 100, y: 0 }, groupId: null, config: { source: "source" }, bindings: {}, disabled: false },
      { id: "plan", type: "ai.structured-task", version: 2, name: "Plan", description: "", position: { x: 200, y: 0 }, groupId: null, config: { modelId: "google/gemini-3.7-flash", userPrompt: "Create the plan.", maxAttempts: 2 }, bindings: {}, disabled: false },
      { id: "validate", type: "logic.validate-slide-plans", version: 1, name: "Validate", description: "", position: { x: 300, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "generate", type: "generation.image", version: 1, name: "Generate", description: "", position: { x: 400, y: 0 }, groupId: null, config: { modelId: "image-model" }, bindings: {}, disabled: false },
      { id: "output", type: "output.add-to-canvas", version: 1, name: "Output", description: "", position: { x: 500, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    ],
    edges: [
      { id: "a", source: "run", sourcePort: "run", target: "source", targetPort: "run" },
      { id: "b", source: "source", sourcePort: "source", target: "plan", targetPort: "primary" },
      { id: "c", source: "plan", sourcePort: "result", target: "validate", targetPort: "data" },
      { id: "c-validated", source: "validate", sourcePort: "plans", target: "generate", targetPort: "plans" },
      { id: "d", source: "source", sourcePort: "source", target: "generate", targetPort: "source" },
      { id: "e", source: "generate", sourcePort: "assets", target: "output", targetPort: "assets" },
    ],
    groups: [],
  };
  const attempts: number[] = [];
  await executeAutomationGraph({
    graph,
    context,
    handlers: {
      "core.manual-trigger@1": async () => ({ run: {} }),
      "input.tiktok-source@1": async () => ({ source: {} }),
      "ai.structured-task@2": async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt === 1) throw new Error("retry");
        return { result: {} };
      },
      "logic.validate-slide-plans@1": async () => ({ plans: checkedPlanSet() }),
      "generation.image@1": async () => ({ assets: {} }),
      "output.add-to-canvas@1": async () => ({ result: {} }),
    },
  });
  assert.deepEqual(attempts, [1, 2]);
});

test("runtime cancellation interrupts an active node instead of waiting for it to finish", async () => {
  const controller = new AbortController();
  const graph: AutomationWorkflowGraph = {
    schemaVersion: 1,
    groups: [],
    nodes: [
      { id: "run", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 200, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    ],
    edges: [{ id: "edge", source: "run", sourcePort: "run", target: "finish", targetPort: "data" }],
  };
  let finishStarted!: () => void;
  const started = new Promise<void>((resolve) => { finishStarted = resolve; });
  const execution = executeAutomationGraph({
    graph,
    context: { ...context, signal: controller.signal },
    handlers: {
      "core.manual-trigger@1": async () => ({ run: {} }),
      "output.finish@1": async ({ context: executionContext }) => {
        finishStarted();
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          executionContext.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Automation cancelled"), { code: "RUN_CANCELLED" })), { once: true });
        });
      },
    },
  });
  await started;
  controller.abort();
  await assert.rejects(execution, (error: unknown) => (error as { code?: string }).code === "RUN_CANCELLED");
});

test("automation generation uses the same structured JSON contract as Canvas Assistant", () => {
  const result = buildAutomationGenerationPrompt(
    {
      index: 1,
      role: "hook",
      prompt: {
        title: "Kitchen portrait",
        task: "Create a kitchen portrait.",
        reference_plan: [
          { token: "@Source_composition_1_1", title: "Source composition 1", role: "source composition", instruction: AUTOMATION_SOURCE_REFERENCE_INSTRUCTION },
          { token: "@Identity_reference_1_2", title: "Identity reference 1", role: "identity", instruction: AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION },
        ],
        subject: { identity: "Maya", appearance: ["new black outfit"], pose: "mirror selfie", expression: "relaxed" },
        scene: { environment: "same kitchen", composition: "vertical medium portrait", lighting: "window light", camera: "phone camera" },
        preserve: ["Preserve the exact kitchen."],
        change: ["Render exactly this on-screen text: \"Day one\"."],
        avoid: ["Do not copy identity from the source composition."],
        output: { format: "9:16 image", style: "candid phone photo" },
      },
      referenceAssetIds: ["person"],
      text: { strategy: "rewrite", sourceText: "Last year", overlayText: "Day one", instruction: "Erase old typography and render only Day one." },
      confidence: 1,
    },
    [
      { assetId: "source", path: "source.png", mimeType: "image/png", role: "reference-image", label: "Source composition 1" },
      { assetId: "person", path: "person.png", mimeType: "image/png", role: "reference-image", label: "Identity reference 1" },
    ],
  );
  const prompt = JSON.parse(result.prompt);
  assert.deepEqual(Object.keys(prompt), ["title", "task", "reference_plan", "subject", "scene", "preserve", "change", "avoid", "output"]);
  assert.equal(prompt.reference_plan[0].role, "source composition");
  assert.equal(prompt.reference_plan[1].role, "identity");
  assert.equal(prompt.change[0], "Render exactly this on-screen text: \"Day one\".");
  assert.equal(result.references[0].label, "@Source_composition_1_1");
  assert.equal(result.references[1].label, "@Identity_reference_1_2");
});

test("slide-plan boundary rejects every legacy wrapper, alias and plain-prompt shape", () => {
  const slide = {
    index: 1,
    role: "hook",
    prompt: {
      title: "Opening",
      task: "Recreate the opening portrait.",
      reference_plan: [{ token: "@Source_composition_1_1", title: "Source composition 1", role: "source composition", instruction: AUTOMATION_SOURCE_REFERENCE_INSTRUCTION }],
      subject: { identity: "", appearance: [], pose: "source pose", expression: "relaxed" },
      scene: { environment: "source hallway", composition: "source framing", lighting: "ambient", camera: "phone" },
      preserve: ["Preserve the source composition."],
      change: [],
      avoid: [],
      output: { format: "9:16 image", style: "candid phone photo" },
    },
    referenceAssetIds: [],
    text: { strategy: "keep", sourceText: "", overlayText: "", instruction: "Keep the source without adding text." },
    confidence: 1,
  };
  const checked = { schemaVersion: 2, contract: null, decisions: null, slides: [slide] };
  assert.deepEqual(parseAutomationSlidePlanSet(checked), checked);
  assert.throws(() => parseAutomationSlidePlanSet({ selected: checked }), /one supported slide-plan contract/);
  assert.throws(() => parseAutomationSlidePlanSet({ value: checked }), /one supported slide-plan contract/);
  assert.throws(() => parseAutomationSlidePlanSet({ ...checked, slides: [{ ...slide, referenceAssetIds: undefined, referenceIds: [] }] }), /referenceAssetIds is required|referenceIds is not allowed/);
  assert.throws(() => parseAutomationSlidePlanSet({ ...checked, slides: [{ ...slide, prompt: "Recreate the opening portrait." }] }), /prompt must be an object/);
});

test("continue-one-path passes one result unchanged and rejects ambiguous joins", async () => {
  const handler = coreAutomationNodeHandlers()["logic.select-one@1"];
  const execution = {
    node: { id: "select", type: "logic.select-one", version: 1, name: "Continue one path", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: {}, attempt: 1, context, outputsByNode: new Map<string, Record<string, unknown>>(),
  };
  const exact = { slides: [{ index: 1, referenceAssetIds: ["person"] }] };
  assert.deepEqual(await handler({ ...execution, inputs: { data: [exact] } }), { result: exact });
  await assert.rejects(handler({ ...execution, inputs: { data: [] } }), /exactly one completed input/);
  await assert.rejects(handler({ ...execution, inputs: { data: [exact, exact] } }), /exactly one completed input/);
});

test("select-information returns the exact nested value and never guesses another path", async () => {
  const handler = coreAutomationNodeHandlers()["logic.select-path@1"];
  const execution = {
    node: { id: "select", type: "logic.select-path", version: 1, name: "Select information", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    attempt: 1, context, outputsByNode: new Map<string, Record<string, unknown>>(),
  };
  const plans = { slides: [{ index: 1, referenceAssetIds: [] }] };
  assert.deepEqual(await handler({ ...execution, config: { path: "review.plans" }, inputs: { data: { review: { plans }, selected: "legacy" } } }), { result: plans });
  await assert.rejects(handler({ ...execution, config: { path: "review.missing" }, inputs: { data: { review: { plans }, selected: "legacy" } } }), /could not find/);
});

test("creative direction accepts only complete exact-evidence contracts and configurable choices", async () => {
  const handlers = coreAutomationNodeHandlers();
  const prepare = handlers["logic.prepare-creative-direction@1"];
  const resolve = handlers["logic.resolve-creative-direction@2"];
  const base = { attempt: 1, context, outputsByNode: new Map<string, Record<string, unknown>>() };
  const settings = { mode: "concept", newOutfit: false, newLocation: true, textStrategy: "rewrite", creativeBrief: "Keep the same room, remove text and make it warm.", creativeDirectionPolicy: "auto-explicit" };
  const prepared = await prepare({
    ...base,
    node: { id: "prepare", type: "logic.prepare-creative-direction", version: 1, name: "Prepare", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: { controls: DEFAULT_AUTOMATION_CREATIVE_CONTROLS, minConfidence: 0.9, maxClauses: 16, maxRequirements: 24 },
    inputs: { settings, source: { slides: [{ index: 1 }, { index: 2 }] } },
  });
  const request = prepared.request as { briefHash: string; clauses: Array<{ id: string; text: string }> };
  const clauseId = request.clauses[0].id;
  const withSpan = (evidence: string, item: Record<string, unknown>) => {
    const evidenceStart = request.clauses[0].text.indexOf(evidence);
    return { ...item, evidence, evidenceStart, evidenceEnd: evidenceStart + evidence.length };
  };
  const analysis = { briefHash: request.briefHash, clauseResults: [{ clauseId, items: [
    withSpan("Keep the same room", { kind: "choice", controlId: "location-setting", optionId: "preserve", instruction: "", category: "", placement: "", slideIndexes: [], confidence: 1, reason: "" }),
    withSpan("remove text", { kind: "choice", controlId: "on-screen-text", optionId: "remove", instruction: "", category: "", placement: "", slideIndexes: [], confidence: 1, reason: "" }),
    withSpan("make it warm", { kind: "requirement", controlId: "", optionId: "", instruction: "make it warm", category: "tone", placement: "change", slideIndexes: [], confidence: 1, reason: "" }),
  ] }] };
  const execution = {
    ...base,
    node: { id: "resolve", type: "logic.resolve-creative-direction", version: 2, name: "Resolve", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: {}, inputs: { request, analysis },
  };
  const result = await resolve(execution);
  const resolved = result.resolved as Record<string, unknown>;
  assert.equal(resolved.newLocation, false);
  assert.equal(resolved.textStrategy, "remove");
  assert.equal(resolved.newOutfit, false, "unmentioned choices must remain unchanged");
  const requirements = (resolved.direction as { requirements: Array<{ id: string; evidence: string }> }).requirements;
  assert.equal(requirements.length, 1);
  assert.match(requirements[0].id, /^creative-direction-[a-f0-9]{16}$/);
  assert.equal(requirements[0].evidence, "make it warm");

  const inventedEvidence = await resolve({ ...execution, inputs: { request, analysis: { ...analysis, clauseResults: [{ clauseId, items: [{ ...analysis.clauseResults[0].items[0], evidence: "keep the same room" }] }] } } });
  assert.match(String((inventedEvidence.conflict as { message: string }).message), /exact phrase/);

  const inventedInstruction = await resolve({ ...execution, inputs: { request, analysis: { ...analysis, clauseResults: [{ clauseId, items: analysis.clauseResults[0].items.map((item) => item.kind === "requirement" ? { ...item, instruction: "Show a 50% discount" } : item) }] } } });
  assert.match(String((inventedInstruction.conflict as { message: string }).message), /incomplete creative requirement/);

  const missingCoverage = await resolve({ ...execution, inputs: { request, analysis: { briefHash: request.briefHash, clauseResults: [] } } });
  assert.match(String((missingCoverage.conflict as { message: string }).message), /every creative-direction clause/);

  await assert.rejects(prepare({
    ...base,
    node: { id: "prepare", type: "logic.prepare-creative-direction", version: 1, name: "Prepare", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: { controls: DEFAULT_AUTOMATION_CREATIVE_CONTROLS },
    inputs: { settings: { ...settings, newLocation: "false" }, source: { slides: [{ index: 1 }] } },
  }), /no single selected option/);

  const customControls = [{ id: "language", label: "Output language", path: "campaign.language", options: [{ id: "english", label: "English", value: "en", matchPhrases: ["English"] }, { id: "french", label: "French", value: "fr", matchPhrases: ["French"] }] }];
  const customPrepared = await prepare({
    ...base,
    node: { id: "prepare", type: "logic.prepare-creative-direction", version: 1, name: "Prepare", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: { controls: customControls },
    inputs: { settings: { campaign: { language: "en" }, creativeBrief: "Use French.", creativeDirectionPolicy: "auto-explicit" }, source: { slides: [{ index: 1 }] } },
  });
  const customRequest = customPrepared.request as { briefHash: string; clauses: Array<{ id: string }> };
  const customEvidence = "Use French";
  const customResult = await resolve({
    ...execution,
    inputs: { request: customRequest, analysis: { briefHash: customRequest.briefHash, clauseResults: [{ clauseId: customRequest.clauses[0].id, items: [{ kind: "choice", evidence: customEvidence, evidenceStart: 0, evidenceEnd: customEvidence.length, controlId: "language", optionId: "french", instruction: "", category: "", placement: "", slideIndexes: [], confidence: 1, reason: "" }] }] } },
  });
  assert.equal(((customResult.resolved as { campaign: { language: string } }).campaign.language), "fr", "custom user-authored controls must work without hardcoded fields");

  const negatedPrepared = await prepare({
    ...base,
    node: { id: "prepare", type: "logic.prepare-creative-direction", version: 1, name: "Prepare", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: { controls: DEFAULT_AUTOMATION_CREATIVE_CONTROLS },
    inputs: { settings: { ...settings, creativeBrief: "Do not remove text." }, source: { slides: [{ index: 1 }] } },
  });
  const negatedRequest = negatedPrepared.request as { briefHash: string; clauses: Array<{ id: string }> };
  const negatedEvidence = "Do not remove text";
  const negatedResult = await resolve({ ...execution, inputs: { request: negatedRequest, analysis: { briefHash: negatedRequest.briefHash, clauseResults: [{ clauseId: negatedRequest.clauses[0].id, items: [{ kind: "choice", evidence: negatedEvidence, evidenceStart: 0, evidenceEnd: negatedEvidence.length, controlId: "on-screen-text", optionId: "remove", instruction: "", category: "", placement: "", slideIndexes: [], confidence: 1, reason: "" }] }] } } });
  assert.match(String((negatedResult.conflict as { message: string }).message), /recognition phrases/, "negation must not be accepted as the opposite option just because it contains the same words");
});

test("slide validator carries immutable choices, exact text and reference roles into generation", async () => {
  const wardrobeInstruction = "Create a visibly new wardrobe on every applicable slide.";
  const locationInstruction = "Preserve the exact source location and room layout.";
  const adaptationPreserveInstruction = "Keep the source concept.";
  const adaptationChangeInstruction = "Change the person.";
  const textInstruction = "Remove and erase every existing word; do not render replacement text.";
  const writtenInstruction = "Use a warm, candid tone suitable for women 25–35.";
  const writtenRequirement = { id: "creative-direction-1", instruction: writtenInstruction, evidence: "make it warm for women 25–35", category: "tone", placement: "change", slideIndexes: [] };
  const contract = {
    sourceAnalysis: { slides: [{ index: 1, visibleText: "last year..." }] },
    choices: {
      settings: { mode: "identity", newOutfit: true, newLocation: false, textStrategy: "remove", direction: { requirements: [writtenRequirement] } },
      adaptation: { adaptation: { mode: "identity", preserveInstruction: adaptationPreserveInstruction, changeInstruction: adaptationChangeInstruction } },
      wardrobe: { wardrobe: { mode: "change", instruction: wardrobeInstruction } },
      location: { location: { mode: "preserve", instruction: locationInstruction } },
    },
    brief: { requirements: [writtenRequirement], decisions: { newOutfit: true, newLocation: false, textStrategy: "remove" } },
    copy: { slides: [{ index: 1, sourceText: "last year...", overlayText: "", strategy: "remove", instruction: textInstruction, copyFunction: "hook" }] },
    references: { slides: [{ index: 1, references: [{ assetId: "person", title: "Maya identity", role: "identity", instruction: AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION }] }] },
  };
  const plans = { slides: [{
    index: 1,
    role: "hook",
    prompt: {
      title: "Opening",
      task: "Recreate the opening portrait with the selected identity.",
      reference_plan: [
        { token: "@Source_composition_1_1", title: "Source composition 1", role: "source composition", instruction: AUTOMATION_SOURCE_REFERENCE_INSTRUCTION },
        { token: "@Maya_identity_2", title: "Maya identity", role: "identity", instruction: AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION },
      ],
      subject: { identity: "Maya", appearance: ["visibly new outfit"], pose: "source pose", expression: "relaxed" },
      scene: { environment: "source hallway", composition: "source framing", lighting: "ambient", camera: "phone" },
      preserve: [adaptationPreserveInstruction, locationInstruction],
      change: [adaptationChangeInstruction, wardrobeInstruction, textInstruction, writtenInstruction],
      avoid: [AUTOMATION_NO_TEXT_AVOID_INSTRUCTION],
      output: { format: "9:16 image", style: "candid phone photo" },
    },
    referenceAssetIds: ["person"],
    text: { strategy: "remove", sourceText: "last year...", overlayText: "", instruction: textInstruction },
    confidence: 0.95,
  }] };
  const validate = coreAutomationNodeHandlers()["logic.validate-slide-plans@1"];
  const result = await validate({
    node: { id: "validate", type: "logic.validate-slide-plans", version: 1, name: "Validate", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: { maxSlides: 40 },
    inputs: { data: plans, contract, source: { slides: [{ index: 1, assetId: "source" }] }, identity: { assets: [{ id: "person" }] }, references: { assets: [] } },
    attempt: 1,
    context,
    outputsByNode: new Map(),
  });
  const validated = result.plans as { decisions: Record<string, unknown>; slides: Array<Record<string, unknown>> };
  assert.deepEqual(validated.decisions, { newOutfit: true, newLocation: false, textStrategy: "remove" });
  assert.deepEqual(validated.slides[0].prompt, plans.slides[0].prompt, "validator must not author or rewrite the model prompt");
  const slide = validated.slides[0] as { prompt: { preserve: string[]; change: string[]; avoid: string[]; reference_plan: unknown[] } };
  assert.ok(slide.prompt.preserve.includes(locationInstruction));
  assert.ok(slide.prompt.change.includes(wardrobeInstruction));
  assert.ok(slide.prompt.change.includes(textInstruction));
  assert.ok(slide.prompt.change.includes(writtenInstruction));
  assert.ok(slide.prompt.avoid.some((value) => /No captions/i.test(value)));
  assert.deepEqual(slide.prompt.reference_plan[1], { token: "@Maya_identity_2", title: "Maya identity", role: "identity", instruction: AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION });
  const reparsedForGeneration = parseAutomationSlidePlanSet(result.plans);
  assert.deepEqual(reparsedForGeneration.slides[0], plans.slides[0], "generation must consume the exact checked slide-plan format without renaming fields");
  const generationInput = buildAutomationGenerationPrompt(reparsedForGeneration.slides[0], [
    { assetId: "source", path: "source.png", mimeType: "image/png", role: "reference-image", label: "Source composition 1" },
    { assetId: "person", path: "person.png", mimeType: "image/png", role: "reference-image", label: "Maya identity" },
  ]);
  assert.deepEqual(JSON.parse(generationInput.prompt), plans.slides[0].prompt, "serialized provider payload must equal the model-authored prompt byte-for-byte by value");
  await assert.rejects(validate({
    node: { id: "validate", type: "logic.validate-slide-plans", version: 1, name: "Validate", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: { maxSlides: 40 },
    inputs: { data: { slides: [{ ...plans.slides[0], prompt: { ...plans.slides[0].prompt, change: [adaptationChangeInstruction, textInstruction] } }] }, contract, source: { slides: [{ index: 1, assetId: "source" }] }, identity: { assets: [{ id: "person" }] }, references: { assets: [] } },
    attempt: 1,
    context,
    outputsByNode: new Map(),
  }), /model omitted the exact wardrobe instruction/);
  await assert.rejects(validate({
    node: { id: "validate", type: "logic.validate-slide-plans", version: 1, name: "Validate", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: { maxSlides: 40 },
    inputs: { data: { slides: [{ ...plans.slides[0], prompt: { ...plans.slides[0].prompt, change: [adaptationChangeInstruction, wardrobeInstruction, textInstruction] } }] }, contract, source: { slides: [{ index: 1, assetId: "source" }] }, identity: { assets: [{ id: "person" }] }, references: { assets: [] } },
    attempt: 1,
    context,
    outputsByNode: new Map(),
  }), /omitted creative direction requirement creative-direction-1/);
});

test("slide validator rejects identity references assigned to wardrobe", async () => {
  const validate = coreAutomationNodeHandlers()["logic.validate-slide-plans@1"];
  const contract = {
    sourceAnalysis: { slides: [{ index: 1, visibleText: "" }] },
    choices: {
      settings: { mode: "identity", newOutfit: false, newLocation: false, textStrategy: "keep" },
      adaptation: { adaptation: { mode: "identity", preserveInstruction: "Keep the concept.", changeInstruction: "Change the person." } },
      wardrobe: { wardrobe: { mode: "preserve", instruction: "Preserve wardrobe." } },
      location: { location: { mode: "preserve", instruction: "Preserve location." } },
    },
    brief: { decisions: { newOutfit: false, newLocation: false, textStrategy: "keep" } },
    copy: { slides: [{ index: 1, sourceText: "", overlayText: "", strategy: "keep", instruction: "Keep no on-screen text.", copyFunction: "visual" }] },
    references: { slides: [{ index: 1, references: [{ assetId: "person", title: "Maya", role: "outfit", instruction: "Copy the outfit." }] }] },
  };
  const slide = {
    index: 1, role: "scene",
    prompt: {
      title: "Scene", task: "Recreate scene.",
      reference_plan: [
        { token: "@Source_composition_1_1", title: "Source composition 1", role: "source composition", instruction: AUTOMATION_SOURCE_REFERENCE_INSTRUCTION },
        { token: "@Maya_2", title: "Maya", role: "outfit", instruction: "Copy the outfit." },
      ],
      subject: { identity: "Maya", appearance: [], pose: "same", expression: "same" },
      scene: { environment: "same", composition: "same", lighting: "same", camera: "same" },
      preserve: [], change: [], avoid: [], output: { format: "image", style: "candid" },
    },
    referenceAssetIds: ["person"],
    text: { strategy: "keep", sourceText: "", overlayText: "", instruction: "Keep no on-screen text." },
    confidence: 1,
  };
  await assert.rejects(validate({
    node: { id: "validate", type: "logic.validate-slide-plans", version: 1, name: "Validate", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: {}, inputs: { data: { slides: [slide] }, contract, source: { slides: [{ index: 1 }] }, identity: { assets: [{ id: "person" }] }, references: { assets: [] } }, attempt: 1, context, outputsByNode: new Map(),
  }), /control outfit/);
});

test("AI workflow steps fail explicitly instead of silently truncating connected data", async () => {
  const runAi = coreAutomationNodeHandlers()["ai.structured-task@2"];
  await assert.rejects(runAi({
    node: { id: "ai", type: "ai.structured-task", version: 2, name: "AI", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    config: { modelId: "google/gemini-3.7-flash", userPrompt: "Summarize the connected information." },
    inputs: { primary: { exactData: "x".repeat(81_000) } },
    attempt: 1,
    context,
    outputsByNode: new Map(),
  }), (error: unknown) => (error as { code?: string }).code === "AI_CONTEXT_LIMIT");
});

test("default automation keeps every selected rule through an approved no-repair path", async () => {
  const wardrobeInstruction = "Create a visibly new wardrobe or visibly new subjects on every applicable slide. Do not reuse the source clothing, accessories or styling, and do not take wardrobe from identity references.";
  const locationInstruction = "Preserve the exact location, background, environment, room layout and visible setting details from each slide's source image. Identity references must not contribute or replace location.";
  const textInstruction = "Remove and erase every existing caption, word, letter, number, logo-like typography and watermark from the source image; do not render replacement text.";
  const handlers = coreAutomationNodeHandlers();
  let generatedPlans: Record<string, unknown> | null = null;
  const result = await executeAutomationGraph({
    graph: createDefaultTikTokWorkflowGraph(),
    context: {
      ...context,
      runtimeInputs: {
        "tiktok-source.source": "source-1",
        "identity.identity": "person-identity",
        "creative-settings.mode": "identity",
        "creative-settings.newOutfit": true,
        "creative-settings.newLocation": true,
        "creative-settings.textStrategy": "remove",
        "creative-settings.creativeBrief": "Keep the exact source location.",
        "creative-settings.creativeDirectionPolicy": "auto-explicit",
        "visual-references.references": [],
        "generate-images.modelId": "nano-banana-2",
      },
    },
    handlers: {
      ...handlers,
      "input.tiktok-source@1": async () => ({ source: { id: "source-1", slides: [{ index: 1, assetId: "source-asset" }] } }),
      "input.identity@1": async () => ({ identity: { id: "person-identity", assets: [{ id: "person", path: "person.png", mimeType: "image/png" }] } }),
      "input.visual-references@1": async () => ({ references: { assets: [] } }),
      "ai.interpret-creative-direction@1": async ({ inputs }) => {
        const request = inputs.request as { briefHash: string; clauses: Array<{ id: string; text: string }> };
        const evidence = "Keep the exact source location";
        return { analysis: { briefHash: request.briefHash, clauseResults: [{ clauseId: request.clauses[0].id, items: [{ kind: "choice", evidence, evidenceStart: 0, evidenceEnd: evidence.length, controlId: "location-setting", optionId: "preserve", instruction: "", category: "", placement: "", slideIndexes: [], confidence: 1, reason: "" }] }] } };
      },
      "ai.structured-task@2": async ({ node }) => {
        if (node.id === "analyze-source") return { result: { format: "slideshow", summary: "portrait", theme: "change", narrativeArc: "before to after", language: "English", transformationBoundary: 1, slides: [{ index: 1, role: "hook", visibleText: "last year...", visualBrief: "mirror portrait", faceVisibility: "clear", framing: "vertical", confidence: 1 }] } };
        if (node.id === "inspect-identity") return { result: { assets: [{ id: "person", faceAngle: "front", framing: "portrait", captureStyle: "phone", identitySignals: ["face"] }] } };
        if (node.id === "interpret-brief") return { result: { userIntentSummary: "Change person and outfit", requirements: [], globalRules: [], decisions: { newOutfit: true, newLocation: false, textStrategy: "remove" }, campaign: { direction: "identity adaptation", audience: "viewer", tone: "candid" }, sequence: { hook: "portrait", progression: "change", payoff: "new version" }, slides: [{ index: 1, intent: "hook", mustKeep: ["location"], mayChange: ["identity", "wardrobe"] }] } };
        if (node.id === "remove-copy") return { result: { slides: [{ index: 1, sourceText: "last year...", overlayText: "", strategy: "remove", instruction: textInstruction, copyFunction: "hook" }] } };
        if (node.id === "bind-references") return { result: { slides: [{ index: 1, references: [{ assetId: "person", title: "Maya identity", role: "identity", instruction: AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION }] }] } };
        if (node.id === "plan-slides") return { result: { slides: [{ index: 1, role: "hook", prompt: { title: "Opening", task: "Recreate the portrait with the selected identity.", reference_plan: [{ token: "@Source_composition_1_1", title: "Source composition 1", role: "source composition", instruction: AUTOMATION_SOURCE_REFERENCE_INSTRUCTION }, { token: "@Maya_identity_2", title: "Maya identity", role: "identity", instruction: AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION }], subject: { identity: "Maya", appearance: ["new outfit"], pose: "source pose", expression: "relaxed" }, scene: { environment: "source hallway", composition: "source framing", lighting: "ambient", camera: "phone" }, preserve: ["Keep the source concept, hook, sequence and scene intent without inventing a different campaign concept.", locationInstruction], change: ["Adapt the person or character using the selected identity while keeping identity references isolated from wardrobe and location.", wardrobeInstruction, textInstruction], avoid: [AUTOMATION_NO_TEXT_AVOID_INSTRUCTION], output: { format: "9:16 image", style: "candid phone photo" } }, referenceAssetIds: ["person"], text: { strategy: "remove", sourceText: "last year...", overlayText: "", instruction: textInstruction }, confidence: 1 }] } };
        if (node.id === "review-series") return { result: { passed: true, summary: "All requirements covered", slides: [{ index: 1, passed: true, issues: [] }], requirementCoverage: [{ requirement: "preserve location", passed: true, slideIndexes: [1], issues: [] }] } };
        if (node.id === "repair-slides") throw new Error("Approved plans must not be rewritten");
        throw new Error(`Unexpected AI node ${node.id}`);
      },
      "generation.image@1": async ({ inputs }) => { generatedPlans = inputs.plans as Record<string, unknown>; return { assets: { items: [] } }; },
      "output.add-to-canvas@1": async () => ({ result: { ok: true } }),
    },
  });
  assert.deepEqual(result.outputs.get("add-to-canvas")?.result, { ok: true });
  assert.equal((result.outputs.get("resolve-user-direction")?.resolved as { newLocation: boolean }).newLocation, false, "the explicit comment must switch the real location branch before planning");
  assert.ok(generatedPlans);
  const generatedSlide = (generatedPlans as unknown as { slides: Array<{ prompt: { preserve: string[]; change: string[] }; text: { strategy: string; overlayText: string } }> }).slides[0];
  assert.ok(generatedSlide.prompt.preserve.includes(locationInstruction));
  assert.ok(generatedSlide.prompt.change.includes(wardrobeInstruction));
  assert.ok(generatedSlide.prompt.change.includes(textInstruction));
  assert.deepEqual(generatedSlide.text, { strategy: "remove", sourceText: "last year...", overlayText: "", instruction: textInstruction });
});

test("runtime rejects handler output keys outside the versioned node contract", async () => {
  await assert.rejects(executeAutomationGraph({
    graph: linearGraph(),
    context,
    handlers: {
      "core.manual-trigger@1": async () => ({ run: {} }),
      "input.tiktok-source@1": async () => ({ source: {} }),
      "ai.structured-task@2": async () => ({ typo: {} }),
    },
  }), (error: unknown) => (error as { code?: string }).code === "NODE_OUTPUT_CONTRACT");
});

test("runtime rejects a legacy slide-plan shape at the typed validator output boundary", async () => {
  await assert.rejects(executeAutomationGraph({
    graph: linearGraph(),
    context,
    handlers: {
      "core.manual-trigger@1": async () => ({ run: {} }),
      "input.tiktok-source@1": async () => ({ source: {} }),
      "ai.structured-task@2": async () => ({ result: { slides: [] } }),
      "logic.validate-slide-plans@1": async () => ({ plans: { selected: checkedPlanSet() } }),
    },
  }), (error: unknown) => (error as { code?: string }).code === "NODE_OUTPUT_CONTRACT" && /one supported slide-plan contract/.test(String((error as Error).message)));
});

test("runtime cannot report success when no terminal branch produced output", async () => {
  await assert.rejects(executeAutomationGraph({
    graph: linearGraph(),
    context,
    handlers: {
      "core.manual-trigger@1": async () => ({ run: {} }),
      "input.tiktok-source@1": async () => ({ source: {} }),
      "ai.structured-task@2": async () => ({ error: { message: "unexpected handler branch" } }),
    },
  }), (error: unknown) => (error as { code?: string }).code === "NO_TERMINAL_OUTPUT");
});

test("failure policies persist a continued node output for safe worker resume", async () => {
  const continued: Array<{ nodeId: string; reason: string }> = [];
  const result = await executeAutomationGraph({
    graph: linearGraph({ failureMode: "continue-empty", maxAttempts: 1 }),
    context,
    handlers: {
      "core.manual-trigger@1": async () => ({ run: {} }),
      "input.tiktok-source@1": async () => ({ source: {} }),
      "ai.structured-task@2": async () => { throw new Error("provider failed"); },
      "logic.validate-slide-plans@1": async () => ({ plans: checkedPlanSet() }),
      "generation.image@1": async () => ({ assets: { items: [] } }),
      "output.add-to-canvas@1": async () => ({ result: { ok: true } }),
    },
    observer: {
      nodeContinued(node, _output, _attempt, reason) { continued.push({ nodeId: node.id, reason }); },
    },
  });
  assert.deepEqual(continued, [{ nodeId: "plan", reason: "continue-empty" }]);
  assert.deepEqual(result.completedTerminalNodeIds, ["output"]);
});

test("non-retryable failures stop immediately and preserve safe details on the error path", async () => {
  const graph: AutomationWorkflowGraph = {
    schemaVersion: 1,
    groups: [],
    nodes: [
      { id: "run", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "request", type: "integration.http-request", version: 1, name: "Request", description: "", position: { x: 100, y: 0 }, groupId: null, config: { url: "https://example.com", maxAttempts: 3, failureMode: "error-output" }, bindings: {}, disabled: false },
      { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 200, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    ],
    edges: [
      { id: "a", source: "run", sourcePort: "run", target: "request", targetPort: "data" },
      { id: "b", source: "request", sourcePort: "error", target: "finish", targetPort: "data" },
    ],
  };
  let attempts = 0;
  const result = await executeAutomationGraph({
    graph,
    context,
    handlers: {
      "core.manual-trigger@1": async () => ({ run: {} }),
      "integration.http-request@1": async () => {
        attempts += 1;
        throw Object.assign(new Error("HTTP request returned 400"), {
          code: "HTTP_STATUS",
          automationRetryable: false,
          safeResponse: { status: 400, ok: false, body: { error: "invalid request" } },
        });
      },
      "output.finish@1": async ({ inputs }) => ({ result: inputs.data }),
    },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(result.outputs.get("request")?.error, {
    message: "HTTP request returned 400",
    nodeId: "request",
    code: "HTTP_STATUS",
    response: { status: 400, ok: false, body: { error: "invalid request" } },
  });
  assert.deepEqual(result.outputs.get("finish")?.result, result.outputs.get("request")?.error);
});

test("continue-empty uses the actual node output contract", async () => {
  const graph = linearGraph();
  const request = graph.nodes.find((node) => node.id === "plan")!;
  request.type = "integration.http-request";
  request.version = 1;
  request.config = { url: "https://api.example.com", method: "GET", headers: {}, body: {}, failureMode: "continue-empty", maxAttempts: 1 };
  const inputEdge = graph.edges.find((edge) => edge.target === "plan")!;
  inputEdge.targetPort = "data";
  const requestEdge = graph.edges.find((edge) => edge.source === "plan")!;
  requestEdge.sourcePort = "response";
  const result = await executeAutomationGraph({
    graph,
    context,
    handlers: {
      "core.manual-trigger@1": async () => ({ run: {} }),
      "input.tiktok-source@1": async () => ({ source: {} }),
      "integration.http-request@1": async () => { throw new Error("remote API failed"); },
      "logic.validate-slide-plans@1": async () => ({ plans: checkedPlanSet() }),
      "generation.image@1": async () => ({ assets: { items: [] } }),
      "output.add-to-canvas@1": async () => ({ result: { ok: true } }),
    },
  });
  assert.equal(result.outputs.get("plan")?.response, null);
  assert.deepEqual(result.warnings, [{ nodeId: "plan", message: "remote API failed" }]);
  assert.deepEqual(result.completedTerminalNodeIds, ["output"]);
});

test("structured output validation enforces enum, bounds and unknown-field rules", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["status", "score"],
    properties: {
      status: { type: "string", enum: ["approved", "rejected"] },
      score: { type: "number", minimum: 0, maximum: 1 },
    },
  };
  assert.deepEqual(validateAutomationStructuredValue({ status: "approved", score: 0.8 }, schema), []);
  const issues = validateAutomationStructuredValue({ status: "maybe", score: 2, extra: true }, schema);
  assert.ok(issues.some((entry) => entry.includes("allowed value")));
  assert.ok(issues.some((entry) => entry.includes("at most 1")));
  assert.ok(issues.some((entry) => entry.includes("extra is not allowed")));
});

test("condition node uses explicit safe operators instead of evaluating code", async () => {
  const handler = coreAutomationNodeHandlers()["logic.condition@1"];
  const base = {
    node: { id: "gate", type: "logic.condition", version: 1, name: "Gate", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    attempt: 1,
    context,
    outputsByNode: new Map<string, Record<string, unknown>>(),
  };
  assert.deepEqual(await handler({ ...base, config: { path: "review.score", operator: "greater-than", compareValue: 0.7 }, inputs: { data: { review: { score: 0.9 } } } }), { yes: { review: { score: 0.9 } } });
  assert.deepEqual(await handler({ ...base, config: { path: "labels", operator: "contains", compareValue: "blocked" }, inputs: { data: { labels: ["ready"] } } }), { no: { labels: ["ready"] } });
  assert.deepEqual(await handler({ ...base, config: { path: "database.ready", operator: "equals", compareValue: true }, inputs: { data: { database: { ready: true } } } }), { yes: { database: { ready: true } } });
  assert.deepEqual(await handler({ ...base, config: { path: "data.database.ready", operator: "equals", compareValue: true }, inputs: { data: { database: { ready: true } } } }), { yes: { database: { ready: true } } });
});

test("merge paths creates one stable named package from completed routes", async () => {
  const handler = coreAutomationNodeHandlers()["logic.merge@1"];
  const node = {
    id: "merge", type: "logic.merge", version: 1, name: "Merge approved plan", description: "", position: { x: 0, y: 0 }, groupId: null,
    config: {}, bindings: {}, disabled: false,
  } as const;
  const result = await handler({
    node,
    config: { mode: "named-object", inputs: [
      { id: "input-brief", name: "brief" },
      { id: "input-copy", name: "copy" },
      { id: "input-references", name: "references" },
    ] },
    inputs: { "input-brief": { goal: "adapt" }, "input-copy": [{ text: "new copy" }], "input-references": { selected: ["ref-1"] } },
    attempt: 1,
    context,
    outputsByNode: new Map<string, Record<string, unknown>>(),
    inputConnections: {},
  });
  assert.deepEqual(result, {
    result: {
      brief: { goal: "adapt" },
      copy: [{ text: "new copy" }],
      references: { selected: ["ref-1"] },
    },
  });
});

test("finish node gives condition and error branches an explicit terminal", async () => {
  const handler = coreAutomationNodeHandlers()["output.finish@1"];
  const node = { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false } as const;
  const execution = { node, attempt: 1, context, outputsByNode: new Map<string, Record<string, unknown>>(), inputs: { data: { approved: true } } };
  assert.deepEqual(await handler({ ...execution, config: { outcome: "completed", message: "Approved: {{ data.approved }}" } }), { result: { outcome: "completed", message: "Approved: true", data: { approved: true } } });
  await assert.rejects(handler({ ...execution, config: { outcome: "failed", message: "Quality gate failed" } }), /Quality gate failed/);
});

function boundedRetryGraph(maxRetries = 2): AutomationWorkflowGraph {
  return {
    schemaVersion: 1,
    groups: [],
    nodes: [
      { id: "run", type: "core.manual-trigger", version: 1, name: "Run", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "retry", type: "logic.retry-gate", version: 1, name: "Retry corrected value", description: "", position: { x: 100, y: 0 }, groupId: null, config: { maxRetries, feedbackPath: "plans" }, bindings: {}, disabled: false },
      { id: "check", type: "ai.structured-task", version: 2, name: "Check", description: "", position: { x: 200, y: 0 }, groupId: null, config: { modelId: "google/gemini-3.7-flash", userPrompt: "Check", outputMode: "text", maxAttempts: 1, failureMode: "error-output" }, bindings: {}, disabled: false },
      { id: "repair", type: "ai.structured-task", version: 2, name: "Repair", description: "", position: { x: 300, y: 120 }, groupId: null, config: { modelId: "google/gemini-3.7-flash", userPrompt: "Repair", outputMode: "text", maxAttempts: 1, failureMode: "stop" }, bindings: {}, disabled: false },
      { id: "feedback", type: "logic.merge", version: 1, name: "Keep repair and error", description: "", position: { x: 400, y: 120 }, groupId: null, config: { mode: "named-object", inputs: [{ id: "input-plans", name: "plans" }, { id: "input-error", name: "validationError" }] }, bindings: {}, disabled: false },
      { id: "success", type: "output.finish", version: 1, name: "Success", description: "", position: { x: 400, y: 0 }, groupId: null, config: { outcome: "completed", message: "Done" }, bindings: {}, disabled: false },
      { id: "failed", type: "output.finish", version: 1, name: "Failed", description: "", position: { x: 200, y: 240 }, groupId: null, config: { outcome: "failed", message: "{{ data.message }}" }, bindings: {}, disabled: false },
    ],
    edges: [
      { id: "run-retry", source: "run", sourcePort: "run", target: "retry", targetPort: "initial", role: "flow" },
      { id: "retry-check", source: "retry", sourcePort: "current", target: "check", targetPort: "primary", role: "flow" },
      { id: "check-success", source: "check", sourcePort: "result", target: "success", targetPort: "data", role: "flow" },
      { id: "check-repair", source: "check", sourcePort: "error", target: "repair", targetPort: "primary", role: "error" },
      { id: "retry-repair", source: "retry", sourcePort: "current", target: "repair", targetPort: "context", role: "data" },
      { id: "repair-feedback", source: "repair", sourcePort: "result", target: "feedback", targetPort: "input-plans", role: "flow" },
      { id: "error-feedback", source: "check", sourcePort: "error", target: "feedback", targetPort: "input-error", role: "error" },
      { id: "feedback-retry", source: "feedback", sourcePort: "result", target: "retry", targetPort: "feedback", role: "retry" },
      { id: "retry-failed", source: "retry", sourcePort: "exhausted", target: "failed", targetPort: "data", role: "error" },
    ],
  };
}

test("bounded Retry route repairs a failed value and executes the same check again", async () => {
  const graph = boundedRetryGraph();
  assert.equal(validateAutomationWorkflowGraph(graph).valid, true);
  const attempts: string[] = [];
  const handlers = coreAutomationNodeHandlers();
  const result = await executeAutomationGraph({
    graph,
    context,
    handlers: {
      ...handlers,
      "core.manual-trigger@1": async () => ({ run: { value: "bad" } }),
      "ai.structured-task@2": async ({ node, inputs }) => {
        attempts.push(node.id);
        if (node.id === "check") {
          const value = inputs.primary as { value?: string };
          if (value.value !== "good") throw Object.assign(new Error("Value must be good"), { code: "VALIDATION_FAILED", automationRetryable: false });
          return { result: value };
        }
        return { result: { value: "good" } };
      },
    },
  });
  assert.deepEqual(attempts, ["check", "repair", "check"]);
  assert.deepEqual(result.outputs.get("success")?.result, { outcome: "completed", message: "Done", data: { value: "good" } });
  assert.equal(result.outputs.get("retry")?.__retryIteration, 1);
});

test("bounded Retry route stops through its explicit exhausted output", async () => {
  const graph = boundedRetryGraph(1);
  const handlers = coreAutomationNodeHandlers();
  await assert.rejects(executeAutomationGraph({
    graph,
    context,
    handlers: {
      ...handlers,
      "core.manual-trigger@1": async () => ({ run: { value: "bad" } }),
      "ai.structured-task@2": async ({ node }) => node.id === "check"
        ? Promise.reject(Object.assign(new Error("Still invalid"), { code: "VALIDATION_FAILED", automationRetryable: false }))
        : { result: { value: "bad" } },
    },
  }), /Retry limit reached after 1 corrected attempt/);
});
