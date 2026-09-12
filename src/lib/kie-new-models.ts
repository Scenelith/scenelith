import type { KieModel } from "./kie";

const imageRatios = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
const image1KRatios = [...imageRatios, "27:16", "16:27", "9:8", "8:9"];
const seconds = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => String(i + min));
const frames: NonNullable<KieModel["inputPorts"]> = [
  { id: "start-frame", label: "Start frame", kind: "image", max: 1 },
  { id: "end-frame", label: "End frame", kind: "image", max: 1 },
];
const jobPath = "/api/v1/jobs/createTask";

/** Contracts checked against docs.kie.ai on 2026-09-12. Optional provider ID,
 * document, web-link and effect-template workflows are not media input ports. */
export const newKieModels: KieModel[] = [
  ...["flare", "sunburst"].map((variant): KieModel => ({
    id: `gpt-image-2-5-${variant}`, label: `GPT Image 2.5 ${variant === "flare" ? "Flare" : "Sunburst"}`,
    mediaType: "image", description: "Image generation and editing · up to 16 images · 1K–4K",
    providerModel: `gpt-image-2-5-${variant}-text-to-image`, providerPath: jobPath,
    maxReferences: 16, maxPromptLength: 20_000, ratios: image1KRatios,
    ratiosByResolution: { "1K": image1KRatios, "2K": imageRatios, "4K": imageRatios },
    resolutions: ["1K", "2K", "4K"], defaultRatio: "auto", defaultResolution: "1K",
    inputPorts: [{ id: "reference-image", label: "Reference images", kind: "image", max: 16 }],
  })),
  ...[false, true].map((prime): KieModel => ({
    id: `wan-3${prime ? "-prime" : ""}`, label: `WAN 3.0${prime ? " Prime" : ""}`,
    mediaType: "video", description: "2–30s · start/end frames or image, video and audio references · input + output video up to 30s",
    providerModel: `wan/3-0-video${prime ? "-prime" : ""}`, providerPath: jobPath,
    maxReferences: 20, maxPromptLength: 20_000, ratios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["480P", "720P", "1080P"], durations: seconds(2, 30), defaultRatio: "adaptive",
    defaultResolution: "1080P", defaultDuration: "5", defaultGenerateAudio: true, supportsAudio: true,
    referenceMediaDuration: { minSeconds: 1, maxSeconds: 15, maxTotalSeconds: 15 },
    inputPorts: [...frames,
      { id: "reference-image", label: "Reference images", kind: "image", max: 10 },
      { id: "reference-video", label: "Reference videos · total ≤15s", kind: "video", max: 5 },
      { id: "reference-audio", label: "Audio references · total ≤15s", kind: "audio", max: 5 }],
  })),
  ...["text", "image", "transition", "extend", "reference"].map((mode): KieModel => ({
    id: `pixverse-v6-${mode}`, label: `PixVerse V6 · ${{ text: "Text", image: "Image", transition: "Transition", extend: "Extend", reference: "References" }[mode]}`,
    mediaType: "video", description: mode === "transition" ? "Animate between two required frames · 1–15s" : mode === "extend" ? "Continue an existing video · 1–15s extension" : mode === "reference" ? "Combine up to 7 image references · 1–15s" : mode === "image" ? "Animate 1–2 images · 1–15s · ratio follows input" : "Text-to-video · 1–15s · optional audio",
    providerModel: `pixverse-v6/${["text", "image", "reference"].includes(mode) ? `${mode}-to-video` : mode}`, providerPath: jobPath,
    maxReferences: mode === "text" ? 0 : mode === "reference" ? 7 : mode === "extend" ? 1 : 2,
    minPromptLength: 3, maxPromptLength: 5_000,
    ratios: ["text", "reference"].includes(mode) ? ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"] : ["auto"],
    ratioSource: ["text", "reference"].includes(mode) ? "select" : "reference",
    resolutions: ["360P", "540P", "720P", "1080P"], durations: seconds(1, 15),
    defaultRatio: ["text", "reference"].includes(mode) ? "16:9" : "auto", defaultResolution: "720P", defaultDuration: "5",
    defaultGenerateAudio: false, supportsAudio: true,
    inputPorts: mode === "text" ? [] : mode === "transition" ? frames.map((port) => ({ ...port, required: true }))
      : mode === "extend" ? [{ id: "reference-video", label: "Video to extend", kind: "video", required: true, max: 1 }]
        : [{ id: "reference-image", label: "Reference images", kind: "image", required: true, max: mode === "reference" ? 7 : 2 }],
  })),
  ...[false, true].map((flash): KieModel => ({
    id: flash ? "gemini-omni-flash-1-1" : "gemini-omni-video", label: flash ? "Gemini Omni 1.1 Flash" : "Gemini Omni",
    mediaType: "video", description: "Native audio · 4/6/8/10s · up to 7 images or 5 images + one ≤10s video · with video, output length is automatic",
    providerModel: flash ? "google/gemini-omni-flash-1-1" : "gemini-omni-video", providerPath: jobPath,
    maxReferences: 7, maxPromptLength: 20_000, ratios: ["16:9", "9:16"],
    resolutions: flash ? ["360P", "720P", "1080P", "4K"] : ["720P", "1080P", "4K"],
    durations: ["4", "6", "8", "10"], defaultRatio: "16:9", defaultResolution: "720P", defaultDuration: "8",
    defaultGenerateAudio: true, durationSourceWithVideo: "model",
    inputPorts: [...(flash ? frames : []),
      { id: "reference-image", label: "Images · max 5 with video", kind: "image", max: 7 },
      { id: "reference-video", label: "Reference clip · ≤10s", kind: "video", max: 1 }],
  })),
];

export type ModelReference = { label?: string; role?: string; mimeType?: string; durationSeconds?: number; sizeBytes?: number; width?: number; height?: number; hasAlpha?: boolean };
type NewModelInput = { prompt: string; references: ModelReference[]; aspectRatio?: string; resolution?: string; duration?: string };
export const newKieModel = (id: string) => newKieModels.find((model) => model.id === id);
export const modelChoosesDuration = (model: { durationSourceWithVideo?: "model" } | undefined, hasVideo: boolean) => model?.durationSourceWithVideo === "model" && hasVideo;

export function newKieRoleError(id: string, refs: ModelReference[]) {
  const model = newKieModel(id);
  if (!model) return null;
  const unsupported = refs.find((ref) => !model.inputPorts?.some((port) => port.id === (ref.role || "reference-image")));
  return unsupported ? `${model.label}: unsupported input ${unsupported.role || "reference-image"}; disconnect it or select a compatible model` : null;
}

/** Return a user-facing error before reserving usage or uploading media. Never
 * reinterpret an explicit input role to make an incompatible request fit. */
export function newKieInputError(id: string, input: NewModelInput): string | null {
  const model = newKieModel(id);
  if (!model) return null;
  const refs = input.references;
  const named = (role: string) => refs.filter((ref) => (ref.role || "reference-image") === role);
  const has = (role: string) => named(role).length > 0;
  const fail = (message: string) => `${model.label}: ${message}`;
  if (input.prompt.trim().length < (model.minPromptLength || 1)) return fail(`prompt must contain at least ${model.minPromptLength || 1} characters`);
  if (input.prompt.length > (model.maxPromptLength || 5000)) return fail(`prompt exceeds ${model.maxPromptLength} characters`);
  if (refs.length > model.maxReferences) return fail(`at most ${model.maxReferences} inputs are supported`);
  for (const ref of refs) {
    const port = model.inputPorts?.find((port) => port.id === (ref.role || "reference-image"));
    if (!port) return fail(`unsupported input ${ref.role || "reference-image"}; disconnect it or select a compatible model`);
    if (ref.mimeType && !ref.mimeType.startsWith(`${port.kind}/`)) return fail(`${port.label} requires ${port.kind} media`);
    const sizeLimit = id.startsWith("gpt-image-2-5") ? 30 : port.kind === "video" ? (id === "pixverse-v6-extend" ? Infinity : 100) : port.kind === "audio" ? 15 : 20;
    if (ref.sizeBytes && ref.sizeBytes > sizeLimit * 1024 * 1024) return fail(`${port.label} must be at most ${sizeLimit} MB per file`);
    if (id.startsWith("wan-3") && ref.mimeType) {
      const formats = port.kind === "video" ? ["video/mp4", "video/quicktime"] : port.kind === "audio" ? ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"] : ["image/jpeg", "image/png", "image/webp", "image/bmp", "image/x-ms-bmp"];
      if (!formats.includes(ref.mimeType.toLowerCase())) return fail(`${port.label} has an unsupported file format`);
      if (port.kind === "image" && ref.hasAlpha) return fail("WAN images must not contain transparency; use an opaque image");
      if (ref.width && ref.height && port.kind !== "audio") {
        const sides = [ref.width, ref.height];
        if (Math.min(...sides) < 240 || Math.max(...sides) > (port.kind === "video" ? 4096 : 8000) || Math.max(...sides) / Math.min(...sides) > 8) return fail(`${port.label} dimensions are outside the supported range`);
      }
    } else if (ref.mimeType?.startsWith("image/") && !["image/jpeg", "image/png", "image/webp"].includes(ref.mimeType.toLowerCase())) return fail("images must be JPEG, PNG or WebP");
  }
  for (const port of model.inputPorts || []) {
    if (port.required && !has(port.id)) return fail(`connect ${port.label} before generating`);
    if (port.max && named(port.id).length > port.max) return fail(`${port.label} accepts at most ${port.max} inputs`);
  }
  if (has("end-frame") && !has("start-frame")) return fail("connect a start frame before an end frame");
  if ((id.startsWith("wan-3") || id === "gemini-omni-flash-1-1") && (has("start-frame") || has("end-frame")) && ["reference-image", "reference-video", "reference-audio"].some(has)) return fail("use start/end frames or reference media in one request; these modes cannot be combined");
  const resolution = (input.resolution || model.defaultResolution!).toUpperCase();
  if (!model.resolutions.includes(resolution)) return fail(`unsupported resolution ${resolution}`);
  const ratios = model.ratiosByResolution?.[resolution] || model.ratios;
  if (model.ratioSource !== "reference" && !ratios.includes(input.aspectRatio || model.defaultRatio!)) return fail(`unsupported aspect ratio at ${resolution}`);
  if (model.durations && !model.durations.includes(input.duration || model.defaultDuration!)) return fail(`duration must be one of ${model.durations.join(", ")} seconds`);
  if (id.startsWith("wan-3")) {
    if (has("reference-audio") && !has("reference-image") && !has("reference-video")) return fail("connect an image or video together with an audio reference");
    for (const role of ["reference-video", "reference-audio"]) {
      const timed = named(role);
      if (timed.some((ref) => !Number.isFinite(ref.durationSeconds) || ref.durationSeconds! < 1 || ref.durationSeconds! > 15)) return fail(`each ${role} needs a measured duration of 1–15s`);
      if (timed.reduce((sum, ref) => sum + ref.durationSeconds!, 0) > 15) return fail(`${role} inputs may total at most 15s`);
    }
    if (named("reference-video").reduce((sum, ref) => sum + ref.durationSeconds!, 0) + Number(input.duration || model.defaultDuration) > 30) return fail("input video duration plus output duration must not exceed 30s");
  }
  if (id.startsWith("gemini-omni")) {
    if (named("reference-image").length + named("reference-video").length * 2 > 7) return fail("a video uses two image slots; use at most 5 images with a video");
    if (named("reference-video").some((ref) => !Number.isFinite(ref.durationSeconds) || ref.durationSeconds! <= 0 || ref.durationSeconds! > 10)) return fail("select a reference clip of at most 10s with a measured duration before generating");
  }
  return null;
}

export type NewUploadedReference = ModelReference & { assetUrl: string; label: string };
/** Names are unique and stable for the order submitted, even with duplicate or
 * non-ASCII canvas labels. The prompt maps the user's labels to these names. */
export function newKieReferenceNames(id: string, refs: ModelReference[]) {
  const counts: Record<string, number> = {};
  return refs.map((ref, index) => {
    if (id === "pixverse-v6-reference") return `@image${index + 1}`;
    if (id.startsWith("wan-3")) {
      const kind = ref.role === "reference-video" ? "Video" : ref.role === "reference-audio" ? "Audio" : "Image";
      counts[kind] = (counts[kind] || 0) + 1;
      return `${kind}${counts[kind]}`;
    }
    return String(index + 1);
  });
}

export function newKiePrompt(id: string, prompt: string, refs: ModelReference[]) {
  return refs.length ? `REFERENCE_MAP (exact bindings):\n${newKieReferenceNames(id, refs).map((name, i) => `${name}: ${refs[i].label || `Reference ${i + 1}`}`).join("\n")}\nUSER_REQUEST:\n${prompt.trim()}` : prompt.trim();
}

export function newKiePayload(id: string, input: Omit<NewModelInput, "references"> & { generateAudio?: boolean }, refs: NewUploadedReference[]): Record<string, unknown> | null {
  const model = newKieModel(id);
  if (!model) return null;
  const error = newKieInputError(id, { ...input, references: refs });
  if (error) throw new Error(error);
  const urls = (role: string) => refs.filter((ref) => (ref.role || "reference-image") === role).map((ref) => ref.assetUrl);
  const prompt = input.prompt;
  const ratio = input.aspectRatio || model.defaultRatio;
  const resolution = (input.resolution || model.defaultResolution!).toUpperCase();
  const duration = Number(input.duration || model.defaultDuration);
  if (id.startsWith("gpt-image-2-5")) return { prompt, ...(refs.length ? { input_urls: refs.map((ref) => ref.assetUrl) } : {}), aspect_ratio: ratio, resolution };
  if (id.startsWith("wan-3")) return { prompt, ...(urls("start-frame").length ? { first_frame_url: urls("start-frame")[0] } : {}), ...(urls("end-frame").length ? { last_frame_url: urls("end-frame")[0] } : {}), ...(urls("reference-image").length ? { reference_image_urls: urls("reference-image") } : {}), ...(urls("reference-video").length ? { reference_video_urls: urls("reference-video") } : {}), ...(urls("reference-audio").length ? { reference_audio_urls: urls("reference-audio") } : {}), resolution, aspect_ratio: ratio, duration, audio: input.generateAudio ?? true };
  if (id.startsWith("pixverse-v6")) return { prompt, duration, quality: resolution.toLowerCase(), generate_audio_switch: input.generateAudio ?? false,
    ...(model.ratioSource !== "reference" ? { aspect_ratio: ratio } : {}),
    ...(id === "pixverse-v6-image" ? { image_urls: urls("reference-image") } : {}),
    ...(id === "pixverse-v6-transition" ? { first_frame_image_url: urls("start-frame")[0], last_frame_image_url: urls("end-frame")[0] } : {}),
    ...(id === "pixverse-v6-extend" ? { video_url: urls("reference-video")[0] } : {}),
    ...(id === "pixverse-v6-reference" ? { image_references: refs.map((ref, i) => ({ image_url: ref.assetUrl, ref_name: `image${i + 1}`, type: "subject" })) } : {}),
  };
  return { prompt, duration: String(duration), resolution: resolution.toLowerCase(), aspect_ratio: ratio,
    ...(urls("start-frame").length ? { first_frame_url: urls("start-frame")[0] } : {}),
    ...(urls("end-frame").length ? { last_frame_url: urls("end-frame")[0] } : {}),
    ...(urls("reference-image").length ? { image_urls: urls("reference-image") } : {}),
    ...(urls("reference-video").length ? { video_list: refs.filter((ref) => ref.role === "reference-video").map((ref) => ({ url: ref.assetUrl, start: 0, ends: ref.durationSeconds })) } : {}),
  };
}
