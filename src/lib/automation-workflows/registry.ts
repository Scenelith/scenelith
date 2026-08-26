import { tiktokAutomationPlanningModels } from "@/lib/assistant-models";
import type { AutomationNodeDefinition, AutomationPortType } from "./types";

const planningModelOptions = tiktokAutomationPlanningModels.map((model) => ({ value: model.id, label: model.label }));

const definitions: AutomationNodeDefinition[] = [
  {
    type: "core.manual-trigger", version: 1, title: "Manual run", description: "Starts the workflow from the Automation panel.", category: "trigger", accent: "mint",
    inputs: [], outputs: [{ id: "run", label: "Run", type: "run-context" }], fields: [],
  },
  {
    type: "input.tiktok-source", version: 1, title: "TikTok source", description: "Reads a slideshow and keeps its source frames ordered.", category: "input", accent: "amber",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "source", label: "Source", type: "tiktok-source" }], fields: [
      { id: "source", label: "Source slideshow", kind: "select", runtimeBindable: true, runtimeValueType: "tiktok-source", required: true },
      { id: "caption", label: "Caption override", kind: "textarea", runtimeBindable: true, runtimeValueType: "string" },
    ],
  },
  {
    type: "input.identity", version: 1, title: "Identity", description: "Supplies reusable identity references when a step needs them.", category: "input", accent: "blue",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "identity", label: "Identity", type: "identity" }], fields: [
      { id: "identity", label: "Identity", kind: "select", runtimeBindable: true, runtimeValueType: "identity" },
      { id: "referenceGroup", label: "Reference group", kind: "select", defaultValue: "auto", options: [
        { value: "auto", label: "Automatic" }, { value: "reference", label: "Reference" }, { value: "before", label: "Before" }, { value: "after", label: "After" },
      ] },
      { id: "optional", label: "Allow no identity", kind: "boolean", defaultValue: true },
    ],
  },
  {
    type: "input.creative-settings", version: 1, title: "Creative settings", description: "Collects the choices that may change from one run to the next.", category: "input", accent: "neutral",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "settings", label: "Settings", type: "data" }], fields: [
      { id: "mode", label: "Adaptation mode", kind: "select", defaultValue: "concept", runtimeBindable: true, runtimeValueType: "string", options: [{ value: "concept", label: "Adapt concept" }, { value: "identity", label: "Cast identity" }] },
      { id: "newOutfit", label: "New wardrobe or subjects", kind: "boolean", defaultValue: true, runtimeBindable: true, runtimeValueType: "boolean" },
      { id: "newLocation", label: "New location or setting", kind: "boolean", defaultValue: true, runtimeBindable: true, runtimeValueType: "boolean" },
      { id: "textStrategy", label: "On-screen text", kind: "select", defaultValue: "rewrite", runtimeBindable: true, runtimeValueType: "string", options: [{ value: "keep", label: "Keep" }, { value: "rewrite", label: "Rewrite" }, { value: "remove", label: "Remove" }] },
      { id: "creativeBrief", label: "Creative direction", kind: "textarea", defaultValue: "", runtimeBindable: true, runtimeValueType: "string" },
    ],
  },
  {
    type: "input.workflow-data", version: 1, title: "Workflow input", description: "Receives structured data from a manual run, trigger, Map, or parent workflow.", category: "input", accent: "amber",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "data", label: "Data", type: "data" }], fields: [
      { id: "value", label: "Input value", kind: "json", runtimeBindable: true, runtimeValueType: "json", required: true, defaultValue: {} },
    ],
  },
  {
    type: "ai.structured-task", version: 1, title: "AI task", description: "Runs a visible, editable multimodal AI request with structured output.", category: "ai", accent: "blue",
    inputs: [
      { id: "primary", label: "Primary data", type: "data", required: true },
      { id: "context", label: "Context", type: "data", multiple: true },
      { id: "identity", label: "Identity", type: "identity" },
    ],
    outputs: [{ id: "result", label: "Result", type: "data" }, { id: "error", label: "Error", type: "error" }],
    fields: [
      { id: "modelId", label: "Model", kind: "model", runtimeBindable: true, runtimeValueType: "assistant-model", modelCapability: "assistant", required: true, options: planningModelOptions },
      { id: "systemPrompt", label: "System prompt", kind: "prompt", defaultValue: "" },
      { id: "userPrompt", label: "Task prompt", kind: "prompt", defaultValue: "" },
      { id: "responseSchema", label: "Response schema", kind: "json", defaultValue: {} },
      { id: "strictSchema", label: "Strict response schema", kind: "boolean", defaultValue: false, description: "Require the provider to reject any response outside the schema. Use only with fully defined object properties." },
      { id: "temperature", label: "Temperature", kind: "number", defaultValue: 0.2, min: 0, max: 2 },
      { id: "runWhen", label: "Run this request", kind: "select", defaultValue: "always", options: [
        { value: "always", label: "Always" }, { value: "primary != null", label: "Only when primary input exists" },
      ] },
      { id: "maxAttempts", label: "Attempts", kind: "number", defaultValue: 3, min: 1, max: 8 },
      { id: "fallbackModelId", label: "Fallback model", kind: "model", modelCapability: "assistant", description: "Used after the first failed attempt.", options: planningModelOptions },
      { id: "failureMode", label: "When this fails", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop workflow" }, { value: "error-output", label: "Use error output" }, { value: "continue-empty", label: "Continue with empty result" },
      ] },
    ],
  },
  {
    type: "logic.transform", version: 1, title: "Transform data", description: "Builds a new object from prior node values without arbitrary code.", category: "logic", accent: "neutral",
    inputs: [{ id: "data", label: "Data", type: "data", required: true, multiple: true }], outputs: [{ id: "result", label: "Result", type: "data" }], fields: [
      { id: "template", label: "Output template", kind: "json", defaultValue: {} },
    ],
  },
  {
    type: "logic.condition", version: 1, title: "Condition", description: "Routes items using a visible condition.", category: "logic", accent: "neutral",
    inputs: [{ id: "data", label: "Data", type: "data", required: true }], outputs: [
      { id: "yes", label: "Matches", type: "data", required: true }, { id: "no", label: "Does not match", type: "data", required: true },
    ], fields: [
      { id: "path", label: "Value path", kind: "text", defaultValue: "", description: "Dot path inside the incoming data. Leave empty to test the complete value." },
      { id: "operator", label: "Operator", kind: "select", defaultValue: "is-truthy", options: [
        { value: "is-truthy", label: "Is truthy" }, { value: "is-falsy", label: "Is falsy" },
        { value: "is-empty", label: "Is empty" }, { value: "is-not-empty", label: "Is not empty" },
        { value: "equals", label: "Equals" }, { value: "not-equals", label: "Does not equal" },
        { value: "contains", label: "Contains" }, { value: "greater-than", label: "Greater than" },
        { value: "less-than", label: "Less than" },
      ] },
      { id: "compareValue", label: "Comparison value", kind: "json", defaultValue: null, description: "A JSON value such as true, 10, or \"approved\".", visibleWhen: { fieldId: "operator", values: ["equals", "not-equals", "contains", "greater-than", "less-than"] } },
    ],
  },
  {
    type: "logic.limit-batch", version: 1, title: "Limit batch", description: "Checks and forwards a bounded item collection without pretending to execute a loop.", category: "logic", accent: "neutral",
    inputs: [{ id: "items", label: "Items", type: "data", required: true }], outputs: [{ id: "items", label: "Bounded items", type: "data" }, { id: "summary", label: "Summary", type: "data" }], fields: [
      { id: "maxItems", label: "Maximum items", kind: "number", defaultValue: 40, min: 1, max: 500 },
    ],
  },
  {
    type: "logic.merge", version: 1, title: "Combine branches", description: "Collects connected branch values into one ordered list.", category: "logic", accent: "neutral",
    inputs: [{ id: "branches", label: "Branches", type: "data", required: true, multiple: true, minConnections: 2 }], outputs: [{ id: "result", label: "Combined", type: "data" }], fields: [],
  },
  {
    type: "logic.run-subworkflow", version: 1, title: "Run workflow", description: "Runs one pinned published child workflow through a local portable slot.", category: "logic", accent: "mint",
    inputs: [{ id: "data", label: "Input", type: "data", required: true }], outputs: [{ id: "result", label: "Result", type: "data" }, { id: "error", label: "Error", type: "error" }], fields: [
      { id: "subworkflowSlot", label: "Workflow slot", kind: "text", required: true, defaultValue: "child-workflow" },
      { id: "childInputKey", label: "Child input key", kind: "text", required: true, defaultValue: "workflow-input.value" },
      { id: "childInputs", label: "Other child inputs", kind: "json", defaultValue: {} },
      { id: "failureMode", label: "When this fails", kind: "select", defaultValue: "stop", options: [{ value: "stop", label: "Stop workflow" }, { value: "error-output", label: "Use error output" }] },
    ],
  },
  {
    type: "logic.map-subworkflow", version: 1, title: "Map items", description: "Runs a pinned child workflow once per item with bounded parallelism and visible item results.", category: "logic", accent: "mint",
    inputs: [{ id: "items", label: "Items", type: "data", required: true }], outputs: [{ id: "results", label: "Results", type: "data" }, { id: "failures", label: "Failures", type: "data" }, { id: "error", label: "Error", type: "error" }], fields: [
      { id: "subworkflowSlot", label: "Workflow slot", kind: "text", required: true, defaultValue: "item-workflow" },
      { id: "childInputKey", label: "Child item input", kind: "text", required: true, defaultValue: "workflow-input.value" },
      { id: "childInputs", label: "Other child inputs", kind: "json", defaultValue: {} },
      { id: "maxItems", label: "Maximum items", kind: "number", defaultValue: 40, min: 1, max: 500 },
      { id: "concurrency", label: "Parallel items", kind: "number", defaultValue: 3, min: 1, max: 16 },
      { id: "itemFailure", label: "Failed item", kind: "select", defaultValue: "keep-successful", options: [{ value: "keep-successful", label: "Keep successful items" }, { value: "stop", label: "Stop all" }] },
      { id: "failureMode", label: "When all fail", kind: "select", defaultValue: "stop", options: [{ value: "stop", label: "Stop workflow" }, { value: "error-output", label: "Use error output" }] },
    ],
  },
  {
    type: "integration.http-request", version: 1, title: "HTTP request", description: "Calls an external API with server-side credentials and bounded responses.", category: "logic", accent: "blue",
    inputs: [{ id: "data", label: "Input", type: "data" }], outputs: [{ id: "response", label: "Response", type: "data" }, { id: "error", label: "Error", type: "error" }], fields: [
      { id: "url", label: "URL", kind: "text", required: true, defaultValue: "https://" },
      { id: "method", label: "Method", kind: "select", defaultValue: "GET", options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value, label: value })) },
      { id: "headers", label: "Headers", kind: "json", defaultValue: {} },
      { id: "body", label: "Body", kind: "json", defaultValue: {} },
      { id: "credentialSlot", label: "Credential slot", kind: "text", description: "A portable slot name. The actual secret is connected after import." },
      { id: "credentialKind", label: "Credential kind", kind: "select", defaultValue: "bearer", options: [
        { value: "api-key", label: "API key header" }, { value: "bearer", label: "Bearer token" }, { value: "basic", label: "Basic auth" }, { value: "header", label: "Custom header" },
      ] },
      { id: "timeoutSeconds", label: "Timeout", kind: "number", defaultValue: 30, min: 1, max: 120 },
      { id: "maxAttempts", label: "Attempts", kind: "number", defaultValue: 2, min: 1, max: 5 },
      { id: "failureMode", label: "When this fails", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop workflow" }, { value: "error-output", label: "Use error output" }, { value: "continue-empty", label: "Continue empty" },
      ] },
    ],
  },
  {
    type: "logic.validate-slide-plans", version: 1, title: "Validate slide plans", description: "Checks indexes, prompts and reference ids before any image provider is called.", category: "logic", accent: "neutral",
    inputs: [{ id: "data", label: "Plan data", type: "data", required: true }], outputs: [{ id: "plans", label: "Validated plans", type: "slide-plan-set" }], fields: [
      { id: "maxSlides", label: "Maximum slides", kind: "number", defaultValue: 40, min: 1, max: 40 },
    ],
  },
  {
    type: "generation.image", version: 1, title: "Generate images", description: "Generates every reviewed slide using its assigned references.", category: "generation", accent: "mint",
    inputs: [
      { id: "plans", label: "Slide plans", type: "slide-plan-set", required: true },
      { id: "source", label: "Source slides", type: "tiktok-source", required: true },
      { id: "identity", label: "Identity", type: "identity" },
    ], outputs: [{ id: "assets", label: "Assets", type: "generated-assets" }, { id: "error", label: "Error", type: "error" }], fields: [
      { id: "modelId", label: "Image model", kind: "model", runtimeBindable: true, runtimeValueType: "image-model", modelCapability: "image", required: true },
      { id: "ratio", label: "Aspect ratio", kind: "select", runtimeBindable: true, runtimeValueType: "aspect-ratio" },
      { id: "resolution", label: "Resolution", kind: "select", runtimeBindable: true, runtimeValueType: "resolution" },
      { id: "concurrency", label: "Concurrency", kind: "number", defaultValue: 3, min: 1, max: 8 },
      { id: "maxAttempts", label: "Attempts per image", kind: "number", defaultValue: 3, min: 1, max: 5 },
      { id: "partialFailure", label: "Partial failure", kind: "select", defaultValue: "keep-successful", options: [
        { value: "keep-successful", label: "Keep successful images" }, { value: "stop", label: "Stop without applying" },
      ] },
      { id: "failureMode", label: "When generation fails completely", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop workflow" }, { value: "error-output", label: "Use error output" },
      ] },
    ],
  },
  {
    type: "output.add-to-canvas", version: 1, title: "Add to canvas", description: "Applies the resulting branch to the content canvas once.", category: "output", accent: "mint", terminal: true,
    inputs: [{ id: "assets", label: "Assets", type: "generated-assets", required: true }, { id: "source", label: "Source", type: "tiktok-source" }], outputs: [{ id: "result", label: "Canvas result", type: "canvas-result" }], fields: [
      { id: "layout", label: "Layout", kind: "select", defaultValue: "beside-source", options: [
        { value: "beside-source", label: "Beside source" }, { value: "new-row", label: "New row" },
      ] },
      { id: "includePlanNote", label: "Add planning note", kind: "boolean", defaultValue: true },
    ],
  },
  {
    type: "output.finish", version: 1, title: "Finish workflow", description: "Ends a branch explicitly without changing the content canvas.", category: "output", accent: "neutral", terminal: true,
    inputs: [{ id: "data", label: "Final data", type: "data", required: true }], outputs: [{ id: "result", label: "Workflow result", type: "workflow-result" }], fields: [
      { id: "outcome", label: "Outcome", kind: "select", defaultValue: "completed", options: [
        { value: "completed", label: "Complete successfully" }, { value: "failed", label: "Stop as failed" },
      ] },
      { id: "message", label: "Result message", kind: "text", defaultValue: "Workflow finished" },
    ],
  },
];

const registry = new Map(definitions.map((definition) => [`${definition.type}@${definition.version}`, definition]));

export function automationNodeDefinitions() {
  return definitions;
}

export function automationNodeDefinition(type: string, version = 1) {
  return registry.get(`${type}@${version}`);
}

export function automationPortTypesCompatible(source: AutomationPortType, target: AutomationPortType) {
  // A generic data input may consume any structured value. Generic data must
  // never masquerade as a stronger domain type such as a TikTok source,
  // identity or generated asset collection.
  return source === target || target === "data";
}
