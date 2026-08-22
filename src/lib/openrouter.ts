import { readStorageObject, signedStorageReadUrl } from "./storage";
import { AsyncLocalStorage } from "node:async_hooks";
import { requireInstanceSecret } from "@/platform/secrets";
import { DEFAULT_ASSISTANT_MODEL_ID, getAssistantModel } from "./assistant-models";
import { extractPromptStoryboard } from "./video-storyboard";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const model = DEFAULT_ASSISTANT_MODEL_ID;

export type OpenRouterUsageEntry = {
  requestId: string;
  model: string;
  stage: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type OpenRouterUsageTracker = { entries: OpenRouterUsageEntry[] };
type OpenRouterUsageStore = { tracker: OpenRouterUsageTracker; stage: string };
const openRouterUsageStorage = new AsyncLocalStorage<OpenRouterUsageStore>();
const openRouterModelStorage = new AsyncLocalStorage<string>();

export function createOpenRouterUsageTracker(): OpenRouterUsageTracker {
  return { entries: [] };
}

export function withOpenRouterUsage<T>(tracker: OpenRouterUsageTracker, callback: () => Promise<T>) {
  return openRouterUsageStorage.run({ tracker, stage: "unclassified" }, callback);
}

export function withOpenRouterUsageStage<T>(stage: string, callback: () => Promise<T>) {
  const current = openRouterUsageStorage.getStore();
  return current ? openRouterUsageStorage.run({ tracker: current.tracker, stage }, callback) : callback();
}

export function withOpenRouterModel<T>(modelId: string | undefined, callback: () => Promise<T>) {
  return openRouterModelStorage.run(getAssistantModel(modelId).id, callback);
}

function selectedOpenRouterModel(body: Record<string, unknown>) {
  const requested = typeof body.model === "string" ? body.model : openRouterModelStorage.getStore() || model;
  return getAssistantModel(requested).id;
}

export function summarizeOpenRouterUsage(tracker: OpenRouterUsageTracker) {
  return tracker.entries.reduce((summary, entry) => ({
    requestCount: summary.requestCount + 1,
    costUsd: summary.costUsd + entry.costUsd,
    promptTokens: summary.promptTokens + entry.promptTokens,
    completionTokens: summary.completionTokens + entry.completionTokens,
    totalTokens: summary.totalTokens + entry.totalTokens,
  }), { requestCount: 0, costUsd: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
}

function recordOpenRouterUsage(payload: {
  id?: unknown;
  model?: unknown;
  usage?: { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
}) {
  const store = openRouterUsageStorage.getStore();
  if (!store || !payload.usage) return;
  store.tracker.entries.push({
    requestId: String(payload.id || ""),
    model: String(payload.model || model),
    stage: store.stage,
    costUsd: Math.max(0, Number(payload.usage.cost) || 0),
    promptTokens: Math.max(0, Number(payload.usage.prompt_tokens) || 0),
    completionTokens: Math.max(0, Number(payload.usage.completion_tokens) || 0),
    totalTokens: Math.max(0, Number(payload.usage.total_tokens) || 0),
  });
}

function apiKey() {
  return requireInstanceSecret("OPENROUTER_API_KEY");
}

export function parseOpenRouterJson(text: string) {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(),
    trimmed.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
  ];
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return JSON.parse(candidate) as Record<string, unknown>; }
    catch { /* Try the next normalized representation. */ }
  }
  throw new Error("Model returned invalid structured data");
}

export async function requestOpenRouter(body: Record<string, unknown>) {
  const requestModel = selectedOpenRouterModel(body);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_URL || "https://scenelith.com",
      "X-Title": "Frameflow",
    },
    body: JSON.stringify({ temperature: 0.2, ...body, model: requestModel }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    model?: string;
    usage?: { cost?: number | string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string; metadata?: { raw?: unknown; provider_name?: string } };
    choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
  };
  recordOpenRouterUsage(payload);
  if (!response.ok) {
    const metadata = payload.error?.metadata;
    const raw = typeof metadata?.raw === "string" ? metadata.raw : metadata?.raw ? JSON.stringify(metadata.raw) : "";
    const detail = [metadata?.provider_name, raw.replace(/\s+/g, " ").slice(0, 800)].filter(Boolean).join(": ");
    throw new Error([payload.error?.message || `OpenRouter returned ${response.status}`, detail].filter(Boolean).join(" — "));
  }
  const content = payload.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : content?.map((item) => item.text || "").join("") || "";
  return parseOpenRouterJson(text);
}

async function requestOpenRouterText(body: Record<string, unknown>) {
  const requestModel = selectedOpenRouterModel(body);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_URL || "https://scenelith.com",
      "X-Title": "Frameflow",
    },
    body: JSON.stringify({ temperature: 0.35, ...body, model: requestModel }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    model?: string;
    usage?: { cost?: number | string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
  };
  recordOpenRouterUsage(payload);
  if (!response.ok) throw new Error(payload.error?.message || `OpenRouter returned ${response.status}`);
  const content = payload.choices?.[0]?.message?.content;
  return (typeof content === "string" ? content : content?.map((item) => item.text || "").join("") || "").trim();
}

async function storageImageUrl(path: string, mimeType: string) {
  // OpenRouter accepts remote HTTPS image_url inputs. A short-lived R2 URL
  // keeps private media private while avoiding an R2 read plus base64 copy in
  // the app process. Local development keeps the data-URL fallback.
  const signedUrl = await signedStorageReadUrl(path, { expiresIn: 20 * 60 }).catch(() => null);
  if (signedUrl) return signedUrl;
  const base64 = (await readStorageObject(path)).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

export const assistantModelId = model;

type GenerationPromptReference = {
  path: string;
  mimeType: string;
  token: string;
  title: string;
  role?: string;
  purpose?: "edit-source" | "canvas" | "identity" | "upload";
  durationSeconds?: number;
};

type GenerationPromptContext = {
  brief: string;
  references: GenerationPromptReference[];
  mediaType?: "image" | "video";
  modelId?: string;
  modelLabel?: string;
  duration?: string;
  generateAudio?: boolean;
  editMode?: boolean;
  aspectRatio?: string;
  resolution?: string;
  sourceAspectRatio?: string;
  sourceDimensions?: string;
  outputSizeChanged?: boolean;
  sceneSource?: GenerationPromptReference;
  videoMasterContext?: {
    nodeId: string;
    clipId: string;
    clipTitle: string;
    timelineDurationSeconds: number;
    generationDurationSeconds?: number;
    sourceKind: "source-segment" | "uploaded-clip" | "new-scene";
    sourceAspectRatio: string;
    outputAspectRatio: string;
    outputRatioChanged: boolean;
  };
};

export function imagePromptSystemInstruction(input: Pick<GenerationPromptContext, "editMode" | "modelId" | "modelLabel" | "aspectRatio" | "resolution" | "sourceAspectRatio" | "sourceDimensions" | "outputSizeChanged"> = {}) {
  return `You are a senior prompt architect for reference-driven image generation and editing. Convert the request into a precise, directly runnable JSON prompt for an image model.

REFERENCE CONTRACT:
- Inspect every supplied reference image and keep every exact @token unchanged.
- Bind each token to one unambiguous role: source composition, identity, location, pose, outfit, style, or another explicitly declared role.
- A source-composition reference controls framing, pose archetype, camera, lighting, environment and storytelling function only. It must never supply the replacement person's face, hair, body or identity.
- Identity references control the same target person's stable face, hair and physical identity. When several identity references are supplied, use them together as multiple views of one person, never as different people and never blend them with the source subject.
- Name every token used for identity directly in subject.identity and in the task. Do not use vague aliases such as @Persona or “the references”.
- Keep every supplied token exactly once in reference_plan. Never invent, omit, rename or swap a token.

INSTRUCTION CONTRACT:
- The task must say exactly which subject is replaced, which exact tokens provide the new identity, what is preserved and what changes.
- reference_plan must explain the operational role of every image, not merely label it.
- subject must describe the target identity, appearance, pose and expression. Do not copy source-subject traits when identity replacement is requested.
- scene must describe environment, composition, lighting and camera separately.
- preserve and change must be explicit and non-contradictory. avoid must name likely failure modes such as mixed identity, distorted anatomy, changed framing or unwanted text.
- Preserve the user's language and intent. If something is underspecified, choose realistic conservative defaults instead of unrelated creative ideas.
- Return only the JSON object. No markdown, preface, comments, alternatives or prose outside JSON.
${input.editMode ? `
IMAGE EDIT MODE:
- @EditSource is the exact current image. Preserve everything not explicitly requested to change.
- Any other attached reference is supporting evidence, never a replacement canvas. Use it only for the exact identity, pose, object, outfit, style, or setting property requested by the user.
- A reference declared as identity controls the named person's stable identity only unless the user explicitly assigns another property. Canvas and upload references have no automatic authority: infer their role from the user's edit request and state that role precisely in reference_plan.
- Use the visible reference title and exact @token together so the user can audit which image controls each change.
- Selected edit model: ${input.modelLabel || input.modelId || "image model"}.
- Source dimensions: ${input.sourceDimensions || "unknown"}; source aspect: ${input.sourceAspectRatio || "unknown"}.
- Required output: ${input.aspectRatio || "preserve source aspect"} at ${input.resolution || "the selected quality"}.
- ${input.outputSizeChanged ? `The user selected a different output shape. Explicitly instruct the model to reframe, crop, or extend the canvas to ${input.aspectRatio} while preserving the requested subject and content.` : "Keep the original composition and framing unless the edit request itself requires a local change."}
- The output.format field must state the required output aspect ratio and resolution.` : ""}`;
}

const videoReferenceRoleNames: Record<string, string> = {
  "start-frame": "start image",
  "end-frame": "end image",
  "reference-image": "visual reference",
  "reference-video": "reference video",
  "motion-video": "reference motion video",
  "reference-audio": "reference audio",
};

export function videoPromptSystemInstruction(input: Pick<GenerationPromptContext, "modelId" | "modelLabel" | "duration" | "generateAudio" | "references" | "sceneSource" | "videoMasterContext">) {
  const roles = new Set(input.references.map((reference) => reference.role));
  const hasStart = roles.has("start-frame");
  const hasEnd = roles.has("end-frame");
  const hasMotionVideo = roles.has("reference-video") || roles.has("motion-video");
  const hasAudioReference = roles.has("reference-audio");
  const isMotionControl = input.modelId === "kling-3-motion";
  const isSeedance = input.modelId?.startsWith("seedance-2");
  const isSeedance25 = input.modelId === "seedance-2-5";
  const master = input.videoMasterContext;
  const trimRule = master && master.generationDurationSeconds && master.generationDurationSeconds > master.timelineDurationSeconds + .01
    ? `The provider generates ${master.generationDurationSeconds.toFixed(3)} seconds, but the edited scene keeps only the first ${master.timelineDurationSeconds.toFixed(3)} seconds. Put every required action and payoff inside that kept interval. Continue naturally after it so trimming does not cut in the middle of an essential action.`
    : master ? `The edited scene and generated clip both last ${master.timelineDurationSeconds.toFixed(3)} seconds. Keep all action feasible inside that exact interval.` : "";
  const modelRules = isMotionControl
    ? `This is Kling Motion Control. The start image defines the subject's appearance. The reference video defines pose, body movement, timing and motion trajectory, including framing and camera movement. Write a short replacement instruction: identify exactly which connected image supplies the replacement subject and which reference video supplies motion. Do not restate or redesign the reference video's shot, invent a competing camera path, or add timecodes. Do not request a duration; duration is inherited from the reference video.`
    : isSeedance25 && master
      ? `This is Seedance 2.5 multimodal generation for one selected Video Master scene. Produce a model-ready prompt with compact uppercase sections when useful (REFERENCE ROLES, LOOK, and TIMELINE). Use timestamped beats from 00:00.000 through the exact generated duration. Every timestamp must use MM:SS.mmm syntax (for example, four seconds is 00:04.000, never 04:00). When generation is longer than the kept timeline, no required-action beat may cross the kept boundary: end it at or before that boundary, then create a separate tail beat containing only settled natural continuation. Never copy internal storyboard labels such as CHRONOLOGICAL STORYBOARD FOR into the final prompt. Do not write a multi-scene commercial unless the user asks for one; this prompt controls only ${master.clipTitle}. Bind every @token to one explicit responsibility and preserve identity continuity across the whole clip.`
    : isSeedance
      ? `This is Seedance 2 multimodal video generation. Bind every mentioned @token to its declared role. When start and end images are present, describe one physically continuous transition between them. Reference video supplies motion language; reference audio supplies rhythm, ambience or speech timing.`
      : `Follow the selected model's connected inputs exactly. A start image defines the initial visual state; an end image defines the final state; a reference video supplies motion or timing.`;
  const contextualRules = [
    hasStart ? "Because a start image is connected, emphasize what moves after that frame instead of redundantly re-describing every visible static detail." : "Define the subject and initial visual state clearly.",
    hasEnd ? "Describe a believable continuous progression that arrives at the connected end image without a cut or unrelated scene change." : "Do not invent an end-frame constraint.",
    hasMotionVideo ? "Keep motion compatible with the connected reference video and avoid contradictory choreography." : "Specify one clear subject action and one compatible camera behavior.",
    hasAudioReference ? "Describe how visible action synchronizes with the connected audio; do not fabricate lyrics or dialogue that were not requested." : input.generateAudio ? "Add only concise, scene-appropriate sound direction when it helps the requested shot." : "Do not add sound-design instructions.",
  ].join("\n- ");
  const outputFormat = isMotionControl
    ? "Return only one concise operational prompt with no headings, markdown, explanation or alternatives."
    : isSeedance25 && master
      ? "Return only the finished prompt. Compact section headings and timestamp ranges are allowed; do not add explanation or alternatives."
      : "Return only the prompt, with no JSON, headings, markdown, explanation or alternatives.";
  return `You are a senior video-generation prompt director for ${input.modelLabel || input.modelId || "the selected video model"}. Convert the user's plain-language idea into one production-ready video prompt.

Write the final prompt in concise English. ${outputFormat}

Build a single coherent shot in this order when relevant: shot and subject, one continuous action, environment, camera movement, lighting and atmosphere, temporal progression, then audio direction. Use concrete observable movement and positive instructions. Keep the action feasible within ${input.duration ? `${input.duration} seconds` : "one short generated clip"}. Avoid contradictory camera moves, multiple unrelated scene changes, prompt-padding, quality buzzwords and long negative lists.

${modelRules}

${master ? `VIDEO MASTER SCENE CONTRACT:
- Selected scene: ${master.clipTitle} (${master.sourceKind}).
- Timeline duration: ${master.timelineDurationSeconds.toFixed(3)} seconds.
- Generated duration: ${(master.generationDurationSeconds || master.timelineDurationSeconds).toFixed(3)} seconds.
- Source format: ${master.sourceAspectRatio}. Output format: ${master.outputAspectRatio}${master.outputRatioChanged ? " (the user changed the source format; describe deliberate reframing/crop/extension)" : " (preserve the source framing and orientation)"}.
- ${trimRule}
- Storyboard frames extracted from connected videos are visual evidence of progression. Read them chronologically. Do not confuse a storyboard frame with a separate reference identity or invent details that the frames do not show.` : ""}

${master ? `SELECTED SCENE SOURCE RULES:
- The SELECTED SCENE SOURCE storyboard is the authoritative visual record for this exact Video Master scene, never an adjacent scene.
- Preserve its subject, outfit, environment, framing, pose progression and action unless the user explicitly assigns a connected reference to replace a specific property.
- Do not borrow appearance, clothing, movement or location from another scene. Do not invent details that contradict the selected source frames.
- The user can refer to this exact selected source as ${input.sceneSource?.token || "the selected scene source"} in USER VIDEO IDEA.
- When ${input.sceneSource?.token || "that alias"} is absent from CONNECTED INPUTS, it is an authoring alias only: interpret it from the authoritative storyboard, then express its visible facts directly in the finished provider prompt instead of emitting the alias.
- Emit the selected-source @token in the finished prompt only when the same token is also listed in CONNECTED INPUTS.` : ""}

Context rules:
- ${contextualRules}

Keep every supplied @token exactly unchanged and use it only for its declared role. Never swap roles or invent a reference that is not connected.`;
}

function videoPromptTimecode(seconds: number) {
  const safeMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(safeMilliseconds / 60_000);
  const remainder = safeMilliseconds - minutes * 60_000;
  const wholeSeconds = Math.floor(remainder / 1000);
  const milliseconds = remainder - wholeSeconds * 1000;
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export function finalizeVideoPrompt(prompt: string, input: Pick<GenerationPromptContext, "modelId" | "videoMasterContext">) {
  const cleanPrompt = prompt.replace(/CHRONOLOGICAL STORYBOARD FOR\s+@[A-Za-z0-9_]+/gi, "— chronological motion reference.").trim();
  const master = input.videoMasterContext;
  if (!master || input.modelId !== "seedance-2-5") return cleanPrompt;

  const timelineDuration = master.timelineDurationSeconds;
  const generatedDuration = master.generationDurationSeconds || timelineDuration;
  const timelineEnd = videoPromptTimecode(timelineDuration);
  const generatedEnd = videoPromptTimecode(generatedDuration);
  const hasTrimTail = generatedDuration > timelineDuration + .01;
  const contract = [
    "GENERATION CONTRACT",
    `- Generate exactly ${generatedDuration.toFixed(3)} seconds (${videoPromptTimecode(0)}–${generatedEnd}) in ${master.outputAspectRatio}.`,
    hasTrimTail
      ? `- The edited scene keeps only ${videoPromptTimecode(0)}–${timelineEnd}. Complete every required action and payoff by ${timelineEnd}.`
      : `- The full generated interval ${videoPromptTimecode(0)}–${timelineEnd} is used in the edited scene.`,
    hasTrimTail
      ? `- ${timelineEnd}–${generatedEnd} is disposable natural continuation so the timeline can trim cleanly; do not place essential action there.`
      : "",
    hasTrimTail
      ? `- TIMING OVERRIDE: no later action beat may straddle ${timelineEnd}. Compress it to finish by ${timelineEnd}, then hold or naturally settle the completed state through ${generatedEnd}.`
      : "",
  ].filter(Boolean).join("\n");
  return `${contract}\n\n${cleanPrompt}`;
}

export async function generateAssistantPrompt(input: {
  instruction: string;
  connectedText?: string;
  systemPrompt?: string;
  images: Array<{ path: string; mimeType: string; title: string }>;
}) {
  const content: Array<Record<string, unknown>> = [{
    type: "text",
    text: [
      `USER TASK:\n${input.instruction}`,
      input.connectedText ? `CONNECTED TEXT CONTEXT:\n${input.connectedText}` : "",
      input.images.length ? "Use the attached images as visual context. Do not claim details that are not visible." : "",
    ].filter(Boolean).join("\n\n"),
  }];
  for (const image of input.images) {
    content.push(
      { type: "text", text: `IMAGE CONTEXT — ${image.title}` },
      { type: "image_url", image_url: { url: await storageImageUrl(image.path, image.mimeType) } },
    );
  }
  const result = await requestOpenRouterText({
    max_tokens: 4096,
    messages: [
      {
        role: "system",
        content: input.systemPrompt?.trim() || "You are a precise creative prompt generator. Turn the user's task and connected context into one polished, production-ready prompt. Return only the final prompt, with no preamble, analysis, markdown fence, or follow-up question.",
      },
      { role: "user", content },
    ],
  });
  if (!result) throw new Error("Gemini returned an empty prompt");
  return result;
}

export async function extractHookFromImage(path: string, mimeType: string) {
  const imageUrl = await storageImageUrl(path, mimeType);
  const result = await requestOpenRouter({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Read the first TikTok slide. Extract the visible opening hook/headline exactly as written, preserving wording, casing, emojis and line order. Ignore TikTok UI, usernames and watermarks. Also identify the language and briefly name the hook angle. If there is no visible hook text, return an empty hook." },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "tiktok_hook_extraction",
        strict: true,
        schema: {
          type: "object",
          properties: { hook: { type: "string" }, language: { type: "string" }, angle: { type: "string" } },
          required: ["hook", "language", "angle"], additionalProperties: false,
        },
      },
    },
  });
  return { hook: String(result.hook || "").trim(), language: String(result.language || ""), angle: String(result.angle || "") };
}

export async function generateHookVariants(input: { original: string; rolePrompt: string; brief?: string; count?: number; avoid?: string[] }) {
  const count = Math.min(10, Math.max(1, input.count || 1));
  const sourceWords = input.original.trim().split(/\s+/).filter(Boolean).length;
  const sourceLines = Math.max(1, input.original.split(/\n+/).length);
  const result = await requestOpenRouter({
    temperature: 0.8,
    messages: [
      { role: "system", content: `You rewrite short first-slide TikTok hooks. Product role: ${input.rolePrompt || "Create broadly useful social video hooks."}\n\nHARD RULES — these override every other instruction:\n- Output only hook text through the JSON schema, never explanations.\n- Return exactly ${count} separate variant${count === 1 ? "" : "s"}.\n- Match the source hook's brevity, rhythm, casing, punctuation, POV pattern and line structure.\n- Each rewritten hook must have no more than ${Math.max(3, sourceWords + 1)} words.\n- Use exactly ${sourceLines} visual line${sourceLines === 1 ? "" : "s"}, separated with newline characters.\n- Do not add context, benefits, timelines, methods, causes, CTAs or claims unless they already exist in the source.\n- Change only the minimum wording needed to make the hook native to the product niche.\n- Never repeat or lightly rephrase any previously used variant listed by the user.\n- If multiple variants are requested, make each meaningfully different without making it longer.\n- If the source is a fragment, output a fragment. If it starts with 'pov:', preserve that structure.` },
      { role: "user", content: `Adapt this source hook for the specified product role while preserving its exact compact format:\n\n${input.original}\n\nOptional direction: ${input.brief || "none"}\n\nPreviously used variants — do not repeat or closely imitate:\n${input.avoid?.length ? input.avoid.map((item, index) => `${index + 1}. ${item.replace(/\n/g, " / ")}`).join("\n") : "none"}\n\nCreate exactly ${count} new variant${count === 1 ? "" : "s"}.` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "hook_variants",
        strict: true,
        schema: {
          type: "object",
          properties: { variants: { type: "array", minItems: count, maxItems: count, items: { type: "object", properties: { text: { type: "string" }, angle: { type: "string" } }, required: ["text", "angle"], additionalProperties: false } } },
          required: ["variants"], additionalProperties: false,
        },
      },
    },
  });
  const maxWords = Math.max(3, sourceWords + 1);
  const templateLineCounts = input.original.split(/\n+/).map((line) => line.trim().split(/\s+/).filter(Boolean).length);
  return Array.isArray(result.variants) ? result.variants.map((item) => {
    const value = item as { text?: unknown; angle?: unknown };
    const words = String(value.text || "").trim().split(/\s+/).filter(Boolean).slice(0, maxWords);
    const lines: string[] = [];
    let cursor = 0;
    for (let index = 0; index < sourceLines; index += 1) {
      const take = index === sourceLines - 1 ? words.length - cursor : Math.min(templateLineCounts[index] || 1, words.length - cursor);
      lines.push(words.slice(cursor, cursor + Math.max(0, take)).join(" "));
      cursor += Math.max(0, take);
    }
    return { text: lines.filter(Boolean).join("\n"), angle: String(value.angle || "").trim() };
  }).filter((item) => item.text) : [];
}

export async function composeGenerationPrompt(input: GenerationPromptContext) {
  if (input.mediaType === "video") {
    const referenceContent: Array<Record<string, unknown>> = [];
    let storyboardFrameBudget = 12;
    if (input.sceneSource?.mimeType.startsWith("video/") && storyboardFrameBudget >= 3) {
      const sourceStoryboard = await extractPromptStoryboard({
        path: input.sceneSource.path,
        mimeType: input.sceneSource.mimeType,
        durationSeconds: input.sceneSource.durationSeconds,
        frameCount: Math.min(5, storyboardFrameBudget),
      }).catch(() => []);
      storyboardFrameBudget -= sourceStoryboard.length;
      if (sourceStoryboard.length) {
        referenceContent.push({ type: "text", text: `SELECTED SCENE SOURCE ${input.sceneSource.token} — ${input.sceneSource.title}. These frames belong to the exact scene being authored and are authoritative. The user may use this token as an authoring alias.` });
        sourceStoryboard.forEach((frame) => referenceContent.push(
          { type: "text", text: `Selected scene source · ${frame.timeSeconds.toFixed(3)}s` },
          { type: "image_url", image_url: { url: frame.dataUrl } },
        ));
      }
    }
    for (const reference of input.references) {
      const role = videoReferenceRoleNames[reference.role || ""] || reference.role || "visual reference";
      referenceContent.push({ type: "text", text: `REFERENCE ${reference.token} — ${reference.title}\nDECLARED ROLE: ${role}` });
      if (reference.mimeType.startsWith("image/")) {
        referenceContent.push({ type: "image_url", image_url: { url: await storageImageUrl(reference.path, reference.mimeType) } });
      } else if (reference.mimeType.startsWith("video/") && storyboardFrameBudget >= 3) {
        const storyboard = await extractPromptStoryboard({ path: reference.path, mimeType: reference.mimeType, durationSeconds: reference.durationSeconds, frameCount: Math.min(5, storyboardFrameBudget) }).catch(() => []);
        storyboardFrameBudget -= storyboard.length;
        if (storyboard.length) {
          referenceContent.push({ type: "text", text: `CHRONOLOGICAL STORYBOARD FOR ${reference.token} — ${storyboard.length} frames from start to end. Read these as one continuous video, not separate images.` });
          storyboard.forEach((frame) => referenceContent.push(
            { type: "text", text: `${reference.token} storyboard · ${frame.timeSeconds.toFixed(3)}s` },
            { type: "image_url", image_url: { url: frame.dataUrl } },
          ));
        }
      }
    }
    const result = await requestOpenRouterText({
      temperature: 0.28,
      max_tokens: 4096,
      messages: [
        { role: "system", content: videoPromptSystemInstruction(input) },
        {
          role: "user",
          content: [
            { type: "text", text: `USER VIDEO IDEA:\n${input.brief}\n\nSELECTED SCENE SOURCE ALIAS:\n${input.sceneSource ? `${input.sceneSource.token}: exact selected scene source${input.references.some((reference) => reference.token === input.sceneSource?.token) ? " and connected provider input" : " (assistant context; describe it explicitly in the finished prompt)"}` : "None"}\n\nCONNECTED INPUTS:\n${input.references.length ? input.references.map((reference) => `${reference.token}: ${videoReferenceRoleNames[reference.role || ""] || reference.role || "visual reference"}`).join("\n") : "None"}` },
            ...referenceContent,
          ],
        },
      ],
    });
    if (!result) throw new Error("Gemini returned an empty video prompt");
    return finalizeVideoPrompt(result, input);
  }
  const referenceContent: Array<Record<string, unknown>> = [];
  for (const reference of input.references) {
    referenceContent.push(
      { type: "text", text: `REFERENCE ${reference.token} — ${reference.title}\nDECLARED PURPOSE: ${reference.purpose === "edit-source" ? "base image to edit" : reference.purpose === "identity" ? "named identity evidence" : reference.purpose === "canvas" ? "supporting image selected from the current canvas" : reference.purpose === "upload" ? "supporting external image uploaded for this edit" : reference.role || "supporting visual reference"}` },
      { type: "image_url", image_url: { url: await storageImageUrl(reference.path, reference.mimeType) } },
    );
  }
  const result = await requestOpenRouter({
    temperature: 0.35,
    max_tokens: 4096,
    messages: [
      {
        role: "system",
        content: imagePromptSystemInstruction(input),
      },
      {
        role: "user",
        content: [
          { type: "text", text: `USER BRIEF:\n${input.brief}\n\nBuild the structured generation prompt using only the references below. Keep each visible title paired with its exact @token in reference_plan.` },
          ...referenceContent,
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "reference_image_generation_prompt",
        strict: true,
        schema: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: 100 },
            task: { type: "string", maxLength: 420 },
            reference_plan: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  title: { type: "string" },
                  role: { type: "string" },
                  instruction: { type: "string" },
                },
                required: ["token", "title", "role", "instruction"],
                additionalProperties: false,
              },
            },
            subject: {
              type: "object",
              properties: {
                identity: { type: "string" },
                appearance: { type: "array", items: { type: "string" } },
                pose: { type: "string" },
                expression: { type: "string" },
              },
              required: ["identity", "appearance", "pose", "expression"],
              additionalProperties: false,
            },
            scene: {
              type: "object",
              properties: {
                environment: { type: "string" },
                composition: { type: "string" },
                lighting: { type: "string" },
                camera: { type: "string" },
              },
              required: ["environment", "composition", "lighting", "camera"],
              additionalProperties: false,
            },
            preserve: { type: "array", items: { type: "string" } },
            change: { type: "array", items: { type: "string" } },
            avoid: { type: "array", items: { type: "string" } },
            output: {
              type: "object",
              properties: { format: { type: "string" }, style: { type: "string" } },
              required: ["format", "style"],
              additionalProperties: false,
            },
          },
          required: ["title", "task", "reference_plan", "subject", "scene", "preserve", "change", "avoid", "output"],
          additionalProperties: false,
        },
      },
    },
  });
  return JSON.stringify(result, null, 2);
}
