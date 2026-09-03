export type GenerationPromptSystemReference = {
  role?: string;
};

export type GenerationPromptSystemContext = {
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
  references: GenerationPromptSystemReference[];
  sceneSource?: { token: string };
  videoMasterContext?: {
    clipTitle: string;
    timelineDurationSeconds: number;
    generationDurationSeconds?: number;
    sourceKind: "source-segment" | "uploaded-clip" | "new-scene";
    sourceAspectRatio: string;
    outputAspectRatio: string;
    outputRatioChanged: boolean;
  };
};

export function imagePromptSystemInstruction(input: Pick<GenerationPromptSystemContext, "editMode" | "modelId" | "modelLabel" | "aspectRatio" | "resolution" | "sourceAspectRatio" | "sourceDimensions" | "outputSizeChanged"> = {}) {
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

export const videoReferenceRoleNames: Record<string, string> = {
  "start-frame": "start image",
  "end-frame": "end image",
  "reference-image": "visual reference",
  "reference-video": "reference video",
  "motion-video": "reference motion video",
  "reference-audio": "reference audio",
};

export function videoPromptSystemInstruction(input: Pick<GenerationPromptSystemContext, "modelId" | "modelLabel" | "duration" | "generateAudio" | "references" | "sceneSource" | "videoMasterContext">) {
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
    ? "This is Kling Motion Control. The start image defines the subject's appearance. The reference video defines pose, body movement, timing and motion trajectory, including framing and camera movement. Write a short replacement instruction: identify exactly which connected image supplies the replacement subject and which reference video supplies motion. Do not restate or redesign the reference video's shot, invent a competing camera path, or add timecodes. Do not request a duration; duration is inherited from the reference video."
    : isSeedance25 && master
      ? `This is Seedance 2.5 multimodal generation for one selected Video Master scene. Produce a model-ready prompt with compact uppercase sections when useful (REFERENCE ROLES, LOOK, and TIMELINE). Use timestamped beats from 00:00.000 through the exact generated duration. Every timestamp must use MM:SS.mmm syntax (for example, four seconds is 00:04.000, never 04:00). When generation is longer than the kept timeline, no required-action beat may cross the kept boundary: end it at or before that boundary, then create a separate tail beat containing only settled natural continuation. Never copy internal storyboard labels such as CHRONOLOGICAL STORYBOARD FOR into the final prompt. Do not write a multi-scene commercial unless the user asks for one; this prompt controls only ${master.clipTitle}. Bind every @token to one explicit responsibility and preserve identity continuity across the whole clip.`
      : isSeedance
        ? "This is Seedance 2 multimodal video generation. Bind every mentioned @token to its declared role. When start and end images are present, describe one physically continuous transition between them. Reference video supplies motion language; reference audio supplies rhythm, ambience or speech timing."
        : "Follow the selected model's connected inputs exactly. A start image defines the initial visual state; an end image defines the final state; a reference video supplies motion or timing.";
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

export function generationPromptSystemInstruction(input: GenerationPromptSystemContext & { systemPrompt?: string }) {
  const requiredPrompt = input.mediaType === "video"
    ? videoPromptSystemInstruction(input)
    : imagePromptSystemInstruction(input);
  const customPrompt = input.systemPrompt?.trim();
  if (!customPrompt) return requiredPrompt;
  return `${requiredPrompt}

CUSTOM SYSTEM INSTRUCTIONS:
The user saved the instructions below for this canvas node. Apply them as an additional creative and formatting layer. They may refine the result, but they must not remove, contradict, or weaken the required reference, model, safety, duration, or output-format contracts above.

${customPrompt}`;
}
