import { assistantModels } from "@/lib/assistant-models";
import type { AutomationNode, AutomationNodeDefinition, AutomationNodeHelp, AutomationNodePortDefinition, AutomationPortType } from "./types";
import {
  AUTOMATION_CREATIVE_DIRECTION_SYSTEM_PROMPT,
  AUTOMATION_CREATIVE_DIRECTION_USER_PROMPT,
  DEFAULT_AUTOMATION_CREATIVE_CONTROLS,
  DEFAULT_AUTOMATION_REQUIREMENT_CATEGORIES,
  DEFAULT_AUTOMATION_REQUIREMENT_PLACEMENTS,
} from "./creative-direction-contract";

export type AutomationMergeInput = { id: string; name: string };

export const DEFAULT_AUTOMATION_MERGE_INPUTS: AutomationMergeInput[] = [
  { id: "input-1", name: "first" },
  { id: "input-2", name: "second" },
];

function humanizeAutomationPortName(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function automationMergeInputs(node: Pick<AutomationNode, "type" | "config">): AutomationMergeInput[] {
  if (node.type !== "logic.merge") return [];
  const configured = Array.isArray(node.config.inputs) ? node.config.inputs : [];
  const normalized = configured.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = String((entry as Record<string, unknown>).id || "").trim();
    const name = String((entry as Record<string, unknown>).name || "").trim();
    return id && name ? [{ id, name }] : [];
  });
  if (configured.length) return normalized;
  return DEFAULT_AUTOMATION_MERGE_INPUTS.map((entry) => ({ ...entry }));
}

export function automationNodeInputPorts(node: Pick<AutomationNode, "type" | "version" | "config">): AutomationNodePortDefinition[] {
  const definition = automationNodeDefinition(node.type, node.version);
  if (!definition) return [];
  if (node.type !== "logic.merge") return definition.inputs;
  return automationMergeInputs(node).map((input) => ({ id: input.id,
    label: humanizeAutomationPortName(input.name), type: "data",
    required: true,
  }));
}

const assistantModelOptions = assistantModels.map((model) => ({ value: model.id, label: model.label }));
const optionalAssistantModelOptions = [{ value: "", label: "No backup model" }, ...assistantModelOptions];

const helpByType: Record<string, AutomationNodeHelp> = {
  "core.manual-trigger": {
    whenToUse: "Use this as the start of a workflow. A person can press Run, and a configured schedule, event or webhook can start the same saved workflow automatically.",
    setup: ["Place it at the start of the workflow.", "Connect its Run output to every input step that must prepare a value before the work begins.", "Mark changeable fields on later steps as Ask on run so they appear in the Automation panel."],
    exampleFlow: { before: "Automation panel", after: "Source and creative inputs", explanation: "The person presses Run once. This step creates the run context that wakes the connected input steps." },
    tips: ["A workflow needs exactly one start card.", "Schedules, events and webhooks use the current saved workflow."],
    technicalNotes: ["Emits one run-context object containing run metadata and the trigger payload when one exists.", "It does not transform creative data or call an external provider."],
  },
  "input.tiktok-source": {
    whenToUse: "Use this when later steps need the original TikTok slideshow, caption and ordered source frames.",
    setup: ["Connect Start workflow to the Run input.", "Choose a fixed slideshow, or enable Ask on run so the person can choose one each time.", "Choose explicitly whether the output keeps the original caption, uses replacement text or contains no caption.", "Connect Source to the first AI, planning or generation step that studies the original post."],
    exampleFlow: { before: "Start workflow", after: "Analyze slideshow", explanation: "The run starts, this step loads the chosen post, and the analysis step receives the same ordered source package." },
    tips: ["Choose Ask on run for reusable workflows.", "Keep the original caption unless the workflow intentionally starts from different copy."],
    technicalNotes: ["Outputs a typed tiktok-source package, not only a URL.", "The package contains ordered assets and source metadata used by downstream reference-aware steps."],
  },
  "input.identity": {
    whenToUse: "Use this when AI or generation steps must keep a saved person or character recognizable and consistent.",
    setup: ["Connect Start workflow to the Run input.", "If you have added a person or character in the Identities section, choose them here. Otherwise enable Ask on run or allow this step to continue without an identity.", "Leave the reference choice on All available unless Before, After or Reference has a specific meaning in this workflow.", "Connect Identity to every step that needs the person, not only to the final image step."],
    exampleFlow: { before: "Start workflow", after: "Inspect identity and create images", explanation: "One selected identity can inform both the reasoning steps and the final visual generation." },
    tips: ["Enable Can run without a person for product, place or general-visual workflows.", "If a person is mandatory, disable that option and mark the identity as required before run."],
    technicalNotes: ["Outputs identity metadata plus the references allowed by the selected group.", "Can run without a person applies only when no identity is selected. If a selected identity has no usable images in the selected group, the run stops instead of silently removing that user choice.", "Provider credentials and private asset storage locations are not embedded in the portable workflow."],
  },
  "input.visual-references": {
    whenToUse: "Use this when later AI or image steps need visual examples that are not a saved person or character: composition, pose, product, place, lighting, style or another scene.",
    setup: ["Connect Start workflow to the Run input.", "Choose images from the canvas where the automation is opened or from the workspace Library. You can also enable Ask on run so the operator chooses them each time.", "Connect References to AI context when the model should study the images, and to image planning or generation when their asset IDs may be assigned to a result.", "Set a clear maximum so one run cannot attach an unexpectedly large reference set."],
    exampleFlow: { before: "Start workflow and chosen images", after: "Analyze, plan or create images", explanation: "The step resolves the selected assets only when the run starts, then passes one stable reference package to every connected consumer." },
    tips: ["Use Identity for a recognizable person or character; use Visual references for everything else.", "Select only images that have a clear job in the workflow. More references do not automatically produce a better result."],
    technicalNotes: ["The saved workflow stores only stable asset IDs. Temporary URLs and storage paths are resolved server-side for an authorized run.", "Portable workflow exports clear local asset IDs and ask the installer to choose references in their own workspace."],
  },
  "input.creative-settings": {
    whenToUse: "Use this to collect creative decisions that should be easy to change between runs without editing the workflow graph.",
    setup: ["Connect the run trigger.", "Choose which values stay fixed and which should be Asked on run.", "Choose whether explicit creative direction may override the switches or must agree with them.", "Write optional creative direction in ordinary language.", "Pass Settings into a direction parser and Resolve creative direction before routing any branches."],
    exampleFlow: { before: "Start workflow", after: "Parse and resolve creative direction", explanation: "The user chooses defaults and an explicit conflict policy; later visible steps may resolve an unambiguous written instruction without hiding the branch decision." },
    tips: ["Ask only for decisions the operator can understand.", "Never let free text silently override switches without an explicit policy.", "Keep permanent brand rules inside the AI step rather than asking for them every run."],
    technicalNotes: ["Produces a structured data object including the selected creative-direction policy.", "Each runtime-bindable field can be fixed or exposed as a typed run input."],
  },
  "input.workflow-data": {
    whenToUse: "Use this when another workflow, a schedule or an event should supply structured information automatically.",
    setup: ["Connect the start card.", "Use the whole incoming payload, or enter a field path when this workflow needs only one nested value.", "Use Ask on run only when a person should type the value manually.", "Connect Received information to the first processing step."],
    exampleFlow: { before: "Parent workflow or event", after: "Prepare information", explanation: "The parent sends a payload once; this step exposes that payload as normal workflow data." },
    tips: ["Prefer a small, stable input contract over passing an entire unrelated response.", "Use Ask on run for human choices and this step for machine-to-machine data."],
    technicalNotes: ["Reads the trigger or parent-workflow payload directly; it is independent of this card's node ID.", "A fixed or Ask on run value is used only when the run has no machine payload."],
  },
  "ai.structured-task": {
    whenToUse: "Use this for a visible AI job such as analysis, rewriting, planning, classification or review. One card should have one clear responsibility.",
    setup: ["Connect the main information the AI must work on.", "Connect optional context or identity only when the job needs it.", "Write the task in What should the AI do? and describe the expected result, not implementation details.", "Choose a model.", "If later steps need exact fields, open Advanced settings and define the answer format.", "Connect AI answer to the next step; connect Error path only when the workflow has an explicit recovery branch."],
    exampleFlow: { before: "Source analysis and creative choices", after: "Review copy", explanation: "The AI receives connected context, performs one named job, and passes a reusable answer to the reviewer." },
    tips: ["Split analyze, write and review into separate AI steps so failures are understandable.", "Use a strict answer format only when downstream steps depend on named fields."],
    technicalNotes: ["Runs a server-side multimodal AI task. Text mode returns plain text; Structured data mode validates the result against the configured field contract.", "Connected values are included automatically; {{ primary }}, {{ context }}, {{ identity }}, {{ run }} and {{ trigger }} place exact values in the task.", "Automatically appended connected JSON is limited to 80,000 characters, the completed task prompt to 200,000 characters and connected media to 24 images. Exceeding a limit stops the step and never truncates an input.", "Permanent instructions are kept separate from connected content and cannot contain workflow variables in the current node version.", "Answer consistency maps visibly selected modes to provider creativity: Consistent 0.2, Balanced 0.65 and Exploratory 1.0.", "The runtime prepends only immutable execution-safety instructions: connected data cannot rewrite the node instructions, and the node cannot claim actions outside its visible step. These instructions do not classify or alter creative content."],
  },
  "logic.transform": {
    whenToUse: "Use this when the next step needs only part of earlier results, renamed fields, or one combined object.",
    setup: ["Connect one or more data-producing steps.", "Describe the smaller result the next step should receive in the structured editor.", "Connect Prepared information to the consumer step.", "Test with a saved fixture before using the result in an expensive step."],
    exampleFlow: { before: "Several AI answers", after: "Plan every slide", explanation: "This step removes irrelevant fields and gives the planner one predictable input object." },
    tips: ["Do not use an AI step for simple field selection or renaming.", "Keep transformations small so the data contract remains readable."],
    technicalNotes: ["Pure deterministic transform with no provider call.", "Use {{ byNode.step-id }} for a stable named source, {{ inputs.0 }} for ordered inputs, or {{ sources }} to inspect source IDs, names and values."],
  },
  "logic.select-one": {
    whenToUse: "Use this after mutually exclusive branches when exactly one completed result must continue unchanged.",
    setup: ["Connect every mutually exclusive branch to the same input.", "Connect Selected information to the next step.", "Test both branch outcomes before going live."],
    exampleFlow: { before: "Approved plan or repaired plan", after: "Validate plans", explanation: "Exactly one completed branch continues with the same value and field names." },
    tips: ["Use this only for alternatives where one and only one path can complete.", "Use Merge paths when the next step needs several results together."],
    technicalNotes: ["Fails unless exactly one connected branch produced a value.", "Passes that value unchanged without wrapping, renaming, coercion or fallback."],
  },
  "logic.retry-gate": {
    whenToUse: "Use this when a deterministic check can return repair feedback and the corrected value must be checked again through a visible bounded path.",
    setup: ["Connect the original value to First attempt.", "Connect Current value to the check and its success path.", "Route the check error through an explicit repair step.", "Connect the repaired package back to Retry feedback using a Retry route.", "Connect Retry exhausted to a deliberate failed output."],
    exampleFlow: { before: "Slide plans rejected by validation", after: "Repair once, then validate the corrected plans again", explanation: "The retry route returns only through this gate, increments a stored counter and stops at the configured limit." },
    tips: ["Keep generation, publishing and other side effects after the successful check, outside the retry body.", "Include the validator error and repaired value in the feedback package so the final failure remains understandable."],
    technicalNotes: ["This is the only node that accepts a backward Retry route; ordinary graph cycles remain invalid.", "Retries are bounded, persisted in node outputs and counted against the workflow step-execution limit.", "The feedback field path selects the corrected value without inventing or repairing missing data."],
  },
  "logic.select-path": {
    whenToUse: "Use this when the next step needs one existing field from a larger result and that field must stay unchanged.",
    setup: ["Connect the larger result.", "Enter the exact field path, such as plans or campaign.brief.", "Connect Selected information to the next step."],
    exampleFlow: { before: "Review package", after: "Continue approved plans", explanation: "The existing plans field continues as the same value without rebuilding its JSON." },
    tips: ["Use Prepare information only when you intentionally need to create a different shape.", "A missing field stops the run with its exact path."],
    technicalNotes: ["Reads one exact object path and returns the stored value unchanged.", "Does not wrap, rename, parse, stringify, coerce or fall back to another field."],
  },
  "logic.condition": {
    whenToUse: "Use this when the workflow must choose between two paths based on one visible rule.",
    setup: ["Connect the information to inspect.", "Enter the field to check, such as review.approved.", "Choose the rule and comparison value when needed.", "Connect Rule matches and Rule does not match to different next steps."],
    exampleFlow: { before: "Review result", after: "Generate images or Repair plan", explanation: "Approved data follows the yes path. Everything else follows the no path, so no outcome is hidden." },
    tips: ["Name the card after the decision, for example Is the plan approved?", "Always connect or intentionally finish both paths."],
    technicalNotes: ["Evaluates one deterministic predicate and passes the original incoming value unchanged.", "Contains is case-sensitive for text and checks exact items in a list. Empty lists and objects should use the explicit empty rules rather than the yes / true rule."],
  },
  "logic.prepare-creative-direction": {
    whenToUse: "Use this before the creative-direction AI step to freeze the exact comment, visible choices, configurable choice map and real source slide indexes into one request contract.",
    setup: ["Connect Creative choices to Settings.", "Connect the raw TikTok Source, not an AI summary, to Source.", "Configure which setting paths and options the interpreter may recognize.", "Connect Request to both Interpret creative direction and Resolve creative direction."],
    exampleFlow: { before: "Creative choices and source slideshow", after: "Interpret creative direction", explanation: "The deterministic step preserves the complete comment unchanged and defines the only choices and requirement taxonomy the model may return." },
    tips: ["Keep the default controls or add your own through the visual choice editor.", "Use a strict or confirmation policy unless automatic changes are intentionally allowed."],
    technicalNotes: ["Hashes and forwards the complete comment without splitting it by words, punctuation or language.", "Verifies every current setting maps to one configured option and provides real source indexes directly from the source node.", "The author-selected comment, policy and resolution paths are part of the typed request; the resolver cannot substitute built-in field names."],
  },
  "ai.interpret-creative-direction": {
    whenToUse: "Use this only for classifying a prepared creative-direction request into configured choices, atomic requirements, ambiguities or explicitly ignored wording.",
    setup: ["Connect a Prepared creative direction request.", "Choose the assistant model and retry limit.", "Connect Analysis to Resolve creative direction.", "Use the Error path only for an explicit recovery branch."],
    exampleFlow: { before: "Prepared creative direction", after: "Resolve creative direction", explanation: "The model classifies the complete exact comment under the workflow author's visible instructions; it cannot itself change settings." },
    tips: ["Do not replace this with a generic prose parser when downstream switches matter.", "Keep failure mode on Stop or Error path; an empty interpretation is not a valid fallback."],
    technicalNotes: ["The node builds a strict schema from the configured control, category and placement IDs.", "Every non-whitespace character must belong to an exact evidence range; the runtime has no language-specific word list."],
  },
  "logic.resolve-creative-direction": {
    whenToUse: "Use this after Interpret creative direction to verify that the model classified the exact current comment without omissions or invented evidence.",
    setup: ["Connect the same Prepared request used by the interpreter.", "Connect its typed Analysis output.", "Route Resolved choices into the visible branch conditions.", "Connect Conflict to a failed output that shows what must be clarified."],
    exampleFlow: { before: "Prepared request plus typed analysis", after: "Wardrobe, location, adaptation and text routes", explanation: "Only verified configured choices can change; all other accepted meaning becomes an atomic requirement." },
    tips: ["Use Show changes for confirmation when operators should explicitly approve a switch change.", "Automatic changes still require exact evidence, complete clause coverage and high confidence."],
    technicalNotes: ["This node is deterministic and fail closed: contract mismatch, missing clauses, paraphrased evidence, low confidence, ambiguity and invalid scope all use Conflict.", "Requirements receive content-derived stable IDs and the current node accepts exactly the current prepared-request version.", "It preserves the connected settings, changes only configured control paths under the selected policy, and writes resolution evidence only to the author-selected empty destination."],
  },
  "logic.limit-batch": {
    whenToUse: "Use this immediately before a costly repeated operation to prevent an unexpectedly large list from consuming time or credits.",
    setup: ["Connect the list you want to protect.", "Set the largest acceptable item count.", "Connect Allowed items to the expensive step.", "Optionally connect Count summary to logging or review."],
    exampleFlow: { before: "Planned slides", after: "Image Generator", explanation: "Normal lists continue; an oversized list stops with a clear limit error before generation begins." },
    tips: ["Set the limit from the real product constraint, not an arbitrary high number.", "Use workflow-wide safety limits as a second line of protection."],
    technicalNotes: ["Validates array length before forwarding data.", "Outputs the unchanged allowed items plus a count summary."],
  },
  "logic.merge": {
    whenToUse: "Use this when two or more paths have produced information and the next step needs one deliberate package instead of several crossing connections.",
    setup: ["Add one input row for every path the workflow must wait for.", "Give every input a short, stable name, then connect each earlier result to its own socket on the card.", "Choose whether the results should stay as a list or become one named object.", "Connect Combined information to the next step."],
    exampleFlow: { before: "Approved brief, copy and references", after: "Plan every image", explanation: "The workflow waits until the connected paths have finished, then creates one predictable package for the planner." },
    tips: ["Merge is a real synchronization point, not a visual folder.", "A missing required path means the merge cannot produce its complete package; make optional paths explicit before this step."],
    technicalNotes: ["Requires at least two configured inputs. Every input is a stable single-connection port, so removing a connected input is blocked until its edge is disconnected.", "List mode flattens connected lists by one level in configured input order. Named object mode uses the input names as keys and keeps every value intact.", "Branches are not claimed to execute simultaneously; the runtime may schedule them in a deterministic order before the merge."],
  },
  "logic.run-subworkflow": {
    whenToUse: "Use this to reuse one runnable workflow as a single step, for example publishing, moderation or asset processing.",
    setup: ["Connect the information to send.", "Give the connection a stable name.", "In Settings, connect that name to a live child workflow.", "Confirm the child has a compatible Workflow input step.", "Connect its result or error path."],
    exampleFlow: { before: "Finished image and caption", after: "Publishing result", explanation: "This workflow pauses while the child workflow completes, then continues with the child result." },
    tips: ["Use a child workflow for genuinely reusable behavior, not to hide a confusing local graph.", "Take the child live and test it before connecting it."],
    technicalNotes: ["Invokes a pinned workflow version through a deployment binding.", "The connected value becomes the child workflow payload; the child Workflow input reads it without depending on either card's node ID.", "The output is an envelope with the child run id, its final output and warning count."],
  },
  "logic.map-subworkflow": {
    whenToUse: "Use this as an explicit bounded loop when every item in a list must go through the same reusable workflow.",
    setup: ["Connect the list of items.", "Choose the child workflow connection.", "Set maximum items and safe concurrency.", "Choose whether one failed item stops everything or successful results are kept.", "Connect Results, Failures or Error to explicit next paths."],
    exampleFlow: { before: "List of slide plans", after: "Collected reviews and failed items", explanation: "The loop sends one item at a time to the selected child workflow, keeps its original item number, and emits the collected result only after the bounded list is finished." },
    tips: ["Start with low concurrency when the provider has strict rate limits.", "Use Run another workflow when there is only one item."],
    technicalNotes: ["Creates bounded child runs and preserves every item's zero-based itemIndex beside its run id, output and warning count.", "The child workflow is the visible loop body. This avoids an unbounded backward canvas connection while still allowing the repeated work to contain any supported steps.", "Each item becomes the child workflow payload. When Keep successful is selected, failed items appear on Failed items; Stop the whole list produces a node error instead."],
  },
  "integration.http-request": {
    whenToUse: "Use this to exchange data with an external service that provides an HTTP API, such as publishing, enrichment or a custom backend.",
    setup: ["Read the service API documentation and choose the URL and method it requires.", "Build the request body from earlier workflow data.", "Name the secret connection without pasting the secret into the workflow.", "In Settings, connect a saved credential.", "Connect Service response and decide whether an error should stop or follow a recovery path."],
    exampleFlow: { before: "Approved caption", after: "Publishing service response", explanation: "The request runs on the server with the saved credential; only the service response enters the workflow." },
    tips: ["Never paste API keys into URL, headers or body fields.", "Test with a non-production endpoint or fixture first."],
    technicalNotes: ["Server-side HTTP transport blocks private-network targets and applies timeout, retry and response-size policies. Only network failures, rate limits, selected conflict statuses and server errors are retried.", "POST, PUT, PATCH and DELETE send JSON; GET and HEAD send no body. Successful responses include status, success flag, safe headers and parsed JSON or text body. Redirects are not followed and count as unsuccessful responses.", "When Send the error to another path is enabled, that path receives the safe response status, headers and body when the service returned one.", "Credential bindings stay local and are excluded from exports."],
  },
  "logic.validate-slide-plans": {
    whenToUse: "Use this as the final deterministic gate for the Recreate TikTok slide-plan contract before image generation.",
    setup: ["Connect the completed slide plans.", "Connect Original generation contract for full choice, copy and prompt enforcement. Without it, this step performs structural checks only.", "Also connect the original slideshow and optional identity so indexes and reference IDs can be checked.", "Set the maximum number of slides.", "Connect Checked plans to image creation.", "When repair is allowed, set failure behavior to Send the error and connect the error to a repair step and bounded Retry gate."],
    exampleFlow: { before: "Plan and review slides", after: "Image Generator", explanation: "Only complete, ordered and bounded plans reach the image provider." },
    tips: ["Keep this check even when an AI review step already approved the content.", "AI review judges quality; this step enforces the mechanical contract."],
    technicalNotes: ["Validates the model-authored Recreate TikTok slide-plan-set contract without adding, rewriting or repairing prompt fields.", "When Original generation contract is connected, it enforces that workflow's visible adaptation, wardrobe, location, text, reference-role and creative-requirement fields. Without that optional connection, validation is explicitly structural: schema, indexes, reference availability and slide limits only.", "Model reference capacity is checked by generation because the model can be chosen at run time.", "Error output contains the exact deterministic failure and never substitutes a fallback plan."],
  },
  "logic.prepare-slideshow-image-requests": {
    whenToUse: "Use this after TikTok slide-plan validation to turn the checked domain contract into the one generic image-request contract.",
    setup: ["Connect Checked plans and the original slideshow.", "Connect the same optional identity and visual-reference packages used by validation.", "Connect Image requests to the generic Image Generator."],
    exampleFlow: { before: "Validated TikTok slide plans", after: "Image Generator", explanation: "This visible adapter serializes each approved prompt and exact reference list; the generator itself does not know about TikTok, clothing, locations or text policy." },
    tips: ["Keep domain-specific transformations in explicit adapter nodes.", "Do not bypass validation when the source plans came from an AI step."],
    technicalNotes: ["Outputs schemaVersion 1 image requests with one exact prompt, ordered asset ids, roles and labels per item.", "It does not call a provider or choose model settings."],
  },
  "generation.image": {
    whenToUse: "Use this when one or more explicit image requests should become generated assets with the selected model settings.",
    setup: ["Connect an Image requests package produced by a visible planning or adapter step.", "Choose the image model, shape and quality.", "Choose how partial failures should behave.", "Connect Created images to a canvas or another asset-processing step."],
    exampleFlow: { before: "Prepared image requests", after: "Canvas output", explanation: "The generator sends each exact prompt and ordered reference list without interpreting their creative meaning." },
    tips: ["Build prompts and reference roles upstream so every creative decision stays visible.", "Keep concurrency within the provider capacity configured for the deployment."],
    technicalNotes: ["Consumes only the canonical image-request batch; it contains no TikTok, wardrobe, location or text-policy logic.", "Model, ratio and resolution are mandatory visible settings. The selected ratio must be supported by every request's actual text or reference mode; incompatible requests stop instead of changing format.", "Per-item retries and partial-failure behavior are explicit. The effective concurrency cannot exceed the deployment's visible workflow execution policy, and model/reference capacity is validated before dispatch; these limits stop work but never rewrite a prompt.", "The provider transport keeps the exact request as USER_REQUEST and may prepend an ordered REFERENCE_MAP containing only the connected reference labels so uploaded images cannot be swapped.", "An explicit retry from this step runs image creation again; only completed upstream nodes before the selected retry point are reused.", "Stopping after a partial failure prevents results from being added to the canvas, but provider work that already completed may still be billed."],
  },
  "output.add-to-canvas": {
    whenToUse: "Use this when generated assets should appear on the main content canvas as an editable result branch.",
    setup: ["Connect Created images.", "Optionally connect the original source so the result can be positioned beside it.", "Choose the layout.", "Decide whether to include a plan note for future editing."],
    exampleFlow: { before: "Created images", after: "Editable canvas branch", explanation: "The automation run finishes by placing reusable nodes on the canvas instead of returning only hidden data." },
    tips: ["Use Finish without adding to canvas for non-visual automations.", "Keeping the plan note makes later manual edits easier to understand."],
    technicalNotes: ["Terminal canvas side effect that creates generated-image nodes and lineage links from the connected source when present.", "The selected layout determines placement; Show the plan determines whether a generated plan note is added.", "Test and single-step preview runs return a preview receipt and never change the content canvas.", "Emits a canvas-result receipt but does not accept outgoing workflow connections."],
  },
  "output.finish": {
    whenToUse: "Use this to end a non-visual path and expose its final result without adding anything to the content canvas.",
    setup: ["Connect the final information.", "Choose whether the path is successful or failed.", "Write a short result message that an operator will understand."],
    exampleFlow: { before: "External service response", after: "Completed run", explanation: "The workflow records a clear outcome and final data, then stops this path." },
    tips: ["Use a specific message such as Caption sent for publishing.", "Every path should eventually reach a terminal step or an intentional terminal operation."],
    technicalNotes: ["Terminal result node with no outgoing workflow connection.", "A successful outcome stores the final data and message as the run result. A failed outcome deliberately throws the message and marks the run as failed instead of producing a success receipt."],
  },
};

const helpOverridesByVersion: Record<string, Partial<AutomationNodeHelp>> = {
  "input.tiktok-source@1": {
    setup: ["Connect Start workflow to the Run input.", "Choose a fixed slideshow, or enable Ask on run so the person can choose one each time.", "Optionally enter replacement caption text. An empty replacement preserves the original caption in this historical version.", "Connect Source to the next step."],
    technicalNotes: ["Historical contract: one caption field is both the replacement and the fallback switch.", "An empty caption field preserves the source title; use version 2 when preserve, replace and empty must be separate explicit choices."],
  },
  "input.identity@1": {
    setup: ["Connect Start workflow to the Run input.", "Choose a saved identity and reference group, or leave the identity empty when the step is optional.", "Connect Identity to the steps that need it.", "Migrate to version 2 when a selected identity must never continue with an empty reference group."],
    technicalNotes: ["Historical contract: when Can run without a person is enabled, a selected identity whose selected group contains no usable images emits identity metadata with an empty assets list.", "Use version 2 so optional applies only when no identity is selected and an empty selected group fails explicitly."],
  },
  "logic.condition@1": {
    technicalNotes: ["Historical predicate contract: yes/no rules use JavaScript truthiness, so non-empty text such as false counts as yes.", "Use version 2 for exact booleans and typed empty rules. The original incoming value is still passed unchanged."],
  },
  "logic.condition@2": {
    technicalNotes: ["Historical typed-boolean contract: true and false are exact, while numeric comparisons still accept numeric text and text containment stringifies its comparison value.", "Use version 3 when every comparison must preserve its JSON type."],
  },
  "logic.prepare-creative-direction@1": {
    whenToUse: "Use this only to execute a saved historical creative-direction graph that uses request contract v2.",
    setup: ["Connect the historical Creative choices and TikTok Source inputs.", "Review its fixed field paths, clause limits and configured controls.", "Connect the same request to Interpret v1 and Resolve v2."],
    technicalNotes: ["Historical contract v2 splits text into punctuation-delimited clauses and applies versioned fallback defaults for missing limits.", "Requirement category and destination vocabularies belong to that historical contract; migrate to Prepare v3 for author-configured taxonomy and explicit read/write paths."],
  },
  "logic.prepare-creative-direction@2": {
    whenToUse: "Use this only to execute a saved creative-direction graph that uses request contract v3.",
    setup: ["Connect Creative choices and the raw TikTok Source.", "Configure controls, comment and policy paths, categories and destinations.", "Connect the same request to Interpret v2 and Resolve v3."],
    technicalNotes: ["Contract v3 preserves the complete comment and configured taxonomy, but its paired historical resolver writes evidence to the fixed direction field.", "Migrate to Prepare v3 and Resolve v4 when the evidence destination must be author-controlled."],
  },
  "ai.interpret-creative-direction@1": {
    whenToUse: "Use this only with a saved Prepare v1 request contract.",
    setup: ["Connect Prepare creative direction v1.", "Choose the model and retry behavior.", "Connect Analysis to Resolve creative direction v2."],
    technicalNotes: ["Uses the built-in, read-only interpretation prompts and the historical contract-v2 schema.", "It does not change settings; Resolve v2 performs the historical deterministic checks."],
  },
  "ai.interpret-creative-direction@2": {
    whenToUse: "Use this only with a saved Prepare v2 request contract.",
    setup: ["Connect Prepare creative direction v2.", "Review the visible instructions, model, consistency and retry settings.", "Connect Analysis to Resolve creative direction v3."],
    technicalNotes: ["Accepts exactly request contract v3 and builds a strict schema from its controls and taxonomy.", "Use version 3 for the current path-explicit contract v4 chain."],
  },
  "logic.resolve-creative-direction@2": {
    whenToUse: "Use this only to resolve a saved contract-v2 request produced by Prepare v1 and Interpret v1.",
    setup: ["Connect the same historical v2 request and analysis.", "Route Resolved choices and Conflict explicitly.", "Migrate the chain when editing its behavior."],
    technicalNotes: ["Accepts exactly contract v2, including its historical fixed requirement taxonomy and clause coverage rules.", "On success it writes normalized comment and evidence to the historical creativeBrief and direction fields."],
  },
  "logic.resolve-creative-direction@3": {
    whenToUse: "Use this only to resolve a saved contract-v3 request produced by Prepare v2 and Interpret v2.",
    setup: ["Connect the same v3 request and analysis.", "Route Resolved choices and Conflict explicitly.", "Use Resolve v4 for a configurable evidence destination."],
    technicalNotes: ["Accepts exactly contract v3 and uses its configured controls and taxonomy.", "On success this historical version writes normalized comment and evidence to the fixed creativeBrief and direction fields."],
  },
  "generation.image@1": {
    whenToUse: "Use this only to execute a saved slideshow graph that connects checked plans, source and reference packages directly to generation.",
    setup: ["Connect validated slide plans and the original source.", "Connect optional identity and visual references.", "Review model and format settings, then migrate to the explicit request adapter plus Image Generator v2 when editing the workflow."],
    technicalNotes: ["Historical combined adapter/generator: it builds image requests internally and may select versioned model, ratio or resolution fallbacks when old saved settings are absent.", "Version 2 requires a canonical image-request batch and explicit model, ratio and resolution."],
  },
  "output.add-to-canvas@1": {
    technicalNotes: ["Historical output accepts both historical and canonical generated-assets shapes and normalizes missing legacy reference labels and effective settings.", "Use version 2 when the workflow must reject non-canonical generator output. Preview/test runs remain side-effect free."],
  },
  "output.add-to-canvas@2": {
    technicalNotes: ["Historical canonical output creates one plan note and truncates its text at the Canvas note limit.", "Use version 3 to preserve the complete plan across as many bounded Canvas notes as required."],
  },
};

function withHelp(definition: Omit<AutomationNodeDefinition, "help">): AutomationNodeDefinition {
  const baseHelp = helpByType[definition.type];
  if (!baseHelp) throw new Error(`Missing help content for automation node type ${definition.type}`);
  const help = { ...baseHelp, ...helpOverridesByVersion[`${definition.type}@${definition.version}`] };
  return { ...definition, help };
}

const rawDefinitions: Array<Omit<AutomationNodeDefinition, "help">> = [
  {
    type: "core.manual-trigger", version: 1, title: "Start workflow", description: "Starts one workflow run from the Automation panel or a configured trigger.", example: "Use this once at the beginning. A person, schedule, event or webhook can start the workflow.", category: "trigger", icon: "play", accent: "mint",
    inputs: [], outputs: [{ id: "run", label: "Run", type: "run-context" }], fields: [],
  },
  {
    type: "input.tiktok-source", version: 1, title: "TikTok source", description: "Brings the chosen TikTok slideshow and its caption into the workflow.", example: "Choose a viral slideshow. Later steps can study its hook, wording and every source image.", category: "input", icon: "source", accent: "amber",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "source", label: "Source", type: "tiktok-source" }], fields: [
      { id: "source", label: "Source slideshow", description: "Choose it now, or ask for a different slideshow whenever this workflow runs.", kind: "select", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "tiktok-source", required: true },
      { id: "caption", label: "Use different caption", description: "Optional. Leave empty to use the original TikTok caption.", placeholder: "Write a replacement caption only when you need one…", kind: "textarea", runtimeBindable: true, runtimeValueType: "string" },
    ],
  },
  {
    type: "input.tiktok-source", version: 2, title: "TikTok source", description: "Brings the chosen TikTok slideshow and an explicitly selected caption mode into the workflow.", example: "Choose a viral slideshow, then preserve, replace or intentionally clear its caption.", category: "input", icon: "source", accent: "amber",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "source", label: "Source", type: "tiktok-source" }], fields: [
      { id: "source", label: "Source slideshow", description: "Choose it now, or ask for a different slideshow whenever this workflow runs.", kind: "select", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "tiktok-source", required: true },
      { id: "captionMode", label: "Caption", description: "Choose explicitly whether to preserve, replace or remove the original caption.", kind: "select", defaultValue: "original", runtimeBindable: true, runtimeValueType: "string", options: [
        { value: "original", label: "Use original caption" }, { value: "replacement", label: "Use replacement caption" }, { value: "empty", label: "Use no caption" },
      ] },
      { id: "caption", label: "Replacement caption", description: "Used only when Caption is set to Use replacement caption.", placeholder: "Write the replacement caption…", kind: "textarea", defaultValue: "", runtimeBindable: true, runtimeValueType: "string", visibleWhen: { fieldId: "captionMode", values: ["replacement"] }, requiredWhenVisible: true },
    ],
  },
  {
    type: "input.identity", version: 1, title: "Identity", description: "Gives later steps the saved person or character they should keep consistent.", example: "If you added a person or character in the Identities section, choose them here so later steps can use the right visual references.", category: "input", icon: "identity", accent: "blue",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "identity", label: "Identity", type: "identity" }], fields: [
      { id: "identity", label: "Person or character", description: "If you have added a person or character in the Identities section, choose them here or ask for one before every run.", kind: "select", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "identity" },
      { id: "referenceGroup", label: "Which references to use", description: "All available passes every saved reference. Choose one group only when Before, After or Reference has a specific meaning.", kind: "select", defaultValue: "auto", options: [
        { value: "auto", label: "All available" }, { value: "reference", label: "Reference only" }, { value: "before", label: "Before only" }, { value: "after", label: "After only" },
      ] },
      { id: "optional", label: "Can run without a person", description: "Keep enabled when this workflow should also work for products, places or general visuals.", kind: "boolean", defaultValue: true },
    ],
  },
  {
    type: "input.identity", version: 2, title: "Identity", description: "Gives later steps the selected saved person or character and requires usable images when one is chosen.", example: "Choose a person or character when this run must preserve them; leave the choice empty only when the workflow may run without a person.", category: "input", icon: "identity", accent: "blue",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "identity", label: "Identity", type: "identity" }], fields: [
      { id: "identity", label: "Person or character", description: "If you have added a person or character in the Identities section, choose them here or ask for one before every run.", kind: "select", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "identity" },
      { id: "referenceGroup", label: "Which references to use", description: "All available passes every saved reference. A chosen group must contain at least one usable image.", kind: "select", defaultValue: "auto", options: [
        { value: "auto", label: "All available" }, { value: "reference", label: "Reference only" }, { value: "before", label: "Before only" }, { value: "after", label: "After only" },
      ] },
      { id: "optional", label: "Can run without a person", description: "When enabled, the step may continue only if no person is selected. A selected person still requires a usable image in the chosen group.", kind: "boolean", defaultValue: true },
    ],
  },
  {
    type: "input.visual-references", version: 1, title: "Visual references", description: "Brings chosen Canvas, Library or Identity images into the workflow as reusable visual context.", example: "Choose composition, product, place, pose or style images for later AI and image steps.", category: "input", icon: "references", accent: "mint",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }],
    outputs: [{ id: "references", label: "References", type: "visual-references" }],
    fields: [
      { id: "references", label: "Reference images", description: "Choose images from this canvas or the workspace Library, or ask for them before every run.", kind: "references", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "visual-references", defaultValue: [], max: 32 },
      { id: "maxItems", label: "Maximum references per run", description: "Limits how many images this step may resolve and pass to later steps.", kind: "number", defaultValue: 8, min: 1, max: 32 },
      { id: "optional", label: "Can run without references", description: "Keep enabled when references improve the result but are not required for the workflow to continue.", kind: "boolean", defaultValue: true },
    ],
  },
  {
    type: "input.creative-settings", version: 1, title: "TikTok recreation choices", description: "Collects the six explicit decisions used by the Recreate TikTok workflow.", example: "Keep the original idea, replace the person and location, then rewrite the on-screen text for your campaign.", category: "input", icon: "choices", accent: "neutral",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "settings", label: "Settings", type: "creative-settings" }], fields: [
      { id: "mode", label: "What should change", description: "Adapt concept rebuilds the idea for a new campaign. Cast identity keeps the idea and mainly replaces the person.", kind: "select", defaultValue: "concept", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "string", options: [{ value: "concept", label: "Rebuild for a new concept" }, { value: "identity", label: "Keep concept, change the person" }] },
      { id: "newOutfit", label: "Allow new clothes or subjects", description: "Disable this when clothing and visible objects must stay close to the source.", kind: "boolean", defaultValue: true, runtimeBindable: true, defaultRunInput: true, runtimeValueType: "boolean" },
      { id: "newLocation", label: "Allow a new location", description: "Disable this when the setting and background must stay close to the source.", kind: "boolean", defaultValue: true, runtimeBindable: true, defaultRunInput: true, runtimeValueType: "boolean" },
      { id: "textStrategy", label: "What to do with on-screen text", description: "Keep the original wording, rewrite it for the new concept, or remove it.", kind: "select", defaultValue: "rewrite", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "string", options: [{ value: "keep", label: "Keep the original text" }, { value: "rewrite", label: "Rewrite for the new version" }, { value: "remove", label: "Remove on-screen text" }] },
      { id: "creativeBrief", label: "Extra creative direction", description: "Optional. Add the audience, offer, tone or anything the new version must include.", placeholder: "Example: Make it feel like a casual home transformation for women 25–35…", kind: "textarea", defaultValue: "", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "string" },
      { id: "creativeDirectionPolicy", label: "How comments affect the choices", description: "Choose whether a verified written request proposes a visible change, must already agree, or may update the choice automatically.", kind: "select", defaultValue: "propose", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "string", options: [{ value: "propose", label: "Show changes for confirmation" }, { value: "strict", label: "Comments must agree with choices" }, { value: "auto-explicit", label: "Apply verified explicit changes" }] },
    ],
  },
  {
    type: "input.workflow-data", version: 1, title: "Input from another workflow", description: "Receives information from a trigger or another workflow.", example: "A scheduled workflow can pass a campaign brief into this workflow without asking a person to type it again.", category: "input", icon: "inbox", accent: "amber",
    inputs: [{ id: "run", label: "Run", type: "run-context", required: true }], outputs: [{ id: "data", label: "Received information", type: "data" }], fields: [
      { id: "value", label: "Manual value", description: "Used only for a manual run. Automatic triggers and parent workflows supply their own payload instead. Choose Ask on run when a person should enter it.", kind: "json", runtimeBindable: true, defaultRunInput: true, runtimeValueType: "json", defaultValue: {} },
      { id: "payloadPath", label: "Read one field from the payload", description: "Optional. Example: campaign.brief returns only that nested value. Leave empty to receive the whole payload.", placeholder: "campaign.brief", kind: "text", defaultValue: "", advanced: true },
    ],
  },
  {
    type: "ai.structured-task", version: 2, title: "AI", description: "Runs one named AI task and returns either readable text or defined data fields.", example: "Name the step for its job: understand the source, write new copy, or check a finished plan.", category: "ai", icon: "ai", accent: "blue", retrySafe: true,
    inputs: [
      { id: "primary", label: "Main information", type: "data", required: true },
      { id: "context", label: "Extra context", type: "data", multiple: true },
      { id: "identity", label: "Person or character", type: "identity" },
    ],
    outputs: [{ id: "result", label: "AI answer", type: "data" }, { id: "error", label: "Error path", type: "error" }],
    fields: [
      { id: "modelId", label: "AI model", description: "Choose this step's text model independently from the same models available to Canvas Assistant.", kind: "model", runtimeBindable: true, runtimeValueType: "assistant-model", modelCapability: "assistant", required: true, options: assistantModelOptions },
      { id: "userPrompt", label: "What should the AI do?", description: "Describe one clear job and the result you want. Connected cards are included automatically; variables place an exact connected value.", placeholder: "Example: Study every slide and explain its hook, message and visual purpose…", kind: "prompt", required: true, defaultValue: "" },
      { id: "outputMode", label: "What should this step return?", description: "Choose readable text for writing and summaries. Choose defined fields when later steps must read exact values.", kind: "select", defaultValue: "text", options: [
        { value: "text", label: "Readable text" }, { value: "structured", label: "Defined data fields" },
      ] },
      { id: "responseSchema", label: "Fields in the AI answer", description: "Add the named fields that later steps need. The answer is checked before it can continue.", kind: "schema", defaultValue: { type: "object", additionalProperties: false, properties: {}, required: [] }, visibleWhen: { fieldId: "outputMode", values: ["structured"] } },
      { id: "runWhen", label: "When should this step run?", description: "Usually every time. Skip it only when the main information is absent and that is a valid workflow path.", kind: "select", defaultValue: "always", options: [
        { value: "always", label: "Every time" }, { value: "primary != null", label: "Only when the main information exists" },
      ] },
      { id: "systemPrompt", label: "Permanent instructions", description: "Optional. Put role, safety, brand and formatting rules that apply every time here. Put the actual job above.", placeholder: "Example: Preserve the source meaning. Do not invent facts. Use concise language…", kind: "prompt", defaultValue: "", advanced: true },
      { id: "creativity", label: "Variation", description: "Consistent is best for analysis and checks. Balanced suits most writing. Exploratory produces more varied ideas.", kind: "select", defaultValue: "consistent", options: [
        { value: "consistent", label: "Consistent" }, { value: "balanced", label: "Balanced" }, { value: "exploratory", label: "More exploratory" },
      ], advanced: true },
      { id: "maxAttempts", label: "How many times to retry", description: "Retries the AI task when the request fails or a structured answer cannot be used.", kind: "number", defaultValue: 3, min: 1, max: 8, advanced: true },
      { id: "fallbackModelId", label: "Backup AI model", kind: "model", modelCapability: "assistant", description: "Optional. Used on a later attempt when the main model cannot complete the task.", options: optionalAssistantModelOptions, advanced: true },
      { id: "failureMode", label: "If this step still fails", description: "Stop the run, route a safe error to a recovery path, or continue with an empty answer.", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" }, { value: "continue-empty", label: "Continue without an answer" },
      ], advanced: true },
    ],
  },
  {
    type: "logic.transform", version: 1, title: "Prepare information", description: "Renames, selects or combines incoming information for the next step.", example: "Take an AI answer with many fields and pass only the slide plans to image generation.", category: "logic", icon: "transform", accent: "neutral", retrySafe: true,
    inputs: [{ id: "data", label: "Incoming information", type: "data", required: true, multiple: true }], outputs: [{ id: "result", label: "Prepared information", type: "data" }], fields: [
      { id: "template", label: "What the next step should receive", description: "Build a JSON result with variables. Use {{ byNode.step-id }} for a named card or {{ inputs.0 }} for the first connected value.", kind: "json", defaultValue: {} },
    ],
  },
  {
    type: "logic.select-one", version: 1, title: "Continue one path", description: "Joins mutually exclusive paths and passes the one completed value forward unchanged.", example: "Continue with either the approved plan or the repaired plan, but never both.", category: "logic", icon: "select-one", accent: "neutral", retrySafe: true,
    inputs: [{ id: "data", label: "Alternative results", type: "data", required: true, multiple: true }], outputs: [{ id: "result", label: "Selected information", type: "data" }], fields: [],
  },
  {
    type: "logic.retry-gate", version: 1, title: "Retry gate", description: "Returns corrected information to a check through one explicit bounded retry route.", example: "When validation rejects a plan, repair it and send it back through this gate up to two times.", category: "logic", icon: "retry", accent: "amber", retrySafe: true,
    inputs: [
      { id: "initial", label: "First attempt", type: "data", required: true },
      { id: "feedback", label: "Retry feedback", type: "data" },
    ],
    outputs: [
      { id: "current", label: "Current value", type: "data", required: true },
      { id: "exhausted", label: "Retry exhausted", type: "error", required: true },
    ],
    fields: [
      { id: "maxRetries", label: "Maximum retries", description: "How many corrected values may return through the Retry route after the first attempt.", kind: "number", defaultValue: 2, min: 1, max: 8 },
      { id: "feedbackPath", label: "Corrected value field", description: "Optional field path inside the feedback package, for example plans. Leave empty when the feedback itself is the corrected value.", placeholder: "plans", kind: "text", defaultValue: "", advanced: true },
    ],
  },
  {
    type: "logic.select-path", version: 1, title: "Select information", description: "Takes one existing field from incoming information and passes its value forward unchanged.", example: "Continue with the plans field from a larger review package without reconstructing it.", category: "logic", icon: "select-path", accent: "neutral", retrySafe: true,
    inputs: [{ id: "data", label: "Incoming information", type: "data", required: true }], outputs: [{ id: "result", label: "Selected information", type: "data" }], fields: [
      { id: "path", label: "Field to continue", description: "Enter the exact field path, for example plans or campaign.brief. The run stops if that field is missing.", placeholder: "plans", kind: "text", required: true, defaultValue: "" },
    ],
  },
  {
    type: "logic.condition", version: 1, title: "Choose a path", description: "Checks one rule and sends the information down the matching path.", example: "If review status is approved, generate images. Otherwise, send the plan back for repair.", category: "logic", icon: "condition", accent: "amber", retrySafe: true,
    inputs: [{ id: "data", label: "Information to check", type: "data", required: true }], outputs: [
      { id: "yes", label: "Rule matches", type: "data", required: true }, { id: "no", label: "Rule does not match", type: "data", required: true },
    ], fields: [
      { id: "path", label: "What should be checked?", placeholder: "Example: review.approved", kind: "text", defaultValue: "", description: "Enter the field name from the incoming result. Leave empty to check the whole result." },
      { id: "operator", label: "What must be true?", description: "Choose the single rule used to decide which of the two output paths receives the original information.", kind: "select", defaultValue: "is-truthy", options: [
        { value: "is-truthy", label: "Is yes / true" }, { value: "is-falsy", label: "Is no / false" },
        { value: "is-empty", label: "Is empty" }, { value: "is-not-empty", label: "Is not empty" },
        { value: "equals", label: "Equals this value" }, { value: "not-equals", label: "Does not equal this value" },
        { value: "contains", label: "Contains this value" }, { value: "greater-than", label: "Is greater than" },
        { value: "less-than", label: "Is less than" },
      ] },
      { id: "compareValue", label: "Compare with", placeholder: "Example: approved, 10, or true", kind: "value", defaultValue: null, description: "Type ordinary text, a number, true, false, or leave it empty.", visibleWhen: { fieldId: "operator", values: ["equals", "not-equals", "contains", "greater-than", "less-than"] } },
    ],
  },
  {
    type: "logic.condition", version: 2, title: "Choose a path", description: "Checks one explicit typed rule and sends the information down the matching path.", example: "If review status equals true, generate images. Otherwise, send the plan back for repair.", category: "logic", icon: "condition", accent: "amber", retrySafe: true,
    inputs: [{ id: "data", label: "Information to check", type: "data", required: true }], outputs: [
      { id: "yes", label: "Rule matches", type: "data", required: true }, { id: "no", label: "Rule does not match", type: "data", required: true },
    ], fields: [
      { id: "path", label: "What should be checked?", placeholder: "Example: review.approved", kind: "text", defaultValue: "", description: "Enter the field name from the incoming result. Leave empty to check the whole result." },
      { id: "operator", label: "What must match?", description: "True and false require actual boolean values; text such as false is never silently coerced.", kind: "select", defaultValue: "is-true", options: [
        { value: "is-true", label: "Is exactly true" }, { value: "is-false", label: "Is exactly false" },
        { value: "is-empty", label: "Is empty" }, { value: "is-not-empty", label: "Is not empty" },
        { value: "equals", label: "Equals this value" }, { value: "not-equals", label: "Does not equal this value" },
        { value: "contains", label: "Contains this value" }, { value: "greater-than", label: "Is greater than" },
        { value: "less-than", label: "Is less than" },
      ] },
      { id: "compareValue", label: "Compare with", placeholder: "Example: approved, 10, or true", kind: "value", defaultValue: null, description: "Type ordinary text, a number, true, false, or leave it empty.", visibleWhen: { fieldId: "operator", values: ["equals", "not-equals", "contains", "greater-than", "less-than"] } },
    ],
  },
  {
    type: "logic.condition", version: 3, title: "Choose a path", description: "Checks one explicit JSON-typed rule without silently converting text, numbers or booleans.", example: "If review status equals true, generate images. Otherwise, send the plan back for repair.", category: "logic", icon: "condition", accent: "amber", retrySafe: true,
    inputs: [{ id: "data", label: "Information to check", type: "data", required: true }], outputs: [
      { id: "yes", label: "Rule matches", type: "data", required: true }, { id: "no", label: "Rule does not match", type: "data", required: true },
    ], fields: [
      { id: "path", label: "What should be checked?", placeholder: "Example: review.approved", kind: "text", defaultValue: "", description: "Enter the field name from the incoming result. Leave empty to check the whole result." },
      { id: "operator", label: "What must match?", description: "True, false and numeric rules require values of the same real JSON type; text is never converted for comparison.", kind: "select", defaultValue: "is-true", options: [
        { value: "is-true", label: "Is exactly true" }, { value: "is-false", label: "Is exactly false" },
        { value: "is-empty", label: "Is empty" }, { value: "is-not-empty", label: "Is not empty" },
        { value: "equals", label: "Equals this value" }, { value: "not-equals", label: "Does not equal this value" },
        { value: "contains", label: "Contains this value" }, { value: "greater-than", label: "Is greater than" },
        { value: "less-than", label: "Is less than" },
      ] },
      { id: "compareValue", label: "Compare with", placeholder: "Example: approved, 10, or true", kind: "value", defaultValue: null, description: "Use text for text rules, a real number for numeric rules, or true/false for boolean equality.", visibleWhen: { fieldId: "operator", values: ["equals", "not-equals", "contains", "greater-than", "less-than"] } },
    ],
  },
  {
    type: "logic.prepare-creative-direction", version: 1, title: "Prepare creative direction", description: "Creates the exact typed request that defines what the interpreter is allowed to recognize.", example: "Freeze the comment, visible switches and raw source slide indexes before asking a model to classify anything.", category: "logic", icon: "prepare-direction", accent: "neutral", retrySafe: true,
    inputs: [
      { id: "settings", label: "Creative choices", type: "creative-settings", required: true },
      { id: "source", label: "Source slideshow", type: "tiktok-source", required: true },
    ],
    outputs: [{ id: "request", label: "Prepared request", type: "creative-direction-request", required: true }],
    fields: [
      { id: "controls", label: "Choices the comment may affect", description: "Define each real setting and explain to the AI what every option means.", kind: "creative-controls", defaultValue: DEFAULT_AUTOMATION_CREATIVE_CONTROLS },
      { id: "briefPath", label: "Comment field path", description: "Field inside Creative choices containing the written direction.", kind: "text", defaultValue: "creativeBrief", advanced: true },
      { id: "policyPath", label: "Policy field path", description: "Field inside Creative choices containing the change policy.", kind: "text", defaultValue: "creativeDirectionPolicy", advanced: true },
      { id: "minConfidence", label: "Minimum interpretation confidence", description: "Lower-confidence classifications stop for clarification.", kind: "number", defaultValue: 0.9, min: 0.5, max: 1, advanced: true },
      { id: "maxBriefCharacters", label: "Maximum comment length", description: "Stops an unexpectedly large comment before it reaches a model.", kind: "number", defaultValue: 5000, min: 100, max: 20000, advanced: true },
      { id: "maxClauses", label: "Maximum comment clauses", description: "Stops an unexpectedly large comment before it reaches a model.", kind: "number", defaultValue: 16, min: 1, max: 40, advanced: true },
      { id: "maxClauseCharacters", label: "Maximum clause length", description: "Keeps each exact evidence unit small enough for strict structured classification.", kind: "number", defaultValue: 1000, min: 100, max: 2000, advanced: true },
      { id: "maxRequirements", label: "Maximum accepted requirements", description: "Stops a model response that expands the comment into too many instructions.", kind: "number", defaultValue: 24, min: 1, max: 80, advanced: true },
      { id: "allowIgnoredClauses", label: "Allow explicitly ignored wording", description: "Keep disabled when every clause must become a choice, requirement or clarification error.", kind: "boolean", defaultValue: false, advanced: true },
    ],
  },
  {
    type: "logic.prepare-creative-direction", version: 2, title: "Prepare creative direction", description: "Creates the exact typed request that defines what the interpreter is allowed to recognize.", example: "Freeze the comment, visible switches and raw source slide indexes before asking a model to classify anything.", category: "logic", icon: "prepare-direction", accent: "neutral", retrySafe: true,
    inputs: [
      { id: "settings", label: "Creative choices", type: "creative-settings", required: true },
      { id: "source", label: "Source slideshow", type: "tiktok-source", required: true },
    ],
    outputs: [{ id: "request", label: "Prepared request", type: "creative-direction-request", required: true }],
    fields: [
      { id: "controls", label: "Choices the comment may affect", description: "Define each real setting and explain to the AI what every option means. These node settings, not hidden server rules, control classification.", kind: "creative-controls", defaultValue: DEFAULT_AUTOMATION_CREATIVE_CONTROLS, required: true },
      { id: "briefPath", label: "Comment field path", description: "Field inside Creative choices containing the written direction.", kind: "text", defaultValue: "creativeBrief", advanced: true },
      { id: "policyPath", label: "Policy field path", description: "Field inside Creative choices containing the change policy.", kind: "text", defaultValue: "creativeDirectionPolicy", advanced: true },
      { id: "minConfidence", label: "Minimum interpretation confidence", description: "Lower-confidence classifications stop for clarification.", kind: "number", defaultValue: 0.9, min: 0.5, max: 1, required: true, advanced: true },
      { id: "maxBriefCharacters", label: "Maximum comment length", description: "Stops an unexpectedly large comment before it reaches a model.", kind: "number", defaultValue: 5000, min: 100, max: 20000, required: true, advanced: true },
      { id: "requirementCategories", label: "Requirement categories", description: "Define the category ids and meanings that this workflow accepts. The server does not add its own categories.", kind: "json", defaultValue: DEFAULT_AUTOMATION_REQUIREMENT_CATEGORIES, required: true, advanced: true },
      { id: "requirementPlacements", label: "Requirement destinations", description: "Define where accepted requirements go and explain each destination to the AI. The server accepts only these configured ids.", kind: "json", defaultValue: DEFAULT_AUTOMATION_REQUIREMENT_PLACEMENTS, required: true, advanced: true },
      { id: "maxRequirements", label: "Maximum accepted requirements", description: "Stops a model response that expands the comment into too many instructions.", kind: "number", defaultValue: 24, min: 1, max: 80, required: true, advanced: true },
      { id: "allowIgnoredClauses", label: "Allow explicitly ignored wording", description: "Keep disabled when every clause must become a choice, requirement or clarification error.", kind: "boolean", defaultValue: false, advanced: true },
    ],
  },
  {
    type: "logic.prepare-creative-direction", version: 3, title: "Prepare creative direction", description: "Creates a path-explicit typed request that defines exactly what the interpreter and resolver may read or write.", example: "Freeze the comment, visible choices, output destination and raw source slide indexes before asking a model to classify anything.", category: "logic", icon: "prepare-direction", accent: "neutral", retrySafe: true,
    inputs: [
      { id: "settings", label: "Settings to resolve", type: "data", required: true },
      { id: "source", label: "Source slideshow", type: "tiktok-source", required: true },
    ],
    outputs: [{ id: "request", label: "Prepared request", type: "creative-direction-request", required: true }],
    fields: [
      { id: "controls", label: "Choices the comment may affect", description: "Define each real setting and explain to the AI what every option means. Only these paths may change.", kind: "creative-controls", defaultValue: DEFAULT_AUTOMATION_CREATIVE_CONTROLS, required: true },
      { id: "briefPath", label: "Comment field path", description: "Exact field inside Creative choices containing the written direction.", kind: "text", defaultValue: "creativeBrief", required: true, advanced: true },
      { id: "policyPath", label: "Policy field path", description: "Exact field inside Creative choices containing the change policy.", kind: "text", defaultValue: "creativeDirectionPolicy", required: true, advanced: true },
      { id: "resultPath", label: "Resolution evidence path", description: "Empty field destination where Resolve creative direction may write verified requirements and evidence. It cannot overlap or replace a choice, comment or policy field.", kind: "text", defaultValue: "direction", required: true, advanced: true },
      { id: "minConfidence", label: "Minimum interpretation confidence", description: "Lower-confidence classifications stop for clarification.", kind: "number", defaultValue: 0.9, min: 0.5, max: 1, required: true, advanced: true },
      { id: "maxBriefCharacters", label: "Maximum comment length", description: "Stops an unexpectedly large comment before it reaches a model.", kind: "number", defaultValue: 5000, min: 100, max: 20000, required: true, advanced: true },
      { id: "requirementCategories", label: "Requirement categories", description: "Define the category ids and meanings that this workflow accepts. The server does not add its own categories.", kind: "json", defaultValue: DEFAULT_AUTOMATION_REQUIREMENT_CATEGORIES, required: true, advanced: true },
      { id: "requirementPlacements", label: "Requirement destinations", description: "Define where accepted requirements go and explain each destination to the AI. The server accepts only these configured ids.", kind: "json", defaultValue: DEFAULT_AUTOMATION_REQUIREMENT_PLACEMENTS, required: true, advanced: true },
      { id: "maxRequirements", label: "Maximum accepted requirements", description: "Stops a model response that expands the comment into too many instructions.", kind: "number", defaultValue: 24, min: 1, max: 80, required: true, advanced: true },
      { id: "allowIgnoredClauses", label: "Allow explicitly ignored wording", description: "Keep disabled when every clause must become a choice, requirement or clarification error.", kind: "boolean", defaultValue: false, advanced: true },
    ],
  },
  {
    type: "ai.interpret-creative-direction", version: 1, title: "Interpret creative direction", description: "Classifies every exact comment clause under a fixed, strict system contract.", example: "Recognize an explicit Preserve location request while keeping a tone request as an atomic requirement.", category: "ai", icon: "interpret-direction", accent: "blue", retrySafe: true,
    inputs: [{ id: "request", label: "Prepared request", type: "creative-direction-request", required: true }],
    outputs: [{ id: "analysis", label: "Direction analysis", type: "creative-direction-analysis", required: true }, { id: "error", label: "Error path", type: "error" }],
    fields: [
      { id: "systemInstructions", label: "Built-in interpretation contract", description: "Visible for audit.", kind: "prompt", defaultValue: AUTOMATION_CREATIVE_DIRECTION_SYSTEM_PROMPT, readOnly: true, advanced: true },
      { id: "modelId", label: "AI model", description: "Choose this step's text model independently.", kind: "model", runtimeBindable: true, runtimeValueType: "assistant-model", modelCapability: "assistant", required: true, options: assistantModelOptions },
      { id: "maxAttempts", label: "How many times to retry", description: "Retries provider or strict-schema failures only.", kind: "number", defaultValue: 3, min: 1, max: 8, advanced: true },
      { id: "fallbackModelId", label: "Backup AI model", description: "Optional model for a later attempt.", kind: "model", modelCapability: "assistant", options: optionalAssistantModelOptions, advanced: true },
      { id: "failureMode", label: "If interpretation still fails", description: "Stop or route the exact error.", kind: "select", defaultValue: "stop", options: [{ value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" }], advanced: true },
    ],
  },
  {
    type: "ai.interpret-creative-direction", version: 2, title: "Interpret creative direction", description: "Classifies the complete comment and returns exact evidence spans under a visible, strict system contract.", example: "Recognize an explicit Preserve location request while keeping a tone request as an atomic requirement.", category: "ai", icon: "interpret-direction", accent: "blue", retrySafe: true,
    inputs: [{ id: "request", label: "Prepared request", type: "creative-direction-request", required: true }],
    outputs: [{ id: "analysis", label: "Direction analysis", type: "creative-direction-analysis", required: true }, { id: "error", label: "Error path", type: "error" }],
    fields: [
      { id: "systemInstructions", label: "Permanent interpretation instructions", description: "Visible and editable in duplicated workflows. This template default defines semantic classification without hidden keyword rules.", kind: "prompt", defaultValue: AUTOMATION_CREATIVE_DIRECTION_SYSTEM_PROMPT, required: true, advanced: true },
      { id: "taskInstructions", label: "Interpretation task", description: "The exact task sent with the prepared request. Keep the output aligned with the configured strict contract.", kind: "prompt", defaultValue: AUTOMATION_CREATIVE_DIRECTION_USER_PROMPT, required: true, advanced: true },
      { id: "creativity", label: "Answer consistency", description: "Use consistent for classification; other modes are available when a custom workflow intentionally wants broader interpretation.", kind: "select", defaultValue: "consistent", required: true, options: [{ value: "consistent", label: "Consistent" }, { value: "balanced", label: "Balanced" }, { value: "exploratory", label: "Exploratory" }], advanced: true },
      { id: "modelId", label: "AI model", description: "Choose this step's text model independently from the same models available to Canvas Assistant.", kind: "model", runtimeBindable: true, runtimeValueType: "assistant-model", modelCapability: "assistant", required: true, options: assistantModelOptions },
      { id: "maxAttempts", label: "How many times to retry", description: "Retries provider or strict-schema failures only; it never weakens the contract.", kind: "number", defaultValue: 3, min: 1, max: 8, advanced: true },
      { id: "fallbackModelId", label: "Backup AI model", description: "Optional model for a later attempt when the main model cannot return the strict contract.", kind: "model", modelCapability: "assistant", options: optionalAssistantModelOptions, advanced: true },
      { id: "failureMode", label: "If interpretation still fails", description: "Stop or route the exact error. Continuing with an empty answer is intentionally unavailable.", kind: "select", defaultValue: "stop", options: [{ value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" }], advanced: true },
    ],
  },
  {
    type: "ai.interpret-creative-direction", version: 3, title: "Interpret creative direction", description: "Classifies only the current path-explicit request and returns exact evidence spans under visible instructions.", example: "Recognize an explicit Preserve location request while keeping a tone request as an atomic requirement.", category: "ai", icon: "interpret-direction", accent: "blue", retrySafe: true,
    inputs: [{ id: "request", label: "Prepared request", type: "creative-direction-request", required: true }],
    outputs: [{ id: "analysis", label: "Direction analysis", type: "creative-direction-analysis", required: true }, { id: "error", label: "Error path", type: "error" }],
    fields: [
      { id: "systemInstructions", label: "Permanent interpretation instructions", description: "Visible and editable in duplicated workflows. This template default defines semantic classification without hidden keyword rules.", kind: "prompt", defaultValue: AUTOMATION_CREATIVE_DIRECTION_SYSTEM_PROMPT, required: true, advanced: true },
      { id: "taskInstructions", label: "Interpretation task", description: "The exact task sent with the prepared request. Keep the output aligned with the configured strict contract.", kind: "prompt", defaultValue: AUTOMATION_CREATIVE_DIRECTION_USER_PROMPT, required: true, advanced: true },
      { id: "creativity", label: "Answer consistency", description: "Consistent sends 0.2 creativity, Balanced sends 0.65 and Exploratory sends 1.0.", kind: "select", defaultValue: "consistent", required: true, options: [{ value: "consistent", label: "Consistent" }, { value: "balanced", label: "Balanced" }, { value: "exploratory", label: "Exploratory" }], advanced: true },
      { id: "modelId", label: "AI model", description: "Choose this step's text model independently from the same models available to Canvas Assistant.", kind: "model", runtimeBindable: true, runtimeValueType: "assistant-model", modelCapability: "assistant", required: true, options: assistantModelOptions },
      { id: "maxAttempts", label: "How many times to retry", description: "Retries provider or strict-schema failures only; it never weakens the contract.", kind: "number", defaultValue: 3, min: 1, max: 8, advanced: true },
      { id: "fallbackModelId", label: "Backup AI model", description: "Optional model for a later attempt when the main model cannot return the strict contract.", kind: "model", modelCapability: "assistant", options: optionalAssistantModelOptions, advanced: true },
      { id: "failureMode", label: "If interpretation still fails", description: "Stop or route the exact error. Continuing with an empty answer is intentionally unavailable.", kind: "select", defaultValue: "stop", options: [{ value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" }], advanced: true },
    ],
  },
  {
    type: "logic.resolve-creative-direction", version: 2, title: "Resolve creative direction", description: "Verifies the exact interpretation and applies only policy-approved configured choices.", example: "Reject missing clauses or invented evidence before any route can change.", category: "logic", icon: "resolve-direction", accent: "amber", retrySafe: true,
    inputs: [
      { id: "request", label: "Prepared request", type: "creative-direction-request", required: true },
      { id: "analysis", label: "Direction analysis", type: "creative-direction-analysis", required: true },
    ],
    outputs: [
      { id: "resolved", label: "Resolved choices", type: "resolved-creative-settings", required: true },
      { id: "conflict", label: "Conflict", type: "error", required: true },
    ],
    fields: [],
  },
  {
    type: "logic.resolve-creative-direction", version: 3, title: "Resolve creative direction", description: "Verifies the exact interpretation and applies only policy-approved configured choices.", example: "Reject missing clauses or invented evidence before any route can change.", category: "logic", icon: "resolve-direction", accent: "amber", retrySafe: true,
    inputs: [
      { id: "request", label: "Prepared request", type: "creative-direction-request", required: true },
      { id: "analysis", label: "Direction analysis", type: "creative-direction-analysis", required: true },
    ],
    outputs: [
      { id: "resolved", label: "Resolved choices", type: "resolved-creative-settings", required: true },
      { id: "conflict", label: "Conflict", type: "error", required: true },
    ],
    fields: [],
  },
  {
    type: "logic.resolve-creative-direction", version: 4, title: "Resolve creative direction", description: "Verifies the current request, changes only configured choices and writes evidence only to its configured destination.", example: "Reject missing clauses or invented evidence before any configured route can change.", category: "logic", icon: "resolve-direction", accent: "amber", retrySafe: true,
    inputs: [
      { id: "request", label: "Prepared request", type: "creative-direction-request", required: true },
      { id: "analysis", label: "Direction analysis", type: "creative-direction-analysis", required: true },
    ],
    outputs: [
      { id: "resolved", label: "Resolved choices", type: "resolved-creative-settings", required: true },
      { id: "conflict", label: "Conflict", type: "error", required: true },
    ],
    fields: [],
  },
  {
    type: "logic.limit-batch", version: 1, title: "Limit the amount", description: "Stops an unexpectedly large list before it reaches expensive or slow steps.", example: "Allow no more than 20 slide plans to continue to image generation.", category: "logic", icon: "limit", accent: "neutral", retrySafe: true,
    inputs: [{ id: "items", label: "Incoming list", type: "data", required: true }], outputs: [{ id: "items", label: "Allowed items", type: "data" }, { id: "summary", label: "Count summary", type: "data" }], fields: [
      { id: "maxItems", label: "Maximum number to continue", description: "The workflow stops with a clear error when the incoming list is larger.", kind: "number", defaultValue: 40, min: 1, max: 500 },
    ],
  },
  {
    type: "logic.merge", version: 1, title: "Merge paths", description: "Waits for connected paths and creates one clear list or named object for the next step.", example: "Combine an approved brief, copy and reference plan into one named planning package.", category: "logic", icon: "merge", accent: "neutral", retrySafe: true,
    inputs: DEFAULT_AUTOMATION_MERGE_INPUTS.map((input) => ({ id: input.id, label: humanizeAutomationPortName(input.name), type: "data", required: true })), outputs: [{ id: "result", label: "Combined information", type: "data" }], fields: [
      { id: "mode", label: "How should the results be combined?", description: "Use a named object when the next step should receive predictable fields. Use a list when every branch returns the same kind of item.", kind: "select", defaultValue: "named-object", options: [
        { value: "named-object", label: "Named object" }, { value: "append-list", label: "One combined list" },
      ] },
      { id: "inputs", label: "Inputs to wait for", description: "Add one named socket for every result this merge must receive. Each socket accepts exactly one connection.", kind: "json", defaultValue: DEFAULT_AUTOMATION_MERGE_INPUTS },
    ],
  },
  {
    type: "logic.run-subworkflow", version: 1, title: "Run another workflow", description: "Hands information to another runnable workflow, waits for it, then continues with its result.", example: "Send a finished image to a separate workflow that writes and schedules the social post.", category: "logic", icon: "workflow", accent: "mint",
    inputs: [{ id: "data", label: "Information to send", type: "data", required: true }], outputs: [{ id: "result", label: "Workflow result", type: "data" }, { id: "error", label: "Error path", type: "error" }], fields: [
      { id: "subworkflowSlot", label: "Connection name", description: "A safe name for the workflow you will connect below. The connected workflow can be changed after import.", placeholder: "Example: publish-content", kind: "text", required: true, defaultValue: "child-workflow" },
      { id: "childInputs", label: "Extra fixed information", description: "Advanced. Values that should be sent on every run in addition to the connected input.", kind: "json", defaultValue: {}, advanced: true },
      { id: "failureMode", label: "If the other workflow fails", description: "Either stop this run or pass the child-workflow error to a connected recovery path.", kind: "select", defaultValue: "stop", options: [{ value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" }], advanced: true },
    ],
  },
  {
    type: "logic.map-subworkflow", version: 1, title: "For each item", description: "Runs one reusable workflow for every item in a bounded list, then exposes the collected results and failures.", example: "Review every planned slide with the same child workflow and collect the answers in the original item order.", category: "logic", icon: "repeat", accent: "mint",
    inputs: [{ id: "items", label: "List of items", type: "data", required: true }], outputs: [{ id: "results", label: "Successful results", type: "data" }, { id: "failures", label: "Failed items", type: "data" }, { id: "error", label: "Error path", type: "error" }], fields: [
      { id: "subworkflowSlot", label: "Connection name", description: "A safe name for the workflow that will handle each item.", placeholder: "Example: review-one-slide", kind: "text", required: true, defaultValue: "item-workflow" },
      { id: "maxItems", label: "Maximum number of items", description: "Prevents an unexpectedly large list from creating too many runs.", kind: "number", defaultValue: 40, min: 1, max: 500 },
      { id: "concurrency", label: "How many may run at once", description: "Higher is faster but uses more provider capacity at the same time.", kind: "number", defaultValue: 3, min: 1, max: 16 },
      { id: "itemFailure", label: "If one item fails", description: "Choose whether completed items remain available or any failed item makes this whole step fail.", kind: "select", defaultValue: "keep-successful", options: [{ value: "keep-successful", label: "Keep the successful results" }, { value: "stop", label: "Stop the whole list" }] },
      { id: "childInputs", label: "Extra fixed information", description: "Advanced. Values sent with every item.", kind: "json", defaultValue: {}, advanced: true },
      { id: "failureMode", label: "If this step cannot finish", description: "Used when the list cannot be processed, including when every item fails or Stop the whole list is selected.", kind: "select", defaultValue: "stop", options: [{ value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" }], advanced: true },
    ],
  },
  {
    type: "integration.http-request", version: 1, title: "Connect an external service", description: "Sends information to an external app or API and passes its answer to the next step.", example: "Send a finished caption to your publishing service, or ask another API for campaign data.", category: "integration", icon: "http", accent: "blue",
    inputs: [{ id: "data", label: "Information to send", type: "data" }], outputs: [{ id: "response", label: "Service response", type: "data" }, { id: "error", label: "Error path", type: "error" }], fields: [
      { id: "url", label: "Where should the request go?", description: "Paste a complete public HTTP or HTTPS address. Private-network and credential-in-URL addresses are blocked.", placeholder: "https://api.example.com/v1/action", kind: "text", required: true, defaultValue: "" },
      { id: "method", label: "What should the service do?", description: "GET reads data, HEAD checks metadata, and POST usually creates or sends data. Match the service documentation.", kind: "select", defaultValue: "GET", options: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value, label: value })) },
      { id: "body", label: "Information to send", description: "The JSON content sent to the service. Use {{ data }}, {{ run }} or {{ trigger }} to insert connected or run-time values.", kind: "json", defaultValue: {}, visibleWhen: { fieldId: "method", values: ["POST", "PUT", "PATCH", "DELETE"] } },
      { id: "credentialSlot", label: "Connection name", description: "Give this secret connection a safe name. The actual key is selected below and never exported.", placeholder: "Example: post-bridge", kind: "text" },
      { id: "credentialKind", label: "How the service checks the key", description: "Choose the method required by the service. Bearer token is the most common.", kind: "select", defaultValue: "bearer", options: [
        { value: "api-key", label: "API key" }, { value: "bearer", label: "Bearer token" }, { value: "basic", label: "Username and password" }, { value: "header", label: "Custom header" },
      ] },
      { id: "headers", label: "Extra request headers", description: "Advanced. Add only headers required by the external service; secrets belong in the saved connection below.", kind: "json", defaultValue: {}, advanced: true },
      { id: "timeoutSeconds", label: "Stop waiting after, seconds", description: "How long to wait before treating the service as unavailable.", kind: "number", defaultValue: 30, min: 1, max: 120, advanced: true },
      { id: "maxAttempts", label: "How many times to try", description: "Retries temporary network or service failures. Create or change requests need an explicit Idempotency-Key header before more than one attempt is allowed.", kind: "number", defaultValue: 1, min: 1, max: 5, advanced: true },
      { id: "failureMode", label: "If the service still fails", description: "Stop, route a safe error response to a recovery path, or continue with an empty service response.", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" }, { value: "continue-empty", label: "Continue without an answer" },
      ], advanced: true },
    ],
  },
  {
    type: "logic.validate-slide-plans", version: 1, title: "Validate slide plans", description: "Checks every plan against the original choices, copy and references before images are created.", example: "Catch a lost location rule, wrong text strategy or reference-role leak before it spends image credits.", category: "logic", icon: "validate", accent: "blue", retrySafe: true,
    inputs: [{ id: "data", label: "Slide plans", type: "data", required: true }, { id: "contract", label: "Original generation contract", type: "data" }, { id: "source", label: "Original slideshow", type: "tiktok-source" }, { id: "identity", label: "Person or character", type: "identity" }, { id: "references", label: "Visual references", type: "visual-references" }], outputs: [{ id: "plans", label: "Checked plans", type: "slide-plan-set" }, { id: "error", label: "Validation error", type: "error" }], fields: [
      { id: "maxSlides", label: "Maximum slides allowed", description: "Stops the workflow when the plan unexpectedly contains more slides than you intended.", kind: "number", defaultValue: 40, min: 1, max: 40 },
      { id: "failureMode", label: "If validation fails", description: "Stop the run or send the exact validation error to an explicit repair path.", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to a repair path" },
      ], advanced: true },
    ],
  },
  {
    type: "logic.validate-slide-plans", version: 2, title: "Validate Recreate TikTok plans", description: "Checks every plan against the explicit Recreate TikTok v1 contract before images are created.", example: "Catch a lost location rule, wrong text strategy or reference-role leak before it spends image credits.", category: "logic", icon: "validate", accent: "blue", retrySafe: true,
    inputs: [{ id: "data", label: "Slide plans", type: "data", required: true }, { id: "contract", label: "Original generation contract", type: "data" }, { id: "source", label: "Original slideshow", type: "tiktok-source" }, { id: "identity", label: "Person or character", type: "identity" }, { id: "references", label: "Visual references", type: "visual-references" }], outputs: [{ id: "plans", label: "Checked plans", type: "slide-plan-set" }, { id: "error", label: "Validation error", type: "error" }], fields: [
      { id: "profile", label: "Validation contract", description: "This version enforces the visible fields and exact prompt/reference rules of Recreate TikTok v1. It does not infer another workflow profile.", kind: "select", defaultValue: "recreate-tiktok-v1", required: true, readOnly: true, options: [{ value: "recreate-tiktok-v1", label: "Recreate TikTok v1" }] },
      { id: "maxSlides", label: "Maximum slides allowed", description: "Stops the workflow when the plan unexpectedly contains more slides than you intended.", kind: "number", defaultValue: 40, min: 1, max: 40 },
      { id: "failureMode", label: "If validation fails", description: "Stop the run or send the exact validation error to an explicit repair path.", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to a repair path" },
      ], advanced: true },
    ],
  },
  {
    type: "generation.image", version: 1, title: "Image Generator", description: "Creates one image for every checked slideshow plan with its source composition and selected identity references.", example: "Create one 9:16 image for each reviewed slide plan while keeping the selected identity consistent.", category: "generation", icon: "generate", accent: "image",
    inputs: [
      { id: "plans", label: "Image plans", type: "slide-plan-set", required: true },
      { id: "source", label: "Original slideshow", type: "tiktok-source", required: true },
      { id: "identity", label: "Person or character", type: "identity" },
      { id: "references", label: "Visual references", type: "visual-references" },
    ], outputs: [{ id: "assets", label: "Created images", type: "generated-assets" }, { id: "error", label: "Error path", type: "error" }], fields: [
      { id: "modelId", label: "Image model", description: "Choose this step's image model independently from the same models available to Canvas Image Generator.", kind: "model", runtimeBindable: true, runtimeValueType: "image-model", modelCapability: "image", required: true },
      { id: "ratio", label: "Image shape", description: "Choose the format required by the destination, for example 9:16 for TikTok.", kind: "select", runtimeBindable: true, runtimeValueType: "aspect-ratio" },
      { id: "resolution", label: "Image quality", description: "Higher resolutions may cost more and take longer, depending on the provider.", kind: "select", runtimeBindable: true, runtimeValueType: "resolution" },
      { id: "partialFailure", label: "If only some images fail", description: "Keep the successful images, or stop without adding any result to the canvas.", kind: "select", defaultValue: "keep-successful", options: [
        { value: "keep-successful", label: "Keep the images that succeeded" }, { value: "stop", label: "Stop without adding results" },
      ] },
      { id: "concurrency", label: "How many images to create at once", description: "Higher is faster but uses more provider capacity at the same time.", kind: "number", defaultValue: 3, min: 1, max: 8, advanced: true },
      { id: "maxAttempts", label: "Attempts for each image", description: "Retries a slide when the provider request fails.", kind: "number", defaultValue: 3, min: 1, max: 5, advanced: true },
      { id: "failureMode", label: "If every image fails", description: "Stop the run or send the generation error to a connected recovery path.", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" },
      ], advanced: true },
    ],
  },
  {
    type: "logic.prepare-slideshow-image-requests", version: 1, title: "Prepare slideshow image requests", description: "Converts checked TikTok slide plans into exact generic image requests without changing their prompts.", example: "Serialize every approved slide prompt and its ordered references before provider execution.", category: "logic", icon: "image-requests", accent: "neutral", retrySafe: true,
    inputs: [
      { id: "plans", label: "Checked slide plans", type: "slide-plan-set", required: true },
      { id: "source", label: "Original slideshow", type: "tiktok-source", required: true },
      { id: "identity", label: "Person or character", type: "identity" },
      { id: "references", label: "Visual references", type: "visual-references" },
    ],
    outputs: [{ id: "requests", label: "Image requests", type: "image-request-batch", required: true }],
    fields: [],
  },
  {
    type: "generation.image", version: 2, title: "Image Generator", description: "Creates images from exact prompts and reference roles prepared by connected workflow nodes.", example: "Create a batch of images without adding or reinterpreting creative instructions.", category: "generation", icon: "generate", accent: "image",
    inputs: [
      { id: "requests", label: "Image requests", type: "image-request-batch", required: true },
    ], outputs: [{ id: "assets", label: "Created images", type: "generated-assets" }, { id: "error", label: "Error path", type: "error" }], fields: [
      { id: "modelId", label: "Image model", description: "Choose this step's image model independently from the same models available to Canvas Image Generator.", kind: "model", runtimeBindable: true, runtimeValueType: "image-model", modelCapability: "image", required: true },
      { id: "ratio", label: "Image shape", description: "Choose the format required by the destination, for example 9:16 for TikTok.", kind: "select", runtimeBindable: true, runtimeValueType: "aspect-ratio", required: true },
      { id: "resolution", label: "Image quality", description: "Higher resolutions may cost more and take longer, depending on the provider.", kind: "select", runtimeBindable: true, runtimeValueType: "resolution", required: true },
      { id: "partialFailure", label: "If only some images fail", description: "Keep the successful images, or stop without adding any result to the canvas.", kind: "select", defaultValue: "keep-successful", options: [
        { value: "keep-successful", label: "Keep the images that succeeded" }, { value: "stop", label: "Stop without adding results" },
      ] },
      { id: "concurrency", label: "How many images to create at once", description: "Higher is faster but uses more provider capacity at the same time.", kind: "number", defaultValue: 3, min: 1, max: 8, advanced: true },
      { id: "maxAttempts", label: "Attempts for each image", description: "Retries a slide when the provider request fails.", kind: "number", defaultValue: 3, min: 1, max: 5, advanced: true },
      { id: "failureMode", label: "If every image fails", description: "Stop the run or send the generation error to a connected recovery path.", kind: "select", defaultValue: "stop", options: [
        { value: "stop", label: "Stop and show the error" }, { value: "error-output", label: "Send the error to another path" },
      ], advanced: true },
    ],
  },
  {
    type: "output.add-to-canvas", version: 1, title: "Add slideshow to canvas", description: "Places the created slideshow images back on the content canvas where they stay editable.", example: "Put the new slideshow beside its TikTok source so you can compare, edit and continue from either version.", category: "output", icon: "canvas", accent: "mint", terminal: true,
    inputs: [{ id: "assets", label: "Created images", type: "generated-assets", required: true }, { id: "source", label: "Original source", type: "tiktok-source" }], outputs: [{ id: "result", label: "Canvas update receipt", type: "canvas-result", connectable: false }], fields: [
      { id: "layout", label: "Where should results appear?", description: "Choose whether to keep the new branch beside the source or place it on a separate row.", kind: "select", defaultValue: "beside-source", options: [
        { value: "beside-source", label: "Beside the source" }, { value: "new-row", label: "On a new row" },
      ] },
      { id: "includePlanNote", label: "Show the plan beside the images", description: "Adds a note explaining what each generated slide was meant to do.", kind: "boolean", defaultValue: true },
    ],
  },
  {
    type: "output.add-to-canvas", version: 2, title: "Add slideshow to canvas", description: "Places canonical generated-image results on the content canvas without guessing an older output format.", example: "Put the new slideshow beside its TikTok source so you can compare, edit and continue from either version.", category: "output", icon: "canvas", accent: "mint", terminal: true,
    inputs: [{ id: "assets", label: "Created images", type: "generated-assets", required: true }, { id: "source", label: "Original source", type: "tiktok-source" }], outputs: [{ id: "result", label: "Canvas update receipt", type: "canvas-result", connectable: false }], fields: [
      { id: "layout", label: "Where should results appear?", description: "Choose whether to keep the new branch beside the source or place it on a separate row.", kind: "select", defaultValue: "beside-source", options: [
        { value: "beside-source", label: "Beside the source" }, { value: "new-row", label: "On a new row" },
      ] },
      { id: "includePlanNote", label: "Show the plan beside the images", description: "Adds a note explaining what each generated slide was meant to do.", kind: "boolean", defaultValue: true },
    ],
  },
  {
    type: "output.add-to-canvas", version: 3, title: "Add slideshow to canvas", description: "Places canonical generated-image results on the content canvas and preserves the complete plan without silent truncation.", example: "Put the new slideshow beside its TikTok source so you can compare, edit and continue from either version.", category: "output", icon: "canvas", accent: "mint", terminal: true,
    inputs: [{ id: "assets", label: "Created images", type: "generated-assets", required: true }, { id: "source", label: "Original source", type: "tiktok-source" }], outputs: [{ id: "result", label: "Canvas update receipt", type: "canvas-result", connectable: false }], fields: [
      { id: "layout", label: "Where should results appear?", description: "Choose whether to keep the new branch beside the source or place it on a separate row.", kind: "select", defaultValue: "beside-source", options: [
        { value: "beside-source", label: "Beside the source" }, { value: "new-row", label: "On a new row" },
      ] },
      { id: "includePlanNote", label: "Show the plan beside the images", description: "Adds as many bounded notes as needed to preserve the complete generation plan.", kind: "boolean", defaultValue: true },
    ],
  },
  {
    type: "output.finish", version: 1, title: "Finish without adding to canvas", description: "Ends this path and reports its result without creating new canvas nodes.", example: "Use this after sending data to an external service when there is nothing visual to add to the canvas.", category: "output", icon: "finish", accent: "neutral", terminal: true,
    inputs: [{ id: "data", label: "Final information", type: "data", required: true }], outputs: [{ id: "result", label: "Run result receipt", type: "workflow-result", connectable: false }], fields: [
      { id: "outcome", label: "How should this path finish?", description: "Finish successfully with the incoming information, or deliberately mark this workflow path as failed.", kind: "select", defaultValue: "completed", options: [
        { value: "completed", label: "Finish successfully" }, { value: "failed", label: "Stop the workflow with this error" },
      ] },
      { id: "message", label: "Message shown in the run result", description: "Use {{ data }}, {{ run }} or {{ trigger }} when the message should include a value from this run.", placeholder: "Example: Caption sent for publishing", kind: "text", defaultValue: "Workflow finished" },
    ],
  },
];

const definitions: AutomationNodeDefinition[] = rawDefinitions.map(withHelp);

const registry = new Map(definitions.map((definition) => [`${definition.type}@${definition.version}`, definition]));
const latestDefinitions = [...definitions.reduce((byType, definition) => {
  const current = byType.get(definition.type);
  if (!current || definition.version > current.version) byType.set(definition.type, definition);
  return byType;
}, new Map<string, AutomationNodeDefinition>()).values()];

export const automationNodeCategoryDefinitions: ReadonlyArray<{
  id: AutomationNodeDefinition["category"];
  label: string;
  nodeLabel: string;
}> = [
  { id: "trigger", label: "Triggers", nodeLabel: "Trigger" },
  { id: "input", label: "Inputs", nodeLabel: "Input" },
  { id: "ai", label: "AI", nodeLabel: "AI" },
  { id: "logic", label: "Logic", nodeLabel: "Logic" },
  { id: "integration", label: "Integrations", nodeLabel: "Integration" },
  { id: "generation", label: "Generation", nodeLabel: "Generation" },
  { id: "output", label: "Outputs", nodeLabel: "Output" },
];

export function automationNodeDefinitions() {
  return latestDefinitions;
}

export function automationNodeDefinition(type: string, version: number) {
  return registry.get(`${type}@${version}`);
}

export function automationPortTypesCompatible(source: AutomationPortType, target: AutomationPortType) {
  // A generic data input may consume any structured value. Generic data must
  // never masquerade as a stronger domain type such as a TikTok source,
  // identity or generated asset collection.
  return source === target || target === "data";
}
