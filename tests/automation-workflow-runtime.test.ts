import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAutomationGraph, type AutomationNodeHandlers } from "../src/lib/automation-workflows/runtime";
import { buildAutomationGenerationPrompt, coreAutomationNodeHandlers } from "../src/lib/automation-workflows/node-handlers";
import { validateAutomationStructuredValue } from "../src/lib/automation-workflows/json-schema";
import type { AutomationWorkflowGraph } from "../src/lib/automation-workflows/types";

const context = { runId: "run", userId: "user", workspaceId: "workspace", projectId: "project", runtimeInputs: { "source.source": "canvas-source" } };

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
    "logic.validate-slide-plans@1": async ({ inputs }) => { calls.push("validate"); return { plans: inputs.data }; },
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
    ["validate", { plans: { slides: [] } }],
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
      "logic.validate-slide-plans@1": async ({ inputs }) => ({ plans: inputs.data }),
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

test("generation prompt gives source and identity references separate responsibilities", () => {
  const result = buildAutomationGenerationPrompt(
    { index: 1, prompt: "Create a kitchen portrait.", overlayText: "Day one" },
    [
      { path: "source.png", mimeType: "image/png", role: "reference-image", label: "Source composition 1" },
      { path: "person.png", mimeType: "image/png", role: "reference-image", label: "Identity reference 1" },
    ],
  );
  assert.match(result.prompt, /composition, framing, pose and scene structure only/);
  assert.match(result.prompt, /target person's identity and appearance only/);
  assert.match(result.prompt, /Render exactly: "Day one"/);
  assert.equal(result.references[0].label, "@Source_composition_1_1");
  assert.equal(result.references[1].label, "@Identity_reference_1_2");
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
      "logic.validate-slide-plans@1": async ({ inputs }) => ({ plans: inputs.data }),
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
      "logic.validate-slide-plans@1": async ({ inputs }) => ({ plans: inputs.data }),
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
