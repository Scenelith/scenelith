import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationAnnotation, type AutomationEdge, type AutomationEdgeRole, type AutomationGroup, type AutomationNode, type AutomationWorkflowGraph } from "./types";

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

function edge(source: string, sourcePort: string, target: string, targetPort: string, role: AutomationEdgeRole = "flow"): AutomationEdge {
  return { id: `${source}:${sourcePort}->${target}:${targetPort}`, source, sourcePort, target, targetPort, role };
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
    version: 2,
    name: input.name,
    description: input.description,
    groupId: input.groupId,
    position: input.position,
    config: {
      modelId: defaultPlanningModel,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      outputMode: "structured",
      responseSchema: input.responseSchema,
      creativity: "consistent",
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

const text = { type: "string" } as const;
const integer = { type: "integer", minimum: 1 } as const;
const confidence = { type: "number", minimum: 0, maximum: 1 } as const;
const strings = { type: "array", items: text } as const;
function strictObject(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
function list(items: Record<string, unknown>) {
  return { type: "array", items };
}

const sourceAnalysisSchema = strictObject({
  format: text,
  summary: text,
  theme: text,
  narrativeArc: text,
  language: text,
  transformationBoundary: { type: "integer", minimum: 0 },
  slides: list(strictObject({ index: integer, role: text, visibleText: text, visualBrief: text, faceVisibility: text, framing: text, confidence })),
});
const copyAnalysisSchema = strictObject({
  slides: list(strictObject({ index: integer, copyFunction: text, literalMeaning: text, emotionalJob: text, dependsOnImage: { type: "boolean" } })),
});
const identityEvidenceSchema = strictObject({
  assets: list(strictObject({ id: text, faceAngle: text, framing: text, captureStyle: text, identitySignals: strings })),
});
const creativeBriefSchema = strictObject({
  userIntentSummary: text,
  requirements: strings,
  globalRules: strings,
  decisions: strictObject({
    newOutfit: { type: "boolean" },
    newLocation: { type: "boolean" },
    textStrategy: { type: "string", enum: ["keep", "rewrite", "remove"] },
  }),
  campaign: strictObject({ direction: text, audience: text, tone: text }),
  sequence: strictObject({ hook: text, progression: text, payoff: text }),
  slides: list(strictObject({ index: integer, intent: text, mustKeep: strings, mayChange: strings })),
});
const copySequenceSchema = strictObject({
  slides: list(strictObject({ index: integer, overlayText: text, copyFunction: text })),
});
const reviewedCopySchema = strictObject({
  passed: { type: "boolean" },
  slides: list(strictObject({ index: integer, overlayText: text, copyFunction: text })),
  issues: strings,
});
const referenceAssignmentsSchema = strictObject({
  slides: list(strictObject({ index: integer, referenceIds: strings, responsibilities: strings })),
});
const slidePlansSchema = strictObject({
  slides: list(strictObject({
    index: integer,
    role: text,
    prompt: { type: "string", minLength: 1 },
    overlayText: text,
    referenceIds: strings,
    preserveRules: strings,
    changeRules: strings,
    confidence,
  })),
});
const seriesReviewSchema = strictObject({
  passed: { type: "boolean" },
  slides: list(strictObject({ index: integer, passed: { type: "boolean" }, issues: strings })),
});

const groups: AutomationGroup[] = [
  { id: "group-understand", name: "Understand source", description: "Read the slideshow and its visual mechanic.", position: { x: 760, y: 120 }, size: { width: 620, height: 430 }, collapsedByDefault: true, nodeIds: ["analyze-source"] },
  { id: "group-adapt", name: "Define the new version", description: "Choose the adaptation route, preservation rules, text handling and identity references.", position: { x: 760, y: 296 }, size: { width: 2400, height: 1260 }, collapsedByDefault: true, nodeIds: ["adaptation-mode-choice", "rebuild-concept-mode", "keep-concept-mode", "inspect-identity", "wardrobe-choice", "allow-wardrobe-change", "preserve-wardrobe", "location-choice", "allow-location-change", "preserve-location", "interpret-brief", "text-route-rewrite", "text-route-keep", "decompose-copy", "rewrite-copy", "review-copy", "keep-copy", "remove-copy", "select-copy", "bind-references"] },
  { id: "group-build", name: "Build slides", description: "Assemble the contract and plan every output slide.", position: { x: 3400, y: 296 }, size: { width: 620, height: 430 }, collapsedByDefault: true, nodeIds: ["assemble-contract", "plan-slides"] },
  { id: "group-review", name: "Review series", description: "Check the complete sequence and repair only failed slides.", position: { x: 4060, y: 296 }, size: { width: 620, height: 430 }, collapsedByDefault: true, nodeIds: ["review-series", "repair-slides"] },
];

const annotations: AutomationAnnotation[] = [{
  id: "workflow-reading-guide",
  kind: "sticky-note",
  title: "Start here — how this automation works",
  color: "yellow",
  position: { x: 100, y: -720 },
  size: { width: 2000, height: 660 },
  markdown: `## Follow the data from left to right

Each card performs one visible job. A line starts at an output socket and ends at the exact input socket that receives its result. Select a card to highlight only the cards and lines immediately before and after it; nothing farther away is hidden or implied.

\`1. START + INPUTS\` → \`2. UNDERSTAND\` → \`3. ADAPT\` → \`4. BUILD\` → \`5. CHECK\` → \`6. CREATE + RETURN\`

### 1. Start and collect the inputs
- **Run** sends the start signal and trigger metadata. In this template, it tells the three input steps to read their selected values.
- **TikTok slideshow** loads the ordered source slides. It passes the same source to both analysis steps, image creation and the final canvas output.
- **Identity** loads an optional saved person or character when one is selected. It is passed to identity analysis, reference matching and image creation; the workflow can also run without it.
- **Visual references** loads optional images chosen from this canvas or the workspace Library. These can describe a product, place, pose, composition or style without pretending they are an identity.
- **Creative settings** turns your run choices into structured instructions: what may change, what must be preserved, what happens to the text and any extra direction.
- **Adaptation route** reads the selected mode and activates exactly one visible instruction: **Rebuild for a new concept** or **Keep concept, change the person**. The other card and its lines switch off before the run. Both routes continue into the same brief step, so the canvas preview and the executed workflow use the same choice.
- **Wardrobe route** and **Location route** each choose one real path. Their visible **Allow change** and **Preserve source** cards create explicit instructions for the brief. The unselected card and its connecting lines switch off before the run, so turning a switch off never forgets that property.
- **Text routes** choose exactly one of **Keep original text**, **Write new text** or **Remove text**. Unselected cards and their lines are skipped and shown as inactive before the run.

### 2. Understand the source before changing it
- **Understand every slide** reads the source images and finds each slide's role, hook, composition, visible text and place in the sequence.
- **Understand the original text** separately finds what each line means and what job it performs, so the wording can change without losing the story.
- **Choose useful identity references** runs only when an identity exists. It describes which saved images clearly show the face, body, angle or pose.
- These are separate preparation branches. They do not depend on one another. A later card waits only for the inputs visibly connected to its sockets.

### 3. Decide what the new version should become
- **Turn choices into a clear brief** receives source understanding as its main input, then adds Creative settings and optional identity evidence through separate supporting inputs. It returns one shared brief.
- **Write the new on-screen text** uses that brief plus the meaning of the original text. It creates new wording for every original slide index.
- **Check the new text** compares the draft with the brief and fixes repetition, inconsistency or text that would not fit the planned visual.
- **Match references to slides** combines the checked text, brief, identity evidence and optional visual references, then assigns only the images each slide actually needs.

### 4. Build one executable plan per image
- **Merge the approved plan** has three separate named inputs: \`brief\`, \`copy\` and \`references\`. It waits for all three connected branches and creates one predictable planning package. Nothing is generated yet.
- **Plan every image** turns that merged information into one complete plan per slide: prompt, overlay text, what must stay, what may change and which references are allowed.
- This separation matters: the creative decisions are settled before the workflow calls the image model.

### 5. Check the whole series before generation
- **Check the complete series** reviews all slide plans together for story progression, identity consistency, wording, reference limits and missing requirements.
- **Fix only problem slides** receives the review as its main input and the original plans as supporting context. It changes failed slides while leaving approved slides untouched.
- **Check that every plan is usable** receives the repaired plans plus the source, optional identity and optional visual references. It performs a strict final gate: every slide must have an index, instructions and valid references before generation can begin.

### 6. Create the assets and return them to the canvas
- **Create the images** receives the validated plans, original source, optional identity and optional visual references. It creates each slide with the selected image model and keeps successful results if one slide needs a retry.
- **Add slideshow to canvas** receives the generated assets plus the original source. It places the finished branch beside the source so every result stays editable and connected.
- The workflow ends here. The output is now regular canvas content; the guide note itself never runs and never enters the data flow.

> To inspect one handoff, select either card. Its direct incoming lines show what it needs; its direct outgoing lines show who receives its result. Open the card's Guide for a plain-language explanation, then Settings to see the exact saved values.`,
}];

export function createDefaultTikTokWorkflowGraph(): AutomationWorkflowGraph {
  const nodes: AutomationNode[] = [
    node({
      id: "manual-run", type: "core.manual-trigger", name: "Run", description: "Start from the Automation panel.", position: { x: 100, y: 296 },
      config: {},
    }),
    node({
      id: "tiktok-source", type: "input.tiktok-source", name: "TikTok slideshow", description: "Use the slideshow selected when the workflow starts.", position: { x: 430, y: 120 },
      bindings: {
        source: { mode: "ask-on-run", label: "Source slideshow", required: true },
      },
    }),
    node({
      id: "identity", type: "input.identity", name: "Identity", description: "Optional person or character references.", position: { x: 430, y: 296 },
      config: { referenceGroup: "auto", optional: true },
      bindings: { identity: { mode: "ask-on-run", label: "Identity", required: false } },
    }),
    node({
      id: "creative-settings", type: "input.creative-settings", name: "Creative settings", description: "Choose what changes when this workflow starts.", position: { x: 430, y: 472 },
      config: { mode: "concept", newOutfit: true, newLocation: true, textStrategy: "rewrite", creativeBrief: "" },
      bindings: {
        mode: { mode: "ask-on-run", value: "concept", label: "Adaptation mode", required: true },
        newOutfit: { mode: "ask-on-run", value: true, label: "New wardrobe or subjects", required: true },
        newLocation: { mode: "ask-on-run", value: true, label: "New location or setting", required: true },
        textStrategy: { mode: "ask-on-run", value: "rewrite", label: "On-screen text", required: true },
        creativeBrief: { mode: "ask-on-run", value: "", label: "Creative direction", required: false },
      },
    }),
    node({
      id: "visual-references", type: "input.visual-references", name: "Visual references", description: "Optional composition, product, place, pose or style images.", position: { x: 430, y: 648 },
      config: { references: [], maxItems: 8, optional: true },
      bindings: { references: { mode: "ask-on-run", label: "Visual references", required: false } },
    }),
    node({
      id: "adaptation-mode-choice", type: "logic.condition", name: "Rebuild the concept?", description: "Choose the real workflow path that matches the selected adaptation mode.", groupId: "group-adapt", position: { x: 760, y: 384 },
      config: { path: "mode", operator: "equals", compareValue: "concept" },
    }),
    node({
      id: "rebuild-concept-mode", type: "logic.transform", name: "Rebuild for a new concept", description: "Tell the brief to create a new concept while preserving the source structure that still matters.", groupId: "group-adapt", position: { x: 1090, y: 296 },
      config: { template: { choice: "{{ inputs.0 }}", adaptation: { mode: "concept", instruction: "Rebuild the source into a new concept. Preserve useful structure, hook and sequence mechanics, but create a distinct campaign direction." } } },
    }),
    node({
      id: "keep-concept-mode", type: "logic.transform", name: "Keep concept, change the person", description: "Tell the brief to preserve the source concept and mainly adapt the selected person or character.", groupId: "group-adapt", position: { x: 1090, y: 472 },
      config: { template: { choice: "{{ inputs.0 }}", adaptation: { mode: "identity", instruction: "Keep the source concept, hook, sequence and scene intent. Adapt the person or character using the selected identity without inventing a different campaign concept." } } },
    }),
    node({
      id: "wardrobe-choice", type: "logic.condition", name: "Change the wardrobe or subjects?", description: "Route the brief through Change or Preserve using the run choice.", groupId: "group-adapt", position: { x: 1090, y: 824 },
      config: { path: "newOutfit", operator: "equals", compareValue: true },
    }),
    node({
      id: "allow-wardrobe-change", type: "logic.transform", name: "Allow a new wardrobe or subjects", description: "Tell the brief that wardrobe or subjects may change in the new version.", groupId: "group-adapt", position: { x: 1420, y: 736 },
      config: { template: { choice: "{{ inputs.0 }}", wardrobe: { mode: "change", instruction: "Create a new wardrobe or new subjects when the brief needs them." } } },
    }),
    node({
      id: "preserve-wardrobe", type: "logic.transform", name: "Preserve the source wardrobe", description: "Tell the brief to keep the source wardrobe or subjects unchanged.", groupId: "group-adapt", position: { x: 1420, y: 912 },
      config: { template: { choice: "{{ inputs.0 }}", wardrobe: { mode: "preserve", instruction: "Preserve the source wardrobe and subjects; do not replace them." } } },
    }),
    node({
      id: "location-choice", type: "logic.condition", name: "Change the location?", description: "Route the brief through Change or Preserve using the run choice.", groupId: "group-adapt", position: { x: 1090, y: 1176 },
      config: { path: "newLocation", operator: "equals", compareValue: true },
    }),
    node({
      id: "allow-location-change", type: "logic.transform", name: "Allow a new location", description: "Tell the brief that the setting may change in the new version.", groupId: "group-adapt", position: { x: 1420, y: 1088 },
      config: { template: { choice: "{{ inputs.0 }}", location: { mode: "change", instruction: "Create a new location or setting when the brief needs one." } } },
    }),
    node({
      id: "preserve-location", type: "logic.transform", name: "Preserve the source location", description: "Tell the brief to keep the source setting unchanged.", groupId: "group-adapt", position: { x: 1420, y: 1264 },
      config: { template: { choice: "{{ inputs.0 }}", location: { mode: "preserve", instruction: "Preserve the source location and setting; do not replace them." } } },
    }),
    node({
      id: "text-route-rewrite", type: "logic.condition", name: "Write new on-screen text?", description: "Choose the rewrite route when the run asks for new wording.", groupId: "group-adapt", position: { x: 1750, y: 120 },
      config: { path: "textStrategy", operator: "equals", compareValue: "rewrite" },
    }),
    node({
      id: "text-route-keep", type: "logic.condition", name: "Keep the original text?", description: "Choose Keep when selected; otherwise continue to Remove.", groupId: "group-adapt", position: { x: 2080, y: 472 },
      config: { path: "textStrategy", operator: "equals", compareValue: "keep" },
    }),
    aiNode({
      id: "analyze-source", name: "Understand every slide", description: "Find what makes each slide work: its hook, message, people and composition.", groupId: "group-understand", position: { x: 760, y: 120 },
      systemPrompt: "You are a visual content analyst. Describe only observable source evidence. Never invent identity, product or campaign facts.",
      userPrompt: "Analyze every ordered slide in {{ primary }}. Return one entry per slide with role, visible text, visual brief, face visibility, framing and confidence. Preserve the original indexes.",
      responseSchema: sourceAnalysisSchema,
    }),
    aiNode({
      id: "decompose-copy", name: "Understand the original text", description: "Separate what the text means from the exact words used in the source.", groupId: "group-adapt", position: { x: 2080, y: 120 },
      systemPrompt: "You are a short-form copy analyst. Preserve function and meaning without treating source wording as a reusable template.",
      userPrompt: "The selected text route is {{ primary }}. For each source slide connected in {{ context }}, explain the copy function, literal meaning, emotional job and whether the line depends on the image. Return the same slide indexes.",
      responseSchema: copyAnalysisSchema,
    }),
    aiNode({
      id: "inspect-identity", name: "Choose useful identity references", description: "Work out which saved images best show the face, body, profile and pose.", groupId: "group-adapt", position: { x: 1090, y: 648 },
      systemPrompt: "You inspect identity reference images. Report observable evidence only. Do not infer sensitive traits.",
      userPrompt: "Inspect {{ primary }} and return evidence for each reference: visible face angle, framing, capture style and useful identity signals. If no identity is supplied, return an empty asset list.",
      responseSchema: identityEvidenceSchema,
      runWhen: "primary != null",
    }),
    aiNode({
      id: "interpret-brief", name: "Turn choices into a clear brief", description: "Turn your source, identity and creative choices into instructions for the new version.", groupId: "group-adapt", position: { x: 1420, y: 296 },
      systemPrompt: "You are a creative director. User choices are requirements, source slides are structural evidence, and target references define identity only.",
      userPrompt: "Using source analysis {{ primary }}, the connected creative choices and optional reference analysis in {{ context }}, plus the optional saved identity in {{ identity }}, produce an explicit campaign direction, global constraints, the exact wardrobe/location/text decisions and one intent per original slide. A false wardrobe or location decision means preserve the source property explicitly; it never means ignore it.",
      responseSchema: creativeBriefSchema,
    }),
    aiNode({
      id: "rewrite-copy", name: "Write the new on-screen text", description: "Create original wording while keeping the purpose of each slide.", groupId: "group-adapt", position: { x: 2410, y: 120 },
      systemPrompt: "You write concise on-screen copy for short-form visual content. Follow the selected keep, rewrite or remove strategy exactly.",
      userPrompt: "Rewrite the sequence using creative direction {{ primary }} and source decomposition {{ context }}. Keep the original slide indexes and preserve the narrative progression.",
      responseSchema: copySequenceSchema,
    }),
    aiNode({
      id: "review-copy", name: "Check the new text", description: "Catch repeated, inconsistent or visually impossible lines before planning images.", groupId: "group-adapt", position: { x: 2740, y: 120 },
      systemPrompt: "You are a strict sequence editor. Approve only copy that is original, consistent and achievable in its assigned visual.",
      userPrompt: "Review {{ primary }} against creative direction and source roles in {{ context }}. Return corrected copy for every slide and list any changes made.",
      responseSchema: reviewedCopySchema,
      maxAttempts: 2,
    }),
    aiNode({
      id: "keep-copy", name: "Keep the original on-screen text", description: "Copy the source wording exactly when the run chooses Keep.", groupId: "group-adapt", position: { x: 2410, y: 472 },
      systemPrompt: "You preserve source on-screen text exactly. Never rewrite, translate, improve or invent wording.",
      userPrompt: "The selected text route is {{ primary }}. Return one entry per source slide connected in {{ context }} with the same slide index and the exact visible on-screen wording. Use an empty string only when the source slide has no text.",
      responseSchema: copySequenceSchema,
    }),
    aiNode({
      id: "remove-copy", name: "Remove all on-screen text", description: "Create an empty text sequence when the run chooses Remove.", groupId: "group-adapt", position: { x: 2410, y: 648 },
      systemPrompt: "You remove on-screen text while preserving the ordered slide list. Never add replacement wording.",
      userPrompt: "The selected text route is {{ primary }}. Return one entry per source slide connected in {{ context }} with the same index, an empty overlayText value and a short copyFunction explaining that no overlay should be rendered.",
      responseSchema: copySequenceSchema,
    }),
    node({
      id: "select-copy", type: "logic.transform", name: "Continue with the selected text", description: "Pass the result from the one active text route to planning.", groupId: "group-adapt", position: { x: 3070, y: 296 },
      config: { template: { selected: "{{ inputs.0 }}" } },
    }),
    aiNode({
      id: "bind-references", name: "Match references to slides", description: "Choose only the saved identity images each slide actually needs.", groupId: "group-adapt", position: { x: 2740, y: 648 },
      systemPrompt: "You assign image references conservatively. Source frames control composition. Identity references control identity only. Other visual references may control only the observable job they were chosen for. Use only asset ids present in connected inputs.",
      userPrompt: "For every slide in {{ primary }}, use the connected brief, optional identity analysis and optional visual-reference package in {{ context }}, plus the available identity record in {{ identity }}. Return only stable asset ids that exist in those connected inputs, with one clear responsibility per selected reference. Return an empty reference list when no extra image is needed.",
      responseSchema: referenceAssignmentsSchema,
    }),
    node({
      id: "assemble-contract", type: "logic.merge", name: "Merge the approved plan", description: "Wait for the approved brief, copy and references, then name them inside one planning package.", groupId: "group-build", position: { x: 3400, y: 296 },
      config: { mode: "named-object", inputs: [
        { id: "input-copy", name: "copy" },
        { id: "input-brief", name: "brief" },
        { id: "input-references", name: "references" },
      ] },
    }),
    aiNode({
      id: "plan-slides", name: "Plan every image", description: "Describe what each image should keep, what should change and how it should look.", groupId: "group-build", position: { x: 3730, y: 296 },
      systemPrompt: "You are an image-generation director. Produce independently executable prompts that obey the semantic contract and use only assigned references.",
      userPrompt: "Build one generation plan per slide from {{ primary }}. Include prompt, overlay text, preserve rules, change rules, reference ids and confidence. Never omit or reorder a slide.",
      responseSchema: slidePlansSchema,
    }),
    aiNode({
      id: "review-series", name: "Check the complete series", description: "Find identity, wording, story or composition problems across all slides.", groupId: "group-review", position: { x: 4060, y: 120 },
      systemPrompt: "You are the final QA reviewer for a complete visual series. Report concrete, repairable failures only.",
      userPrompt: "Review all plans in {{ primary }} together. Check requirement coverage, progression, identity usage, duplicate references and whether each prompt is independently executable.",
      responseSchema: seriesReviewSchema,
      maxAttempts: 2,
    }),
    aiNode({
      id: "repair-slides", name: "Fix only problem slides", description: "Correct the plans that failed review and leave approved slides unchanged.", groupId: "group-review", position: { x: 4390, y: 296 },
      systemPrompt: "You repair only the identified failures. Preserve already approved decisions and stable slide indexes.",
      userPrompt: "Apply review feedback {{ primary }} to the original plans in {{ context }}. Return the complete final set, changing only failed slides.",
      responseSchema: slidePlansSchema,
      maxAttempts: 2,
    }),
    node({
      id: "validate-slide-plans", type: "logic.validate-slide-plans", name: "Check that every plan is usable", description: "Stop before creating images if a slide is missing its number, instructions or references.", position: { x: 4720, y: 296 },
      config: { maxSlides: 40 },
    }),
    node({
      id: "generate-images", type: "generation.image", name: "Create the images", description: "Create the reviewed slide plans with the selected image model.", position: { x: 5050, y: 296 },
      config: { modelId: "nano-banana-2", ratio: "9:16", resolution: "1K", concurrency: 3, maxAttempts: 3, partialFailure: "keep-successful" },
      bindings: { modelId: { mode: "ask-on-run", label: "Image model", required: true } },
    }),
    node({
      id: "add-to-canvas", type: "output.add-to-canvas", name: "Add slideshow to canvas", description: "Place the finished images beside their source so you can keep editing them.", position: { x: 5380, y: 296 },
      config: { layout: "beside-source", includePlanNote: true },
    }),
  ];

  const edges = [
    edge("manual-run", "run", "tiktok-source", "run"),
    edge("manual-run", "run", "identity", "run"),
    edge("manual-run", "run", "creative-settings", "run"),
    edge("manual-run", "run", "visual-references", "run"),
    edge("tiktok-source", "source", "analyze-source", "primary"),
    edge("identity", "identity", "inspect-identity", "primary"),
    edge("analyze-source", "result", "interpret-brief", "primary"),
    edge("inspect-identity", "result", "interpret-brief", "context", "data"),
    edge("visual-references", "references", "interpret-brief", "context", "data"),
    edge("creative-settings", "settings", "wardrobe-choice", "data"),
    edge("creative-settings", "settings", "location-choice", "data"),
    edge("creative-settings", "settings", "adaptation-mode-choice", "data"),
    edge("adaptation-mode-choice", "yes", "rebuild-concept-mode", "data"),
    edge("adaptation-mode-choice", "no", "keep-concept-mode", "data"),
    edge("rebuild-concept-mode", "result", "interpret-brief", "context", "data"),
    edge("keep-concept-mode", "result", "interpret-brief", "context", "data"),
    edge("wardrobe-choice", "yes", "allow-wardrobe-change", "data"),
    edge("wardrobe-choice", "no", "preserve-wardrobe", "data"),
    edge("allow-wardrobe-change", "result", "interpret-brief", "context", "data"),
    edge("preserve-wardrobe", "result", "interpret-brief", "context", "data"),
    edge("location-choice", "yes", "allow-location-change", "data"),
    edge("location-choice", "no", "preserve-location", "data"),
    edge("allow-location-change", "result", "interpret-brief", "context", "data"),
    edge("preserve-location", "result", "interpret-brief", "context", "data"),
    edge("identity", "identity", "interpret-brief", "identity", "data"),
    edge("creative-settings", "settings", "text-route-rewrite", "data"),
    edge("text-route-rewrite", "yes", "decompose-copy", "primary"),
    edge("tiktok-source", "source", "decompose-copy", "context", "data"),
    edge("decompose-copy", "result", "rewrite-copy", "primary"),
    edge("interpret-brief", "result", "rewrite-copy", "context", "data"),
    edge("rewrite-copy", "result", "review-copy", "primary"),
    edge("interpret-brief", "result", "review-copy", "context", "data"),
    edge("text-route-rewrite", "no", "text-route-keep", "data"),
    edge("text-route-keep", "yes", "keep-copy", "primary"),
    edge("text-route-keep", "no", "remove-copy", "primary"),
    edge("tiktok-source", "source", "keep-copy", "context", "data"),
    edge("tiktok-source", "source", "remove-copy", "context", "data"),
    edge("review-copy", "result", "select-copy", "data"),
    edge("keep-copy", "result", "select-copy", "data"),
    edge("remove-copy", "result", "select-copy", "data"),
    edge("select-copy", "result", "bind-references", "primary"),
    edge("interpret-brief", "result", "bind-references", "context", "data"),
    edge("inspect-identity", "result", "bind-references", "context", "data"),
    edge("visual-references", "references", "bind-references", "context", "data"),
    edge("identity", "identity", "bind-references", "identity", "data"),
    edge("interpret-brief", "result", "assemble-contract", "input-brief", "data"),
    edge("select-copy", "result", "assemble-contract", "input-copy", "data"),
    edge("bind-references", "result", "assemble-contract", "input-references"),
    edge("assemble-contract", "result", "plan-slides", "primary"),
    edge("plan-slides", "result", "review-series", "primary"),
    edge("review-series", "result", "repair-slides", "primary"),
    edge("plan-slides", "result", "repair-slides", "context", "data"),
    edge("repair-slides", "result", "validate-slide-plans", "data"),
    edge("tiktok-source", "source", "validate-slide-plans", "source", "data"),
    edge("identity", "identity", "validate-slide-plans", "identity", "data"),
    edge("visual-references", "references", "validate-slide-plans", "references", "data"),
    edge("validate-slide-plans", "plans", "generate-images", "plans"),
    edge("tiktok-source", "source", "generate-images", "source", "data"),
    edge("identity", "identity", "generate-images", "identity", "data"),
    edge("visual-references", "references", "generate-images", "references", "data"),
    edge("generate-images", "assets", "add-to-canvas", "assets"),
    edge("tiktok-source", "source", "add-to-canvas", "source", "data"),
  ];

  return { schemaVersion: 1, nodes, edges, groups, annotations, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS }, viewport: { x: 40, y: 120, zoom: 0.72 } };
}
