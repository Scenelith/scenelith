import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationAnnotation, type AutomationEdge, type AutomationEdgeRole, type AutomationGroup, type AutomationNode, type AutomationWorkflowGraph } from "./types";
import { AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION, AUTOMATION_NO_TEXT_AVOID_INSTRUCTION, AUTOMATION_SOURCE_REFERENCE_INSTRUCTION } from "../generation-prompt-contract";
import { automationSlidePlanCollectionJsonSchema } from "./slide-plan-contract";
import { DEFAULT_AUTOMATION_CREATIVE_CONTROLS } from "./creative-direction-contract";
import { DEFAULT_ASSISTANT_MODEL_ID } from "../assistant-models";

const defaultPlanningModel = DEFAULT_ASSISTANT_MODEL_ID;

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
  groupId: string | null;
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
    bindings: {},
  });
}

const text = { type: "string" } as const;
const integer = { type: "integer", minimum: 1 } as const;
const confidence = { type: "number", minimum: 0, maximum: 1 } as const;
const strings = { type: "array", items: text } as const;
const textStrategy = { type: "string", enum: ["keep", "rewrite", "remove"] } as const;
const referenceRole = { type: "string", enum: ["identity", "location", "pose", "outfit", "style", "product", "supporting visual"] } as const;
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
  slides: list(strictObject({ index: integer, sourceText: text, copyFunction: text, literalMeaning: text, emotionalJob: text, dependsOnImage: { type: "boolean" } })),
});
const identityEvidenceSchema = strictObject({
  assets: list(strictObject({ id: text, faceAngle: text, framing: text, captureStyle: text, identitySignals: strings })),
});
const creativeDirectionRequirementSchema = strictObject({
  id: text,
  instruction: text,
  evidence: text,
  category: { type: "string", enum: ["audience", "offer", "tone", "visual", "copy", "subject", "product", "pacing", "other"] },
  placement: { type: "string", enum: ["preserve", "change", "avoid"] },
  slideIndexes: { type: "array", items: integer },
});
const creativeBriefSchema = strictObject({
  userIntentSummary: text,
  requirements: list(creativeDirectionRequirementSchema),
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
  slides: list(strictObject({ index: integer, sourceText: text, overlayText: text, strategy: textStrategy, instruction: text, copyFunction: text })),
});
const reviewedCopySchema = strictObject({
  passed: { type: "boolean" },
  slides: list(strictObject({ index: integer, sourceText: text, overlayText: text, strategy: textStrategy, instruction: text, copyFunction: text })),
  issues: strings,
});
const referenceAssignmentsSchema = strictObject({
  slides: list(strictObject({
    index: integer,
    references: list(strictObject({ assetId: text, title: text, role: referenceRole, instruction: text })),
  })),
});
const slidePlansSchema = automationSlidePlanCollectionJsonSchema;
const seriesReviewSchema = strictObject({
  passed: { type: "boolean" },
  summary: text,
  slides: list(strictObject({ index: integer, passed: { type: "boolean" }, issues: strings })),
  requirementCoverage: list(strictObject({ requirement: text, passed: { type: "boolean" }, slideIndexes: { type: "array", items: integer }, issues: strings })),
});

const groups: AutomationGroup[] = [
  { id: "group-understand", name: "Understand source", description: "Read the slideshow and its visual mechanic.", position: { x: 760, y: 120 }, size: { width: 620, height: 430 }, collapsedByDefault: true, nodeIds: ["analyze-source"] },
  { id: "group-adapt", name: "Define the new version", description: "Resolve written direction, choose the adaptation route, preservation rules, text handling and identity references.", position: { x: 760, y: 296 }, size: { width: 2400, height: 1610 }, collapsedByDefault: true, nodeIds: ["prepare-user-direction", "interpret-user-direction", "resolve-user-direction", "direction-conflict", "adaptation-mode-choice", "rebuild-concept-mode", "keep-concept-mode", "select-adaptation", "inspect-identity", "wardrobe-choice", "allow-wardrobe-change", "preserve-wardrobe", "select-wardrobe", "location-choice", "allow-location-change", "preserve-location", "select-location", "assemble-choices", "interpret-brief", "text-route-rewrite", "text-route-keep", "decompose-copy", "rewrite-copy", "review-copy", "keep-copy", "remove-copy", "select-copy", "bind-references"] },
  { id: "group-build", name: "Build slides", description: "Assemble the contract and plan every output slide.", position: { x: 3400, y: 296 }, size: { width: 620, height: 430 }, collapsedByDefault: true, nodeIds: ["assemble-contract", "plan-slides"] },
  { id: "group-review", name: "Review series", description: "Check the complete sequence against its source contract and repair only failed slides.", position: { x: 4060, y: 296 }, size: { width: 1940, height: 780 }, collapsedByDefault: true, nodeIds: ["assemble-review-package", "review-series", "assemble-review-gate", "review-passed", "use-approved-plans", "repair-slides", "select-final-plans"] },
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
- **Creative settings** collects the visible switches, optional written direction and one explicit policy: written choices may override only when unambiguous, or they must agree with the switches.
- **Prepare the written direction** freezes the exact comment, configurable switches and raw source indexes. **Understand the written direction** classifies every clause under a fixed strict contract; an empty comment returns an explicit empty analysis without a provider call. **Resolve comments against choices** checks the comment hash, exact evidence ranges, complete wording coverage, confidence and configured options before applying the selected policy. Contradictory, partial or ambiguous wording goes to **Stop for conflicting direction** with the exact phrases and fields to fix.
- **Adaptation route** reads the resolved mode and activates exactly one visible instruction: **Rebuild for a new concept** or **Keep concept, change the person**. The selected path then passes through one join card without asking AI to restate it.
- **Wardrobe route** and **Location route** each choose one real path. Their visible **Allow change** and **Preserve source** cards create explicit instructions. **Lock the run choices** keeps those selected route objects beside the raw switches as one authoritative package, so turning a switch off never forgets that property.
- **Text routes** choose exactly one of **Keep original text**, **Write new text** or **Remove text**. Unselected cards and their lines are skipped and shown as inactive before the run.

### 2. Understand the source before changing it
- **Understand every slide** reads the source images and finds each slide's role, hook, composition, visible text and place in the sequence.
- **Understand the original text** separately finds what each line means and what job it performs, so the wording can change without losing the story.
- **Choose useful identity references** runs only when an identity exists. It describes which saved images clearly show the face, body, angle or pose.
- These are separate preparation branches. They do not depend on one another. A later card waits only for the inputs visibly connected to its sockets.

### 3. Decide what the new version should become
- **Turn choices into a clear brief** receives source understanding as its main input, then adds the authoritative resolved choices package and optional identity evidence through named supporting inputs. It must copy every accepted written requirement with its stable ID and is not allowed to reinterpret a resolved switch.
- **Write the new on-screen text** uses that brief plus the meaning of the original text. It creates new wording for every original slide index.
- **Check the new text** compares the draft with the brief and fixes repetition, inconsistency or text that would not fit the planned visual.
- **Match references to slides** combines the checked text, brief and identity evidence, then assigns only the images each slide actually needs. A duplicated workflow may also connect a Visual references step here when its author needs extra composition, product, place, pose or style images.

### 4. Build one executable plan per image
- **Merge the approved plan** has five separate named inputs: \`sourceAnalysis\`, \`choices\`, \`copy\`, \`brief\` and \`references\`. It waits for every connected branch and creates one predictable planning package. Nothing is generated yet.
- **Plan every image** turns that package into one structured Canvas Assistant-compatible contract per slide: task, subject, scene, exact text operation, preserve/change/avoid arrays, output and reference roles.
- This separation matters: the creative decisions are settled before the workflow calls the image model.

### 5. Check the whole series before generation
- **Check the complete series** receives the complete original contract beside all slide plans and compares every immutable requirement explicitly.
- **Did every requirement pass?** sends approved plans straight onward without another AI rewrite. Only a failed verdict activates **Fix only problem slides**, which receives the contract, original plans and review together.
- **Check every immutable requirement** receives the one selected final plan set plus the original contract, source and optional identity. It also checks any Visual references step deliberately connected by the workflow author. It verifies indexes, exact text operation, resolved choices, every accepted written requirement, reference roles and required JSON fields. It never writes or repairs the prompt; an incomplete model-authored contract stops here.

### 6. Create the assets and return them to the canvas
- **Image Generator** receives the validated plans, original source and optional identity. Custom workflows may connect an additional Visual references step. It serializes each slide into the same structured JSON fields used by Canvas Assistant and keeps successful results if one slide needs a retry.
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
      config: { mode: "concept", newOutfit: true, newLocation: true, textStrategy: "rewrite", creativeBrief: "", creativeDirectionPolicy: "propose" },
      bindings: {
        mode: { mode: "ask-on-run", value: "concept", label: "Adaptation mode", required: true },
        newOutfit: { mode: "ask-on-run", value: true, label: "New wardrobe or subjects", required: true },
        newLocation: { mode: "ask-on-run", value: true, label: "New location or setting", required: true },
        textStrategy: { mode: "ask-on-run", value: "rewrite", label: "On-screen text", required: true },
        creativeBrief: { mode: "ask-on-run", value: "", label: "Creative direction", required: false },
        creativeDirectionPolicy: { mode: "ask-on-run", value: "propose", label: "How comments affect choices", required: true },
      },
    }),
    node({
      id: "prepare-user-direction", type: "logic.prepare-creative-direction", name: "Prepare the written direction", description: "Freeze the exact comment, configured choices and real source indexes into one typed request.", groupId: "group-adapt", position: { x: 760, y: 648 },
      config: { controls: DEFAULT_AUTOMATION_CREATIVE_CONTROLS, briefPath: "creativeBrief", policyPath: "creativeDirectionPolicy", minConfidence: 0.9, maxBriefCharacters: 5000, maxClauses: 16, maxClauseCharacters: 1000, maxRequirements: 24, allowIgnoredClauses: false },
    }),
    node({
      id: "interpret-user-direction", type: "ai.interpret-creative-direction", name: "Understand the written direction", description: "Classify every exact clause under the fixed creative-direction contract.", groupId: "group-adapt", position: { x: 1090, y: 648 },
      config: { modelId: defaultPlanningModel, maxAttempts: 2, fallbackModelId: "", failureMode: "stop" },
      bindings: {},
    }),
    node({
      id: "resolve-user-direction", type: "logic.resolve-creative-direction", version: 2, name: "Resolve comments against choices", description: "Verify exact evidence and coverage, then apply only policy-approved configured choices.", groupId: "group-adapt", position: { x: 1420, y: 648 },
    }),
    node({
      id: "direction-conflict", type: "output.finish", name: "Stop for conflicting direction", description: "Show the exact settings and phrases that need clarification before generation.", groupId: "group-adapt", position: { x: 2080, y: 824 },
      config: { outcome: "failed", message: "{{ data.message }}" },
    }),
    node({
      id: "adaptation-mode-choice", type: "logic.condition", name: "Rebuild the concept?", description: "Choose the real workflow path that matches the selected adaptation mode.", groupId: "group-adapt", position: { x: 760, y: 384 },
      config: { path: "mode", operator: "equals", compareValue: "concept" },
    }),
    node({
      id: "rebuild-concept-mode", type: "logic.transform", name: "Rebuild for a new concept", description: "Tell the brief to create a new concept while preserving the source structure that still matters.", groupId: "group-adapt", position: { x: 1090, y: 296 },
      config: { template: { choice: "{{ inputs.0 }}", adaptation: { mode: "concept", preserveInstruction: "Preserve the source hook, sequence mechanics and any useful composition evidence that still serves the new version.", changeInstruction: "Rebuild the source into a distinct campaign concept and creative direction rather than copying the original campaign." } } },
    }),
    node({
      id: "keep-concept-mode", type: "logic.transform", name: "Keep concept, change the person", description: "Tell the brief to preserve the source concept and mainly adapt the selected person or character.", groupId: "group-adapt", position: { x: 1090, y: 472 },
      config: { template: { choice: "{{ inputs.0 }}", adaptation: { mode: "identity", preserveInstruction: "Keep the source concept, hook, sequence and scene intent without inventing a different campaign concept.", changeInstruction: "Adapt the person or character using the selected identity while keeping identity references isolated from wardrobe and location." } } },
    }),
    node({
      id: "select-adaptation", type: "logic.select-one", name: "Continue with the selected adaptation", description: "Pass the one active adaptation contract forward without asking AI to reconstruct the choice.", groupId: "group-adapt", position: { x: 1420, y: 472 },
    }),
    node({
      id: "wardrobe-choice", type: "logic.condition", name: "Change the wardrobe or subjects?", description: "Route the brief through Change or Preserve using the resolved run choice.", groupId: "group-adapt", position: { x: 1090, y: 1088 },
      config: { path: "newOutfit", operator: "equals", compareValue: true },
    }),
    node({
      id: "allow-wardrobe-change", type: "logic.transform", name: "Allow a new wardrobe or subjects", description: "Tell the brief that wardrobe or subjects must visibly change in the new version.", groupId: "group-adapt", position: { x: 1420, y: 1000 },
      config: { template: { choice: "{{ inputs.0 }}", wardrobe: { mode: "change", instruction: "Create a visibly new wardrobe or visibly new subjects on every applicable slide. Do not reuse the source clothing, accessories or styling, and do not take wardrobe from identity references." } } },
    }),
    node({
      id: "preserve-wardrobe", type: "logic.transform", name: "Preserve the source wardrobe", description: "Tell the brief to keep the source wardrobe or subjects unchanged.", groupId: "group-adapt", position: { x: 1420, y: 1176 },
      config: { template: { choice: "{{ inputs.0 }}", wardrobe: { mode: "preserve", instruction: "Preserve the exact wardrobe, clothing, accessories, visible subjects and styling from each slide's source image. Identity references must not contribute or replace wardrobe." } } },
    }),
    node({
      id: "select-wardrobe", type: "logic.select-one", name: "Continue with the selected wardrobe rule", description: "Pass the one active wardrobe contract forward unchanged.", groupId: "group-adapt", position: { x: 1750, y: 1088 },
    }),
    node({
      id: "location-choice", type: "logic.condition", name: "Change the location?", description: "Route the brief through Change or Preserve using the resolved run choice.", groupId: "group-adapt", position: { x: 1090, y: 1440 },
      config: { path: "newLocation", operator: "equals", compareValue: true },
    }),
    node({
      id: "allow-location-change", type: "logic.transform", name: "Allow a new location", description: "Tell the brief that the setting must visibly change in the new version.", groupId: "group-adapt", position: { x: 1420, y: 1352 },
      config: { template: { choice: "{{ inputs.0 }}", location: { mode: "change", instruction: "Create a visibly new location or setting on every applicable slide. Do not reuse the source background, environment or room layout unless another explicit requirement says to preserve it." } } },
    }),
    node({
      id: "preserve-location", type: "logic.transform", name: "Preserve the source location", description: "Tell the brief to keep the source setting unchanged.", groupId: "group-adapt", position: { x: 1420, y: 1528 },
      config: { template: { choice: "{{ inputs.0 }}", location: { mode: "preserve", instruction: "Preserve the exact location, background, environment, room layout and visible setting details from each slide's source image. Identity references must not contribute or replace location." } } },
    }),
    node({
      id: "select-location", type: "logic.select-one", name: "Continue with the selected location rule", description: "Pass the one active location contract forward unchanged.", groupId: "group-adapt", position: { x: 1750, y: 1440 },
    }),
    node({
      id: "assemble-choices", type: "logic.merge", name: "Lock the run choices", description: "Keep the raw settings and each selected route in one authoritative package that every later check can compare against.", groupId: "group-adapt", position: { x: 2080, y: 1000 },
      config: { mode: "named-object", inputs: [
        { id: "input-settings", name: "settings" },
        { id: "input-adaptation", name: "adaptation" },
        { id: "input-wardrobe", name: "wardrobe" },
        { id: "input-location", name: "location" },
      ] },
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
      userPrompt: "The selected text route is {{ primary }}. For each source slide connected in {{ connected.context }}, copy the exact observable sourceText, then explain its copy function, literal meaning, emotional job and whether the line depends on the image. Return every source index exactly once.",
      responseSchema: copyAnalysisSchema,
    }),
    aiNode({
      id: "inspect-identity", name: "Choose useful identity references", description: "Work out which saved images best show the face, body, profile and pose.", groupId: "group-adapt", position: { x: 1090, y: 912 },
      systemPrompt: "You inspect identity reference images. Report observable evidence only. Do not infer sensitive traits.",
      userPrompt: "Inspect {{ primary }} and return evidence for each reference: visible face angle, framing, capture style and useful identity signals. If no identity is supplied, return an empty asset list.",
      responseSchema: identityEvidenceSchema,
      runWhen: "primary != null",
    }),
    aiNode({
      id: "interpret-brief", name: "Turn choices into a clear brief", description: "Turn your source, identity and creative choices into instructions for the new version.", groupId: "group-adapt", position: { x: 1420, y: 296 },
      systemPrompt: "You are a creative director. The connected choices package is an immutable authority, source slides are structural evidence, and target references define identity only. Never reinterpret, weaken or reverse a run choice.",
      userPrompt: "Using source analysis {{ primary }}, the authoritative resolved choices and optional reference analysis in {{ connected.context }}, plus the optional saved identity in {{ identity }}, produce an explicit campaign direction, global constraints, the exact wardrobe/location/text decisions and one intent per original slide. Copy the authoritative booleans and text strategy exactly. Copy every connected direction requirement object byte-for-byte into requirements, including its id, instruction, evidence, category, placement and slideIndexes. Every preserve, change, avoid or written direction instruction must remain explicit and testable downstream.",
      responseSchema: creativeBriefSchema,
    }),
    aiNode({
      id: "rewrite-copy", name: "Write the new on-screen text", description: "Create original wording while keeping the purpose of each slide.", groupId: "group-adapt", position: { x: 2410, y: 120 },
      systemPrompt: "You write concise on-screen copy for short-form visual content. Follow the selected keep, rewrite or remove strategy exactly.",
      userPrompt: "Rewrite the sequence using creative direction {{ primary }} and source decomposition {{ connected.context }}. Return every original index exactly once. For every slide preserve sourceText exactly as evidence, set strategy to rewrite, create a distinct overlayText, and add an explicit instruction to remove the old source typography before rendering only the new overlayText.",
      responseSchema: copySequenceSchema,
    }),
    aiNode({
      id: "review-copy", name: "Check the new text", description: "Catch repeated, inconsistent or visually impossible lines before planning images.", groupId: "group-adapt", position: { x: 2740, y: 120 },
      systemPrompt: "You are a strict sequence editor. Approve only copy that is original, consistent and achievable in its assigned visual.",
      userPrompt: "Review {{ primary }} against creative direction and source roles in {{ connected.context }}. Return corrected copy for every slide without dropping sourceText, strategy or instruction. Rewrite mode must replace old typography rather than layering new text over it. List every correction.",
      responseSchema: reviewedCopySchema,
      maxAttempts: 2,
    }),
    aiNode({
      id: "keep-copy", name: "Keep the original on-screen text", description: "Copy the source wording exactly when the run chooses Keep.", groupId: "group-adapt", position: { x: 2410, y: 472 },
      systemPrompt: "You preserve source on-screen text exactly. Never rewrite, translate, improve or invent wording.",
      userPrompt: "The selected text route is {{ primary }}. Return every source slide connected in {{ connected.context }} exactly once. Copy the exact visible wording into both sourceText and overlayText, set strategy to keep, and write an instruction to preserve the exact wording while recreating it cleanly. Use empty strings only when the source slide visibly has no text.",
      responseSchema: copySequenceSchema,
    }),
    aiNode({
      id: "remove-copy", name: "Remove all on-screen text", description: "Create an empty text sequence when the run chooses Remove.", groupId: "group-adapt", position: { x: 2410, y: 648 },
      systemPrompt: "You remove on-screen text while preserving the ordered slide list. Never add replacement wording.",
      userPrompt: "The selected text route is {{ primary }}. Return every source slide connected in {{ connected.context }} exactly once. Copy the exact visible wording into sourceText as evidence, set strategy to remove, set overlayText to an empty string, and use this explicit instruction: Remove and erase every existing caption, word, letter, number, logo-like typography and watermark from the source image; do not render replacement text.",
      responseSchema: copySequenceSchema,
    }),
    node({
      id: "select-copy", type: "logic.select-one", name: "Continue with the selected text", description: "Pass the result from the one active text route to planning.", groupId: "group-adapt", position: { x: 3070, y: 296 },
    }),
    aiNode({
      id: "bind-references", name: "Match references to slides", description: "Choose only the saved identity images each slide actually needs.", groupId: "group-adapt", position: { x: 2740, y: 648 },
      systemPrompt: "You assign image references conservatively. Source frames control composition. Identity references control identity only. Other visual references may control only the observable job they were chosen for. Use only asset ids present in connected inputs.",
      userPrompt: `For every slide in {{ primary }}, use the connected brief, optional identity analysis and optional visual-reference package in {{ connected.context }}, plus the available identity record in {{ identity }}. Return references as objects with assetId, a readable title, one role and one operational instruction. For every identity asset use role identity and copy this instruction exactly: ${AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION} Visual references must use only their real observable role: location, pose, outfit, style, product or supporting visual. Return an empty references array when no extra image is needed.`,
      responseSchema: referenceAssignmentsSchema,
    }),
    node({
      id: "assemble-contract", type: "logic.merge", name: "Merge the approved plan", description: "Wait for the approved brief, copy and references, then name them inside one planning package.", groupId: "group-build", position: { x: 3400, y: 296 },
      config: { mode: "named-object", inputs: [
        { id: "input-source-analysis", name: "sourceAnalysis" },
        { id: "input-choices", name: "choices" },
        { id: "input-copy", name: "copy" },
        { id: "input-brief", name: "brief" },
        { id: "input-references", name: "references" },
      ] },
    }),
    aiNode({
      id: "plan-slides", name: "Plan every image", description: "Describe what each image should keep, what should change and how it should look.", groupId: "group-build", position: { x: 3730, y: 296 },
      systemPrompt: "You are the prompt composer used immediately before image generation. Author the complete structured JSON contract yourself, with the same semantic fields as Canvas Assistant. The connected choices are immutable. Never collapse preserve, change, text or reference rules into vague prose, and never rely on a later validator to add a missing instruction.",
      userPrompt: `Build one complete final generation JSON per source slide from {{ primary }}. Each slide must return index, role, prompt, referenceAssetIds, text and confidence. The prompt object must itself be the exact Canvas Assistant contract with title, task, reference_plan, subject, scene, preserve, change, avoid and output. Put the source composition first in reference_plan, title it Source composition plus the slide index, give it an @token ending in _1, use role source composition and copy this instruction exactly: ${AUTOMATION_SOURCE_REFERENCE_INSTRUCTION} Then copy every assigned reference into reference_plan in assignment order with its exact title, role and instruction and a unique matching @token. referenceAssetIds must list those assigned asset IDs in the same order, excluding the automatic source image. Copy the selected text strategy and its sourceText, overlayText and instruction exactly into the sidecar text evidence, and also put that exact instruction into prompt.preserve or prompt.change. Copy adaptation.preserveInstruction exactly into prompt.preserve and adaptation.changeInstruction exactly into prompt.change. Put each exact wardrobe and location instruction into prompt.preserve or prompt.change according to its selected route. For every creative-direction requirement, copy its instruction exactly into prompt.preserve, prompt.change or prompt.avoid according to placement on every slide named by slideIndexes, or every slide when slideIndexes is empty. In Remove mode include this exact prompt.avoid item: ${AUTOMATION_NO_TEXT_AVOID_INSTRUCTION} The model-authored prompt object is sent to generation unchanged; no later step will complete missing creative fields. Never omit or reorder a slide.`,
      responseSchema: slidePlansSchema,
    }),
    node({
      id: "assemble-review-package", type: "logic.merge", name: "Keep the contract beside the plans", description: "Give QA both the immutable original contract and the proposed slide plans instead of making it infer missing requirements.", groupId: "group-review", position: { x: 4060, y: 296 },
      config: { mode: "named-object", inputs: [
        { id: "input-contract", name: "contract" },
        { id: "input-plans", name: "plans" },
      ] },
    }),
    aiNode({
      id: "review-series", name: "Check the complete series", description: "Compare every plan with the original choices, copy and reference contract.", groupId: "group-review", position: { x: 4390, y: 120 },
      systemPrompt: "You are the final QA reviewer for a complete visual series. The contract is authoritative. Report concrete, repairable failures and never approve a plan that weakens, reverses or omits an immutable run choice.",
      userPrompt: "Review {{ primary.plans }} against the complete original contract {{ primary.contract }}. Check every source index, exact text strategy and wording, wardrobe and location decision, assigned reference id and role, preserve/change requirement, every creative-direction requirement ID, progression, identity isolation and independent executability. Set passed true only when every original requirement is explicitly covered on its requested slides and in its requested preserve, change or avoid field. Return a review entry for every slide and a requirementCoverage entry for every immutable choice and creative-direction requirement ID.",
      responseSchema: seriesReviewSchema,
      maxAttempts: 2,
    }),
    node({
      id: "assemble-review-gate", type: "logic.merge", name: "Keep plans and review together", description: "Carry the original contract, proposed plans and QA verdict through one explicit gate.", groupId: "group-review", position: { x: 4720, y: 296 },
      config: { mode: "named-object", inputs: [
        { id: "input-contract", name: "contract" },
        { id: "input-plans", name: "plans" },
        { id: "input-review", name: "review" },
      ] },
    }),
    node({
      id: "review-passed", type: "logic.condition", name: "Did every requirement pass?", description: "Use approved plans unchanged or repair only when QA found an actual failure.", groupId: "group-review", position: { x: 5050, y: 296 },
      config: { path: "review.passed", operator: "equals", compareValue: true },
    }),
    node({
      id: "use-approved-plans", type: "logic.select-path", name: "Use the approved plans", description: "Keep already approved plans byte-for-byte instead of asking AI to rewrite them again.", groupId: "group-review", position: { x: 5380, y: 120 },
      config: { path: "plans" },
    }),
    aiNode({
      id: "repair-slides", name: "Fix only problem slides", description: "Correct failed plans against the original contract and leave approved slides unchanged.", groupId: "group-review", position: { x: 5380, y: 472 },
      systemPrompt: "You repair only the failures named by QA. The original contract is authoritative. Preserve every approved field and stable slide index exactly, and never weaken or reverse an immutable choice.",
      userPrompt: "The gate package is {{ primary }}. Return the complete plans object. Change only slides whose review entry failed, repair every failed requirement against primary.contract, and copy all approved slide objects unchanged. Preserve every sourceText, overlayText, strategy, instruction, creative-direction requirement, reference id and reference role.",
      responseSchema: slidePlansSchema,
      maxAttempts: 2,
    }),
    node({
      id: "select-final-plans", type: "logic.select-one", name: "Continue with one final plan set", description: "Join the mutually exclusive approved and repaired paths without dropping any plan fields.", groupId: "group-review", position: { x: 5710, y: 296 },
    }),
    node({
      id: "retry-validation", type: "logic.retry-gate", name: "Retry corrected plans", description: "Send corrected plans through the same validator again, at most twice.", position: { x: 6040, y: 296 },
      config: { maxRetries: 2, feedbackPath: "plans" },
    }),
    node({
      id: "validate-slide-plans", type: "logic.validate-slide-plans", name: "Check every immutable requirement", description: "Pass valid plans forward or send the exact deterministic error to the visible repair path.", position: { x: 6370, y: 296 },
      config: { maxSlides: 40, failureMode: "error-output" },
    }),
    aiNode({
      id: "repair-validation", name: "Repair validator failures", description: "Fix only the exact contract failures returned by the deterministic validator.", groupId: null, position: { x: 6700, y: 560 },
      systemPrompt: "You repair structured slide plans after deterministic validation. The original contract is authoritative. Fix every named validation failure, preserve all already valid fields byte-for-byte, and return the complete slide-plan JSON contract. Never weaken a requirement or invent a fallback format.",
      userPrompt: "Validation returned {{ primary }}. The currently checked plans and original generation contract are connected in {{ connected.context }}. Return the complete corrected slide plan collection using the configured schema. Fix the exact validation error, keep every source index, reference binding, text contract, creative-direction requirement and already valid prompt field, and do not add commentary outside the structured answer.",
      responseSchema: slidePlansSchema,
      maxAttempts: 2,
    }),
    node({
      id: "assemble-retry-feedback", type: "logic.merge", name: "Return repair with its error", description: "Keep the repaired plans and the validator error together for the retry gate and final diagnostics.", position: { x: 7030, y: 560 },
      config: { mode: "named-object", inputs: [
        { id: "input-plans", name: "plans" },
        { id: "input-error", name: "validationError" },
      ] },
    }),
    node({
      id: "retry-exhausted", type: "output.finish", name: "Stop after retry limit", description: "Fail clearly when corrected plans still cannot satisfy the same validator.", position: { x: 6700, y: 824 },
      config: { outcome: "failed", message: "{{ data.message }}" },
    }),
    node({
      id: "generate-images", type: "generation.image", name: "Image Generator", description: "Create the checked slides from the same structured JSON contract used by Canvas Assistant.", position: { x: 7030, y: 120 },
      config: { modelId: "nano-banana-2", ratio: "9:16", resolution: "1K", concurrency: 3, maxAttempts: 3, partialFailure: "keep-successful" },
    }),
    node({
      id: "add-to-canvas", type: "output.add-to-canvas", name: "Add slideshow to canvas", description: "Place the finished images beside their source so you can keep editing them.", position: { x: 7360, y: 120 },
      config: { layout: "beside-source", includePlanNote: true },
    }),
  ];

  const edges = [
    edge("manual-run", "run", "tiktok-source", "run"),
    edge("manual-run", "run", "identity", "run"),
    edge("manual-run", "run", "creative-settings", "run"),
    edge("tiktok-source", "source", "analyze-source", "primary"),
    edge("identity", "identity", "inspect-identity", "primary"),
    edge("creative-settings", "settings", "prepare-user-direction", "settings"),
    edge("tiktok-source", "source", "prepare-user-direction", "source", "data"),
    edge("prepare-user-direction", "request", "interpret-user-direction", "request"),
    edge("prepare-user-direction", "request", "resolve-user-direction", "request", "data"),
    edge("interpret-user-direction", "analysis", "resolve-user-direction", "analysis"),
    edge("resolve-user-direction", "conflict", "direction-conflict", "data", "error"),
    edge("analyze-source", "result", "interpret-brief", "primary"),
    edge("inspect-identity", "result", "interpret-brief", "context", "data"),
    edge("resolve-user-direction", "resolved", "wardrobe-choice", "data"),
    edge("resolve-user-direction", "resolved", "location-choice", "data"),
    edge("resolve-user-direction", "resolved", "adaptation-mode-choice", "data"),
    edge("adaptation-mode-choice", "yes", "rebuild-concept-mode", "data"),
    edge("adaptation-mode-choice", "no", "keep-concept-mode", "data"),
    edge("rebuild-concept-mode", "result", "select-adaptation", "data"),
    edge("keep-concept-mode", "result", "select-adaptation", "data"),
    edge("wardrobe-choice", "yes", "allow-wardrobe-change", "data"),
    edge("wardrobe-choice", "no", "preserve-wardrobe", "data"),
    edge("allow-wardrobe-change", "result", "select-wardrobe", "data"),
    edge("preserve-wardrobe", "result", "select-wardrobe", "data"),
    edge("location-choice", "yes", "allow-location-change", "data"),
    edge("location-choice", "no", "preserve-location", "data"),
    edge("allow-location-change", "result", "select-location", "data"),
    edge("preserve-location", "result", "select-location", "data"),
    edge("resolve-user-direction", "resolved", "assemble-choices", "input-settings"),
    edge("select-adaptation", "result", "assemble-choices", "input-adaptation", "data"),
    edge("select-wardrobe", "result", "assemble-choices", "input-wardrobe", "data"),
    edge("select-location", "result", "assemble-choices", "input-location", "data"),
    edge("assemble-choices", "result", "interpret-brief", "context", "data"),
    edge("identity", "identity", "interpret-brief", "identity", "data"),
    edge("resolve-user-direction", "resolved", "text-route-rewrite", "data"),
    edge("text-route-rewrite", "yes", "decompose-copy", "primary"),
    edge("tiktok-source", "source", "decompose-copy", "context", "data"),
    edge("analyze-source", "result", "decompose-copy", "context", "data"),
    edge("decompose-copy", "result", "rewrite-copy", "primary"),
    edge("interpret-brief", "result", "rewrite-copy", "context", "data"),
    edge("rewrite-copy", "result", "review-copy", "primary"),
    edge("interpret-brief", "result", "review-copy", "context", "data"),
    edge("text-route-rewrite", "no", "text-route-keep", "data"),
    edge("text-route-keep", "yes", "keep-copy", "primary"),
    edge("text-route-keep", "no", "remove-copy", "primary"),
    edge("tiktok-source", "source", "keep-copy", "context", "data"),
    edge("tiktok-source", "source", "remove-copy", "context", "data"),
    edge("analyze-source", "result", "keep-copy", "context", "data"),
    edge("analyze-source", "result", "remove-copy", "context", "data"),
    edge("review-copy", "result", "select-copy", "data"),
    edge("keep-copy", "result", "select-copy", "data"),
    edge("remove-copy", "result", "select-copy", "data"),
    edge("select-copy", "result", "bind-references", "primary"),
    edge("interpret-brief", "result", "bind-references", "context", "data"),
    edge("inspect-identity", "result", "bind-references", "context", "data"),
    edge("identity", "identity", "bind-references", "identity", "data"),
    edge("analyze-source", "result", "assemble-contract", "input-source-analysis", "data"),
    edge("assemble-choices", "result", "assemble-contract", "input-choices", "data"),
    edge("interpret-brief", "result", "assemble-contract", "input-brief", "data"),
    edge("select-copy", "result", "assemble-contract", "input-copy", "data"),
    edge("bind-references", "result", "assemble-contract", "input-references"),
    edge("assemble-contract", "result", "plan-slides", "primary"),
    edge("assemble-contract", "result", "assemble-review-package", "input-contract", "data"),
    edge("plan-slides", "result", "assemble-review-package", "input-plans"),
    edge("assemble-review-package", "result", "review-series", "primary"),
    edge("assemble-contract", "result", "assemble-review-gate", "input-contract", "data"),
    edge("plan-slides", "result", "assemble-review-gate", "input-plans", "data"),
    edge("review-series", "result", "assemble-review-gate", "input-review"),
    edge("assemble-review-gate", "result", "review-passed", "data"),
    edge("review-passed", "yes", "use-approved-plans", "data"),
    edge("review-passed", "no", "repair-slides", "primary"),
    edge("use-approved-plans", "result", "select-final-plans", "data"),
    edge("repair-slides", "result", "select-final-plans", "data"),
    edge("select-final-plans", "result", "retry-validation", "initial"),
    edge("retry-validation", "current", "validate-slide-plans", "data"),
    edge("assemble-contract", "result", "validate-slide-plans", "contract", "data"),
    edge("tiktok-source", "source", "validate-slide-plans", "source", "data"),
    edge("identity", "identity", "validate-slide-plans", "identity", "data"),
    edge("validate-slide-plans", "plans", "generate-images", "plans"),
    edge("validate-slide-plans", "error", "repair-validation", "primary", "error"),
    edge("retry-validation", "current", "repair-validation", "context", "data"),
    edge("assemble-contract", "result", "repair-validation", "context", "data"),
    edge("repair-validation", "result", "assemble-retry-feedback", "input-plans"),
    edge("validate-slide-plans", "error", "assemble-retry-feedback", "input-error", "error"),
    edge("assemble-retry-feedback", "result", "retry-validation", "feedback", "retry"),
    edge("retry-validation", "exhausted", "retry-exhausted", "data", "error"),
    edge("tiktok-source", "source", "generate-images", "source", "data"),
    edge("identity", "identity", "generate-images", "identity", "data"),
    edge("generate-images", "assets", "add-to-canvas", "assets"),
    edge("tiktok-source", "source", "add-to-canvas", "source", "data"),
  ];

  return { schemaVersion: 1, nodes, edges, groups, annotations, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS }, viewport: { x: 40, y: 120, zoom: 0.72 } };
}
