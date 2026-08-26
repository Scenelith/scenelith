import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationEdge, type AutomationGroup, type AutomationNode, type AutomationWorkflowGraph } from "./types";

export const DEFAULT_TIKTOK_WORKFLOW_KEY = "system.tiktok-recreate";
export const DEFAULT_TIKTOK_WORKFLOW_REVISION = 7;

const defaultPlanningModel = "google/gemini-3.7-flash";

function node(input: Omit<AutomationNode, "version" | "description" | "groupId" | "config" | "bindings" | "disabled"> & Partial<Pick<AutomationNode, "version" | "description" | "groupId" | "config" | "bindings" | "disabled">>): AutomationNode {
  return {
    version: 1,
    description: "",
    groupId: null,
    config: {},
    bindings: {},
    disabled: false,
    ...input,
  };
}

function edge(source: string, sourcePort: string, target: string, targetPort: string): AutomationEdge {
  return { id: `${source}:${sourcePort}->${target}:${targetPort}`, source, sourcePort, target, targetPort };
}

function aiNode(input: {
  id: string;
  name: string;
  description: string;
  groupId: string;
  position: { x: number; y: number };
  systemPrompt: string;
  userPrompt: string;
  responseSchema: Record<string, unknown>;
  runWhen?: string;
  maxAttempts?: number;
}) {
  return node({
    id: input.id,
    type: "ai.structured-task",
    name: input.name,
    description: input.description,
    groupId: input.groupId,
    position: input.position,
    config: {
      modelId: defaultPlanningModel,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      responseSchema: input.responseSchema,
      strictSchema: false,
      temperature: 0.2,
      maxAttempts: input.maxAttempts ?? 3,
      fallbackModelId: "",
      failureMode: "stop",
      runWhen: input.runWhen || "always",
    },
    bindings: {
      modelId: { mode: "fixed", value: defaultPlanningModel, label: "Planning model", required: true },
    },
  });
}

const groups: AutomationGroup[] = [
  { id: "group-understand", name: "Understand source", description: "Read the slideshow, its copy and visual mechanic.", position: { x: 520, y: 120 }, size: { width: 760, height: 500 }, collapsedByDefault: true, nodeIds: ["analyze-source", "decompose-copy"] },
  { id: "group-adapt", name: "Adapt concept", description: "Apply the creative brief, identity and rewritten copy.", position: { x: 1420, y: 80 }, size: { width: 1220, height: 720 }, collapsedByDefault: true, nodeIds: ["inspect-identity", "interpret-brief", "rewrite-copy", "review-copy", "bind-references"] },
  { id: "group-build", name: "Build slides", description: "Assemble the contract and plan every output slide.", position: { x: 2800, y: 120 }, size: { width: 780, height: 500 }, collapsedByDefault: true, nodeIds: ["assemble-contract", "plan-slides"] },
  { id: "group-review", name: "Review series", description: "Check the complete sequence and repair only failed slides.", position: { x: 3720, y: 120 }, size: { width: 820, height: 500 }, collapsedByDefault: true, nodeIds: ["review-series", "repair-slides"] },
];

export function createDefaultTikTokWorkflowGraph(): AutomationWorkflowGraph {
  const nodes: AutomationNode[] = [
    node({
      id: "manual-run", type: "core.manual-trigger", name: "Run", description: "Start from the Automation panel.", position: { x: 0, y: 240 },
      config: {},
    }),
    node({
      id: "tiktok-source", type: "input.tiktok-source", name: "TikTok slideshow", description: "Use the slideshow selected when the workflow starts.", position: { x: 220, y: 140 },
      bindings: {
        source: { mode: "ask-on-run", label: "Source slideshow", required: true },
      },
    }),
    node({
      id: "identity", type: "input.identity", name: "Identity", description: "Optional person or character references.", position: { x: 220, y: 390 },
      config: { referenceGroup: "auto", optional: true },
      bindings: { identity: { mode: "ask-on-run", label: "Identity", required: false } },
    }),
    node({
      id: "creative-settings", type: "input.creative-settings", name: "Creative settings", description: "Choose what changes when this workflow starts.", position: { x: 220, y: 640 },
      config: { mode: "concept", newOutfit: true, newLocation: true, textStrategy: "rewrite", creativeBrief: "" },
      bindings: {
        mode: { mode: "ask-on-run", value: "concept", label: "Adaptation mode", required: true },
        newOutfit: { mode: "ask-on-run", value: true, label: "New wardrobe or subjects", required: true },
        newLocation: { mode: "ask-on-run", value: true, label: "New location or setting", required: true },
        textStrategy: { mode: "ask-on-run", value: "rewrite", label: "On-screen text", required: true },
        creativeBrief: { mode: "ask-on-run", value: "", label: "Creative direction", required: false },
      },
    }),
    aiNode({
      id: "analyze-source", name: "Analyze slideshow", description: "Identify the hook, roles, composition and transformation boundary.", groupId: "group-understand", position: { x: 580, y: 200 },
      systemPrompt: "You are a visual content analyst. Describe only observable source evidence. Never invent identity, product or campaign facts.",
      userPrompt: "Analyze every ordered slide in {{ primary }}. Return one entry per slide with role, visible text, visual brief, face visibility, framing and confidence. Preserve the original indexes.",
      responseSchema: { type: "object", required: ["format", "summary", "slides"], properties: { format: { type: "string" }, summary: { type: "string" }, theme: { type: "string" }, narrativeArc: { type: "string" }, language: { type: "string" }, transformationBoundary: { type: "integer" }, slides: { type: "array", items: { type: "object" } } } },
    }),
    aiNode({
      id: "decompose-copy", name: "Decompose source copy", description: "Separate meaning, hook and visual dependency from literal wording.", groupId: "group-understand", position: { x: 940, y: 360 },
      systemPrompt: "You are a short-form copy analyst. Preserve function and meaning without treating source wording as a reusable template.",
      userPrompt: "For each slide in {{ primary }}, explain the copy function, literal meaning, emotional job and whether the line depends on the image. Return the same slide indexes.",
      responseSchema: { type: "object", required: ["slides"], properties: { slides: { type: "array", items: { type: "object", required: ["index", "referenceIds"], properties: { index: { type: "integer" }, referenceIds: { type: "array", items: { type: "string" } }, responsibilities: { type: "array", items: { type: "string" } } } } } } },
    }),
    aiNode({
      id: "inspect-identity", name: "Inspect identity", description: "Describe which references are useful for face, profile, body and pose.", groupId: "group-adapt", position: { x: 1480, y: 520 },
      systemPrompt: "You inspect identity reference images. Report observable evidence only. Do not infer sensitive traits.",
      userPrompt: "Inspect {{ primary }} and return evidence for each reference: visible face angle, framing, capture style and useful identity signals. If no identity is supplied, return an empty asset list.",
      responseSchema: { type: "object", required: ["assets"], properties: { assets: { type: "array", items: { type: "object" } } } },
      runWhen: "primary != null",
    }),
    aiNode({
      id: "interpret-brief", name: "Interpret creative brief", description: "Convert run choices into an explicit campaign and slide contract.", groupId: "group-adapt", position: { x: 1480, y: 180 },
      systemPrompt: "You are a creative director. User choices are requirements, source slides are structural evidence, and target references define identity only.",
      userPrompt: "Using source analysis {{ primary }}, runtime choices {{ context }} and optional identity evidence {{ identity }}, produce an explicit campaign direction, global constraints and one intent per original slide.",
      responseSchema: { type: "object", required: ["userIntentSummary", "requirements", "campaign", "sequence", "slides"], properties: { userIntentSummary: { type: "string" }, requirements: { type: "array", items: { type: "object" } }, globalRules: { type: "array", items: { type: "string" } }, campaign: { type: "object" }, sequence: { type: "object" }, slides: { type: "array", items: { type: "object" } } } },
    }),
    aiNode({
      id: "rewrite-copy", name: "Rewrite copy", description: "Create original on-screen copy while preserving each slide's job.", groupId: "group-adapt", position: { x: 1880, y: 180 },
      systemPrompt: "You write concise on-screen copy for short-form visual content. Follow the selected keep, rewrite or remove strategy exactly.",
      userPrompt: "Rewrite the sequence using creative direction {{ primary }} and source decomposition {{ context }}. Keep the original slide indexes and preserve the narrative progression.",
      responseSchema: { type: "object", required: ["slides"], properties: { slides: { type: "array", items: { type: "object", required: ["index", "overlayText"] } } } },
    }),
    aiNode({
      id: "review-copy", name: "Review copy", description: "Reject duplicated, inconsistent or visually impossible lines.", groupId: "group-adapt", position: { x: 2240, y: 180 },
      systemPrompt: "You are a strict sequence editor. Approve only copy that is original, consistent and achievable in its assigned visual.",
      userPrompt: "Review {{ primary }} against creative direction and source roles in {{ context }}. Return corrected copy for every slide and list any changes made.",
      responseSchema: { type: "object", required: ["slides", "passed"], properties: { passed: { type: "boolean" }, slides: { type: "array", items: { type: "object" } }, issues: { type: "array", items: { type: "string" } } } },
      maxAttempts: 2,
    }),
    aiNode({
      id: "bind-references", name: "Assign references", description: "Select only the identity evidence required by each slide.", groupId: "group-adapt", position: { x: 1880, y: 500 },
      systemPrompt: "You assign image references conservatively. Source frames control composition; identity references control identity only. Never exceed the downstream model limit.",
      userPrompt: "For every slide in {{ primary }}, select required identity evidence using {{ identity }} and the creative constraints in {{ context }}. Return stable asset ids and responsibilities.",
      responseSchema: { type: "object", required: ["slides"], properties: { slides: { type: "array", items: { type: "object" } } } },
    }),
    node({
      id: "assemble-contract", type: "logic.transform", name: "Assemble contract", description: "Combine reviewed copy, intent and reference assignments.", groupId: "group-build", position: { x: 2860, y: 220 },
      config: { template: { intent: "{{ inputs[0] }}", copy: "{{ inputs[1] }}", references: "{{ inputs[2] }}" } },
    }),
    aiNode({
      id: "plan-slides", name: "Plan every slide", description: "Create generation prompts with exact preservation and change rules.", groupId: "group-build", position: { x: 3220, y: 220 },
      systemPrompt: "You are an image-generation director. Produce independently executable prompts that obey the semantic contract and use only assigned references.",
      userPrompt: "Build one generation plan per slide from {{ primary }}. Include prompt, overlay text, preserve rules, change rules, reference ids and confidence. Never omit or reorder a slide.",
      responseSchema: { type: "object", required: ["slides"], properties: { slides: { type: "array", items: { type: "object", required: ["index", "role", "prompt", "overlayText", "referenceIds"], properties: { index: { type: "integer" }, role: { type: "string" }, prompt: { type: "string" }, overlayText: { type: "string" }, referenceIds: { type: "array", items: { type: "string" } }, preserveRules: { type: "array", items: { type: "string" } }, changeRules: { type: "array", items: { type: "string" } } } } } } },
    }),
    aiNode({
      id: "review-series", name: "Review complete series", description: "Find identity, copy, narrative and composition inconsistencies.", groupId: "group-review", position: { x: 3780, y: 220 },
      systemPrompt: "You are the final QA reviewer for a complete visual series. Report concrete, repairable failures only.",
      userPrompt: "Review all plans in {{ primary }} together. Check requirement coverage, progression, identity usage, reference limits and whether each prompt is independently executable.",
      responseSchema: { type: "object", required: ["passed", "slides"], properties: { passed: { type: "boolean" }, slides: { type: "array", items: { type: "object" } } } },
      maxAttempts: 2,
    }),
    aiNode({
      id: "repair-slides", name: "Repair failed slides", description: "Change only plans that failed the complete-series review.", groupId: "group-review", position: { x: 4160, y: 220 },
      systemPrompt: "You repair only the identified failures. Preserve already approved decisions and stable slide indexes.",
      userPrompt: "Apply review feedback {{ primary }} to the original plans in {{ context }}. Return the complete final set, changing only failed slides.",
      responseSchema: { type: "object", required: ["slides"], properties: { slides: { type: "array", items: { type: "object", required: ["index", "role", "prompt", "overlayText", "referenceIds"], properties: { index: { type: "integer" }, role: { type: "string" }, prompt: { type: "string" }, overlayText: { type: "string" }, referenceIds: { type: "array", items: { type: "string" } }, preserveRules: { type: "array", items: { type: "string" } }, changeRules: { type: "array", items: { type: "string" } } } } } } },
      maxAttempts: 2,
    }),
    node({
      id: "validate-slide-plans", type: "logic.validate-slide-plans", name: "Validate slide plans", description: "Fail before generation if indexes, prompts or references are malformed.", position: { x: 4520, y: 220 },
      config: { maxSlides: 40 },
    }),
    node({
      id: "generate-images", type: "generation.image", name: "Generate images", description: "Generate the reviewed series with bounded concurrency.", position: { x: 4860, y: 220 },
      config: { modelId: "nano-banana-2", ratio: "9:16", resolution: "1K", concurrency: 3, maxAttempts: 3, partialFailure: "keep-successful" },
      bindings: { modelId: { mode: "ask-on-run", label: "Image model", required: true } },
    }),
    node({
      id: "add-to-canvas", type: "output.add-to-canvas", name: "Add to canvas", description: "Apply generated assets and lineage to the open canvas.", position: { x: 5240, y: 220 },
      config: { layout: "beside-source", includePlanNote: true },
    }),
  ];

  const edges = [
    edge("manual-run", "run", "tiktok-source", "run"),
    edge("manual-run", "run", "identity", "run"),
    edge("manual-run", "run", "creative-settings", "run"),
    edge("tiktok-source", "source", "analyze-source", "primary"),
    edge("tiktok-source", "source", "decompose-copy", "primary"),
    edge("identity", "identity", "inspect-identity", "primary"),
    edge("analyze-source", "result", "interpret-brief", "primary"),
    edge("inspect-identity", "result", "interpret-brief", "context"),
    edge("creative-settings", "settings", "interpret-brief", "context"),
    edge("identity", "identity", "interpret-brief", "identity"),
    edge("interpret-brief", "result", "rewrite-copy", "primary"),
    edge("decompose-copy", "result", "rewrite-copy", "context"),
    edge("rewrite-copy", "result", "review-copy", "primary"),
    edge("interpret-brief", "result", "review-copy", "context"),
    edge("review-copy", "result", "bind-references", "primary"),
    edge("interpret-brief", "result", "bind-references", "context"),
    edge("inspect-identity", "result", "bind-references", "context"),
    edge("identity", "identity", "bind-references", "identity"),
    edge("interpret-brief", "result", "assemble-contract", "data"),
    edge("review-copy", "result", "assemble-contract", "data"),
    edge("bind-references", "result", "assemble-contract", "data"),
    edge("assemble-contract", "result", "plan-slides", "primary"),
    edge("plan-slides", "result", "review-series", "primary"),
    edge("review-series", "result", "repair-slides", "primary"),
    edge("plan-slides", "result", "repair-slides", "context"),
    edge("repair-slides", "result", "validate-slide-plans", "data"),
    edge("validate-slide-plans", "plans", "generate-images", "plans"),
    edge("tiktok-source", "source", "generate-images", "source"),
    edge("identity", "identity", "generate-images", "identity"),
    edge("generate-images", "assets", "add-to-canvas", "assets"),
    edge("tiktok-source", "source", "add-to-canvas", "source"),
  ];

  return { schemaVersion: 1, nodes, edges, groups, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS }, viewport: { x: 20, y: 100, zoom: 0.78 } };
}
