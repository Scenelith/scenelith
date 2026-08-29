import { createHmac, timingSafeEqual } from "node:crypto";
import { requireInstanceSecret } from "@/platform/secrets";
import { readStorageObject } from "./storage";
import { acquireKieGenerationPermit } from "./kie-rate-limit";

const apiBase = "https://api.kie.ai";
const uploadApiBase = "https://kieai.redpandaai.co";

export type KieModel = {
  id: string;
  label: string;
  mediaType: "image" | "video";
  description: string;
  providerModel: string;
  providerPath: string;
  providerStatusPath?: string;
  maxReferences: number;
  ratios: string[];
  ratiosByResolution?: Record<string, string[]>;
  referenceRatiosByResolution?: Record<string, string[]>;
  referenceOnlyRatios?: string[];
  resolutions: string[];
  videoInputOnlyResolutions?: string[];
  durations?: string[];
  defaultRatio?: string;
  defaultResolution?: string;
  defaultDuration?: string;
  defaultGenerateAudio?: boolean;
  durationSource?: "select" | "reference-video";
  maxPromptLength?: number;
  referenceMediaDuration?: { minSeconds: number; maxSeconds: number; maxTotalSeconds: number };
  inputPorts?: Array<{ id: string; label: string; kind: "image" | "video" | "audio"; required?: boolean; max?: number }>;
  supportsAudio?: boolean;
};

const nanoBanana2LiteRatios = ["auto", "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const nanoBanana2Ratios = ["auto", "1:1", "2:3", "3:2", "1:4", "4:1", "3:4", "4:3", "4:5", "5:4", "1:8", "8:1", "9:16", "16:9", "21:9"];
const nanoBanana2HighResolutionRatios = nanoBanana2Ratios.filter((ratio) => !["1:4", "4:1", "1:8", "8:1"].includes(ratio));
const nanoBananaProRatios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"];
const gptImage2Ratios = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"];
const gptImage2Text2K = gptImage2Ratios.filter((ratio) => !["auto", "5:4", "4:5", "3:1", "1:3", "9:21"].includes(ratio));
const gptImage2Text4K = gptImage2Text2K.filter((ratio) => ratio !== "1:1");
const gptImage2Reference2K = gptImage2Ratios.filter((ratio) => !["auto", "5:4", "4:5"].includes(ratio));
const gptImage2Reference4K = gptImage2Reference2K.filter((ratio) => ratio !== "1:1");
const seedreamRatios = ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"];
const flux2Ratios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "auto"];
const imagen4Ratios = ["1:1", "16:9", "9:16", "3:4", "4:3", "auto"];
const grokImage2Ratios = ["1:1", "2:3", "3:2", "16:9", "9:16"];
const videoRatios = ["16:9", "9:16", "1:1"];
const seedanceRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"];
const integerSeconds = (minimum: number, maximum: number) => Array.from({ length: maximum - minimum + 1 }, (_, index) => String(index + minimum));
const seedancePorts: NonNullable<KieModel["inputPorts"]> = [
  { id: "start-frame", label: "Start image", kind: "image", max: 1 },
  { id: "end-frame", label: "End image", kind: "image", max: 1 },
  { id: "reference-video", label: "Reference video", kind: "video", max: 3 },
  { id: "reference-audio", label: "Audio input", kind: "audio", max: 3 },
  { id: "reference-image", label: "Reference images", kind: "image", max: 9 },
];
const seedance25Ports: NonNullable<KieModel["inputPorts"]> = [
  { id: "start-frame", label: "Start image", kind: "image", max: 1 },
  { id: "end-frame", label: "End image", kind: "image", max: 1 },
  { id: "reference-video", label: "Reference videos", kind: "video", max: 10 },
  { id: "reference-audio", label: "Audio inputs", kind: "audio", max: 10 },
  { id: "reference-image", label: "Reference images", kind: "image", max: 30 },
];

/**
 * Public generation catalogue. These IDs are owned by Scenelith; providerModel
 * is the exact Kie model identifier documented for createTask. Keeping both
 * lets us replace an upstream variant without corrupting saved canvas nodes.
 */
export const kieModels: KieModel[] = [
  { id: "nano-banana-2-lite", label: "Nano Banana 2 Lite", mediaType: "image", description: "Fast Google generation and editing · up to 10 references · 1K", providerModel: "nano-banana-2-lite", providerPath: "/api/v1/jobs/createTask", maxReferences: 10, maxPromptLength: 20_000, ratios: nanoBanana2LiteRatios, resolutions: ["1K"], defaultRatio: "auto", defaultResolution: "1K" },
  { id: "nano-banana-2", label: "Nano Banana 2", mediaType: "image", description: "Google Gemini 3.1 Flash Image · up to 14 references · 1K–4K", providerModel: "nano-banana-2", providerPath: "/api/v1/jobs/createTask", maxReferences: 14, maxPromptLength: 20_000, ratios: nanoBanana2Ratios, ratiosByResolution: { "1K": nanoBanana2Ratios, "2K": nanoBanana2HighResolutionRatios, "4K": nanoBanana2HighResolutionRatios }, resolutions: ["1K", "2K", "4K"], defaultRatio: "auto", defaultResolution: "1K" },
  { id: "nano-banana-pro", label: "Nano Banana Pro", mediaType: "image", description: "Google premium image generation · up to 8 references · 1K–4K", providerModel: "nano-banana-pro", providerPath: "/api/v1/jobs/createTask", maxReferences: 8, maxPromptLength: 10_000, ratios: nanoBananaProRatios, resolutions: ["1K", "2K", "4K"], defaultRatio: "1:1", defaultResolution: "1K" },
  { id: "gpt-image-2", label: "GPT Image 2", mediaType: "image", description: "Photorealistic generation and editing · up to 16 references · 1K–4K", providerModel: "gpt-image-2", providerPath: "/api/v1/jobs/createTask", maxReferences: 16, maxPromptLength: 20_000, ratios: gptImage2Ratios, ratiosByResolution: { "1K": gptImage2Ratios, "2K": gptImage2Text2K, "4K": gptImage2Text4K }, referenceRatiosByResolution: { "1K": gptImage2Ratios, "2K": gptImage2Reference2K, "4K": gptImage2Reference4K }, resolutions: ["1K", "2K", "4K"], defaultRatio: "auto", defaultResolution: "1K" },
  { id: "grok-image-2", label: "Grok Imagine Image 2.0", mediaType: "image", description: "Fast image generation and editing · one image reference", providerModel: "grok-imagine-image-2-0/text-to-image", providerPath: "/api/v1/jobs/createTask", maxReferences: 1, ratios: grokImage2Ratios, resolutions: ["1K"], defaultRatio: "1:1", defaultResolution: "1K", inputPorts: [{ id: "reference-image", label: "Image reference", kind: "image", max: 1 }] },
  { id: "seedream-5-pro", label: "Seedream 5 Pro", mediaType: "image", description: "High-fidelity generation and editing · up to 10 references · 1K–2K", providerModel: "seedream/5-pro", providerPath: "/api/v1/jobs/createTask", maxReferences: 10, ratios: seedreamRatios, resolutions: ["1K", "2K"], defaultRatio: "1:1", defaultResolution: "1K" },
  { id: "seedream-5-lite", label: "Seedream 5 Lite", mediaType: "image", description: "Fast photorealistic generation · up to 14 references · 2K–4K", providerModel: "seedream/5-lite", providerPath: "/api/v1/jobs/createTask", maxReferences: 14, maxPromptLength: 3_000, ratios: seedreamRatios, resolutions: ["2K", "3K", "4K"], defaultRatio: "1:1", defaultResolution: "2K" },
  { id: "flux-2-flex", label: "FLUX.2 Flex", mediaType: "image", description: "Flexible generation and editing · up to 8 references · 1K–2K", providerModel: "flux-2/flex", providerPath: "/api/v1/jobs/createTask", maxReferences: 8, ratios: flux2Ratios, referenceOnlyRatios: ["auto"], resolutions: ["1K", "2K"], defaultRatio: "1:1", defaultResolution: "1K" },
  { id: "imagen4-fast", label: "Imagen 4 Fast", mediaType: "image", description: "Google Imagen · fast text-to-image iteration", providerModel: "google/imagen4-fast", providerPath: "/api/v1/jobs/createTask", maxReferences: 0, ratios: imagen4Ratios, resolutions: ["1K"], defaultRatio: "16:9", defaultResolution: "1K" },
  { id: "imagen4-ultra", label: "Imagen 4 Ultra", mediaType: "image", description: "Google Imagen · maximum text-to-image quality", providerModel: "google/imagen4-ultra", providerPath: "/api/v1/jobs/createTask", maxReferences: 0, ratios: imagen4Ratios, resolutions: ["1K"], defaultRatio: "1:1", defaultResolution: "1K" },
  { id: "seedance-2-fast", label: "Seedance 2 Fast", mediaType: "video", description: "Fast multimodal video · 4–15s · frames, image, video and audio references", providerModel: "bytedance/seedance-2-fast", providerPath: "/api/v1/jobs/createTask", maxReferences: 15, maxPromptLength: 20_000, ratios: seedanceRatios, resolutions: ["480P", "720P"], durations: integerSeconds(4, 15), defaultRatio: "16:9", defaultResolution: "720P", defaultDuration: "5", defaultGenerateAudio: true, inputPorts: seedancePorts, supportsAudio: true },
  { id: "seedance-2-mini", label: "Seedance 2 Mini", mediaType: "video", description: "Efficient multimodal video · 4–15s · frames and reference media", providerModel: "bytedance/seedance-2-mini", providerPath: "/api/v1/jobs/createTask", maxReferences: 15, maxPromptLength: 20_000, ratios: seedanceRatios, resolutions: ["480P", "720P"], durations: integerSeconds(4, 15), defaultRatio: "16:9", defaultResolution: "720P", defaultDuration: "5", defaultGenerateAudio: true, inputPorts: seedancePorts, supportsAudio: true },
  { id: "seedance-2", label: "Seedance 2", mediaType: "video", description: "Cinematic multimodal video · 4–15s · up to 4K", providerModel: "bytedance/seedance-2", providerPath: "/api/v1/jobs/createTask", maxReferences: 15, maxPromptLength: 20_000, ratios: seedanceRatios, resolutions: ["480P", "720P", "1080P", "4K"], durations: integerSeconds(4, 15), defaultRatio: "16:9", defaultResolution: "720P", defaultDuration: "5", defaultGenerateAudio: true, inputPorts: seedancePorts, supportsAudio: true },
  { id: "seedance-2-5", label: "Seedance 2.5", mediaType: "video", description: "Latest multimodal video · 4–30s · up to 1080p with video input", providerModel: "bytedance/seedance-2-5", providerPath: "/api/v1/jobs/createTask", maxReferences: 50, ratios: seedanceRatios, resolutions: ["480P", "720P", "1080P"], videoInputOnlyResolutions: ["1080P"], durations: integerSeconds(4, 30), defaultRatio: "adaptive", defaultResolution: "720P", defaultDuration: "5", defaultGenerateAudio: true, maxPromptLength: 30_000, referenceMediaDuration: { minSeconds: 2, maxSeconds: 30, maxTotalSeconds: 30 }, inputPorts: seedance25Ports, supportsAudio: true },
  { id: "kling-3", label: "Kling 3.0", mediaType: "video", description: "Regular Kling · 3–15s · 720p, 1080p or 4K", providerModel: "kling-3.0/video", providerPath: "/api/v1/jobs/createTask", maxReferences: 2, ratios: videoRatios, resolutions: ["720P", "1080P", "4K"], durations: integerSeconds(3, 15), defaultRatio: "16:9", defaultResolution: "1080P", defaultDuration: "5", defaultGenerateAudio: false, inputPorts: [{ id: "start-frame", label: "Start frame", kind: "image", max: 1 }, { id: "end-frame", label: "End frame", kind: "image", max: 1 }], supportsAudio: true },
  { id: "kling-3-turbo-text", label: "Kling 3.0 Turbo · Text", mediaType: "video", description: "Fast text-to-video · 3–15s · 720p or 1080p", providerModel: "kling/v3-turbo-text-to-video", providerPath: "/api/v1/jobs/createTask", maxReferences: 0, maxPromptLength: 2_500, ratios: videoRatios, resolutions: ["720P", "1080P"], durations: integerSeconds(3, 15), defaultRatio: "16:9", defaultResolution: "720P", defaultDuration: "5" },
  { id: "kling-3-turbo-image", label: "Kling 3.0 Turbo · Image", mediaType: "video", description: "Fast image-to-video · 3–15s · 720p or 1080p", providerModel: "kling/v3-turbo-image-to-video", providerPath: "/api/v1/jobs/createTask", maxReferences: 1, maxPromptLength: 2_500, ratios: videoRatios, resolutions: ["720P", "1080P"], durations: integerSeconds(3, 15), defaultRatio: "16:9", defaultResolution: "720P", defaultDuration: "5", inputPorts: [{ id: "start-frame", label: "Start image", kind: "image", required: true, max: 1 }] },
  { id: "kling-3-motion", label: "Kling 3.0 Motion Control", mediaType: "video", description: "Transfer movement from a 3–30s reference video to a start image", providerModel: "kling-3.0/motion-control", providerPath: "/api/v1/jobs/createTask", maxReferences: 2, maxPromptLength: 2_500, ratios: videoRatios, resolutions: ["720P", "1080P"], durationSource: "reference-video", inputPorts: [{ id: "start-frame", label: "Start image", kind: "image", required: true, max: 1 }, { id: "reference-video", label: "Reference video", kind: "video", required: true, max: 1 }] },
  { id: "grok-video-text", label: "Grok Imagine · Text", mediaType: "video", description: "Text-to-video · 6–30s · up to 1080p", providerModel: "grok-imagine/text-to-video", providerPath: "/api/v1/jobs/createTask", maxReferences: 0, ratios: ["2:3", "3:2", "1:1", "16:9", "9:16"], resolutions: ["480P", "720P", "1080P"], durations: integerSeconds(6, 30), defaultRatio: "2:3", defaultResolution: "480P", defaultDuration: "6" },
  { id: "grok-video-image", label: "Grok Imagine · Image", mediaType: "video", description: "Image-to-video · 6–30s · up to 7 images", providerModel: "grok-imagine/image-to-video", providerPath: "/api/v1/jobs/createTask", maxReferences: 7, ratios: ["16:9", "9:16", "1:1", "2:3", "3:2"], resolutions: ["480P", "720P", "1080P"], durations: integerSeconds(6, 30), defaultRatio: "16:9", defaultResolution: "480P", defaultDuration: "6", inputPorts: [{ id: "reference-image", label: "Reference images", kind: "image", required: true, max: 7 }] },
  { id: "grok-video-1-5", label: "Grok Imagine Video 1.5 Preview", mediaType: "video", description: "Text or image-to-video · 1–15s · 480p or 720p · up to 7 images", providerModel: "grok-imagine-video-1-5-preview", providerPath: "/api/v1/jobs/createTask", maxReferences: 7, maxPromptLength: 4_096, ratios: ["auto", "16:9", "9:16", "1:1", "3:2", "2:3"], resolutions: ["480P", "720P"], durations: integerSeconds(1, 15), defaultRatio: "auto", defaultResolution: "480P", defaultDuration: "8", inputPorts: [{ id: "reference-image", label: "Reference images", kind: "image", max: 7 }] },
  { id: "wan-2-7", label: "WAN 2.7", mediaType: "video", description: "Text, first/last-frame or continuation video · 2–15s", providerModel: "wan/2-7", providerPath: "/api/v1/jobs/createTask", maxReferences: 4, ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"], resolutions: ["720P", "1080P"], durations: integerSeconds(2, 15), defaultRatio: "16:9", defaultResolution: "1080P", defaultDuration: "5", inputPorts: [{ id: "start-frame", label: "Start frame", kind: "image", max: 1 }, { id: "end-frame", label: "End frame", kind: "image", max: 1 }, { id: "reference-video", label: "Continuation clip", kind: "video", max: 1 }, { id: "reference-audio", label: "Audio input", kind: "audio", max: 1 }] },
  { id: "veo-3-1-fast", label: "Veo 3.1 Fast", mediaType: "video", description: "Google video with native audio · 4, 6 or 8s · frames or material references", providerModel: "veo3_fast", providerPath: "/api/v1/veo/generate", providerStatusPath: "/api/v1/veo/record-info", maxReferences: 3, ratios: ["16:9", "9:16", "auto"], resolutions: ["720P", "1080P", "4K"], durations: ["4", "6", "8"], defaultRatio: "16:9", defaultResolution: "720P", defaultDuration: "8", defaultGenerateAudio: true, inputPorts: [{ id: "start-frame", label: "Start frame", kind: "image", max: 1 }, { id: "end-frame", label: "End frame", kind: "image", max: 1 }, { id: "reference-image", label: "Material references", kind: "image", max: 3 }], supportsAudio: true },
  { id: "veo-3-1", label: "Veo 3.1 Quality", mediaType: "video", description: "Google flagship video with native audio · 4, 6 or 8s · text or first/last frames", providerModel: "veo3", providerPath: "/api/v1/veo/generate", providerStatusPath: "/api/v1/veo/record-info", maxReferences: 2, ratios: ["16:9", "9:16", "auto"], resolutions: ["720P", "1080P", "4K"], durations: ["4", "6", "8"], defaultRatio: "16:9", defaultResolution: "720P", defaultDuration: "8", defaultGenerateAudio: true, inputPorts: [{ id: "start-frame", label: "Start frame", kind: "image", max: 1 }, { id: "end-frame", label: "End frame", kind: "image", max: 1 }], supportsAudio: true },
];

const legacyModelAliases: Record<string, string> = {
  "nano-banana-pro-flash": "nano-banana-2",
  "flux-kontext-pro": "flux-2-flex",
  "flux-2-turbo": "flux-2-flex",
  "flux-2-klein": "flux-2-flex",
  "seedream-v4": "seedream-5-lite",
  "flux-2-pro": "flux-2-flex",
  "mystic-realism": "flux-2-flex",
  "wan-2-5-t2v-720p": "wan-2-7",
  "wan-2-5-i2v-1080p": "wan-2-7",
  "wan-2-7-i2v": "wan-2-7",
  "runway-4-5-i2v": "seedance-2-fast",
  "kling-v3-pro": "kling-3",
  "kling-v3-std": "kling-3",
};

export function canonicalKieModelId(id: string) {
  return legacyModelAliases[id] || id;
}

export function getKieModel(id: string) {
  const model = kieModels.find((item) => item.id === canonicalKieModelId(id));
  if (!model) throw new Error("Unknown Kie.ai model");
  return model;
}

export function allowedKieRatios(model: KieModel, resolution: string, hasReferences: boolean) {
  const resolutionMap = hasReferences && model.referenceRatiosByResolution
    ? model.referenceRatiosByResolution
    : model.ratiosByResolution;
  const byResolution = resolutionMap?.[resolution.toUpperCase()] || model.ratios;
  return hasReferences || !model.referenceOnlyRatios?.length
    ? byResolution
    : byResolution.filter((ratio) => !model.referenceOnlyRatios?.includes(ratio));
}

export function allowedKieResolutions(model: KieModel, hasVideoInput: boolean) {
  if (hasVideoInput || !model.videoInputOnlyResolutions?.length) return model.resolutions;
  const videoOnly = new Set(model.videoInputOnlyResolutions.map((resolution) => resolution.toUpperCase()));
  return model.resolutions.filter((resolution) => !videoOnly.has(resolution.toUpperCase()));
}

function apiKey() {
  return requireInstanceSecret("KIE_API_KEY");
}

export class KieRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs = 2_000) {
    super(message);
    this.name = "KieRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1_000) : 2_000;
}

async function kieFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  const parsedCode = Number(data.code ?? response.status);
  const code = Number.isFinite(parsedCode) ? parsedCode : response.status;
  if (response.status === 429 || code === 429) {
    throw new KieRateLimitError("Kie.ai generation capacity is temporarily busy", retryAfterMs(response));
  }
  if (!response.ok || code !== 200) {
    throw new Error(String(data.msg || data.message || data.error || `Kie.ai returned ${response.status}`));
  }
  return data;
}

export type KieTask = {
  task_id?: string;
  status?: string;
  generated?: string[];
  error?: unknown;
};

function parseJson(value: unknown) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** Normalizes unified Market polling/callbacks and the older Veo response. */
export function normalizeKieTask(value: unknown): KieTask {
  const envelope = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : envelope;
  const result = parseJson(data.resultJson);
  const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const response = data.response && typeof data.response === "object" ? data.response as Record<string, unknown> : {};
  const info = data.info && typeof data.info === "object" ? data.info as Record<string, unknown> : {};
  const urls = [
    ...stringArray(resultRecord.resultUrls),
    ...stringArray(data.resultUrls),
    ...stringArray(response.resultUrls),
    ...stringArray(info.resultUrls),
    ...stringArray(data.generated),
  ];
  const fallback = data.video_url || data.image_url || data.output_url || data.url;
  if (!urls.length && typeof fallback === "string" && fallback) urls.push(fallback);
  const successFlag = typeof data.successFlag === "number" ? data.successFlag : null;
  const responseCode = typeof envelope.code === "number" ? envelope.code : 200;
  const state = String(data.state || data.status || (successFlag === 1 ? "success" : successFlag === 2 || successFlag === 3 || responseCode >= 400 ? "fail" : "generating")).toLowerCase();
  const failure = state === "fail" || state === "failed" || successFlag === 2 || successFlag === 3 || responseCode >= 400;
  const errorMessage = data.failMsg || data.errorMessage || data.error || envelope.msg;
  return {
    task_id: String(data.taskId || data.task_id || envelope.taskId || "") || undefined,
    status: state,
    generated: urls,
    error: failure ? errorMessage || data.failCode || data.errorCode || "Kie.ai generation failed" : undefined,
  };
}

type CachedKieUpload = { expiresAt: number; promise: Promise<string> };
const kieReferenceUploads = new Map<string, CachedKieUpload>();
const KIE_REFERENCE_CACHE_MS = 30 * 60 * 1000;
const MAX_CACHED_KIE_REFERENCES = 256;

function pruneKieReferenceUploads(now: number) {
  for (const [key, entry] of kieReferenceUploads) {
    if (entry.expiresAt <= now) kieReferenceUploads.delete(key);
  }
  while (kieReferenceUploads.size >= MAX_CACHED_KIE_REFERENCES) {
    const oldest = kieReferenceUploads.keys().next().value as string | undefined;
    if (!oldest) break;
    kieReferenceUploads.delete(oldest);
  }
}

async function uploadKieReferenceFile(path: string, mimeType: string) {
  const bytes = await readStorageObject(path);
  const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "bin";
  const filename = `${crypto.randomUUID()}.${extension}`;
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  form.append("uploadPath", "scenelith/references");
  form.append("fileName", filename);
  const response = await fetch(`${uploadApiBase}/api/file-stream-upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  const body = await response.json().catch(() => ({})) as { code?: number | string; msg?: string; data?: { downloadUrl?: string; fileUrl?: string } };
  const bodyCode = Number(body.code ?? response.status);
  const url = body.data?.downloadUrl || body.data?.fileUrl;
  if (response.status === 429 || bodyCode === 429) throw new KieRateLimitError("Kie.ai upload capacity is temporarily busy", retryAfterMs(response));
  if (!response.ok || bodyCode !== 200 || !url) throw new Error(body.msg || `Kie.ai reference upload failed (${response.status})`);
  return url;
}

export async function uploadKieReference(path: string, mimeType: string, label = "reference") {
  const now = Date.now();
  const cacheKey = `${path}\0${mimeType}`;
  const cached = kieReferenceUploads.get(cacheKey);
  if (cached && cached.expiresAt > now) return { assetUrl: await cached.promise, label };

  pruneKieReferenceUploads(now);
  const promise = uploadKieReferenceFile(path, mimeType);
  const entry = { expiresAt: now + KIE_REFERENCE_CACHE_MS, promise };
  kieReferenceUploads.set(cacheKey, entry);
  try {
    return { assetUrl: await promise, label };
  } catch (error) {
    if (kieReferenceUploads.get(cacheKey) === entry) kieReferenceUploads.delete(cacheKey);
    throw error;
  }
}

export type KieProviderWorkflow = {
  kind: "grok-image-edit";
  stage: "segment-map" | "image-edit";
  segmentTaskId?: string;
};

type StartInput = {
  modelId: string;
  prompt: string;
  references: Array<{ path: string; mimeType: string; label: string; role?: string }>;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  generateAudio?: boolean;
  providerWorkflow?: KieProviderWorkflow;
};

type UploadedReference = { assetUrl: string; label: string; role?: string };

function providerPrompt(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

export function kieProviderPrompt(userRequest: string, referenceLabels: string[]) {
  const referenceHeader = referenceLabels.length
    ? `REFERENCE_MAP (bindings are exact; never swap images):\n${referenceLabels.map((label, index) => `${index + 1}: ${label}`).join("\n")}\nUSER_REQUEST:\n`
    : "";
  return `${referenceHeader}${providerPrompt(userRequest)}`;
}

export function buildKieInput(modelId: string, input: Omit<StartInput, "modelId" | "references">, uploadedInput: Array<UploadedReference | string>): Record<string, unknown> {
  const model = getKieModel(modelId);
  const ratio = input.aspectRatio || model.defaultRatio || model.ratios[0] || "1:1";
  const resolution = input.resolution || model.defaultResolution || model.resolutions[0];
  const duration = Number(input.duration || model.defaultDuration || model.durations?.[0] || "5");
  const prompt = input.prompt;
  const negativePrompt = "watermark, blurry, low quality, distorted anatomy, extra limbs";
  const uploadedReferences = uploadedInput.map((reference) => typeof reference === "string" ? { assetUrl: reference, label: "reference" } : reference);
  const referenceUrls = uploadedReferences.map((reference) => reference.assetUrl);
  const roleUrls = (role: string) => uploadedReferences.filter((reference) => reference.role === role).map((reference) => reference.assetUrl);

  if (model.id === "nano-banana-2-lite") {
    return { prompt, image_urls: referenceUrls, aspect_ratio: ratio };
  }
  if (model.id === "nano-banana-2" || model.id === "nano-banana-pro") {
    return { prompt, image_input: referenceUrls, aspect_ratio: ratio, resolution: resolution?.toUpperCase(), output_format: "png" };
  }
  if (model.id === "gpt-image-2") {
    return { prompt, ...(referenceUrls.length ? { input_urls: referenceUrls } : {}), aspect_ratio: ratio, resolution: resolution?.toUpperCase() };
  }
  if (model.id === "grok-image-2") {
    return { prompt, aspect_ratio: ratio };
  }
  if (model.id === "seedream-5-lite" || model.id === "seedream-5-pro") {
    const normalizedResolution = resolution?.toUpperCase();
    const quality = model.id === "seedream-5-lite"
      ? normalizedResolution === "4K" ? "ultra" : normalizedResolution === "3K" ? "high" : "basic"
      : normalizedResolution === "2K" ? "high" : "basic";
    return { prompt, ...(referenceUrls.length ? { image_urls: referenceUrls } : {}), aspect_ratio: ratio, quality, output_format: "png", nsfw_checker: false };
  }
  if (model.id === "flux-2-flex") {
    return { prompt, ...(referenceUrls.length ? { input_urls: referenceUrls } : {}), aspect_ratio: ratio, resolution: resolution?.toUpperCase(), nsfw_checker: false };
  }
  if (model.id === "imagen4-fast" || model.id === "imagen4-ultra") {
    return { prompt, negative_prompt: negativePrompt, aspect_ratio: ratio };
  }
  if (model.id.startsWith("seedance-2")) {
    return { prompt, first_frame_url: roleUrls("start-frame")[0], last_frame_url: roleUrls("end-frame")[0], reference_image_urls: roleUrls("reference-image"), reference_video_urls: roleUrls("reference-video"), reference_audio_urls: roleUrls("reference-audio"), return_last_frame: false, generate_audio: Boolean(input.generateAudio), resolution: resolution?.toLowerCase(), aspect_ratio: ratio, duration, ...(model.id === "seedance-2-5" ? { output_format: "mp4" } : {}), web_search: false };
  }
  if (model.id === "kling-3") {
    const imageUrls = [...roleUrls("start-frame"), ...roleUrls("end-frame")].slice(0, 2);
    return { prompt, image_urls: imageUrls, sound: Boolean(input.generateAudio), duration: String(duration), aspect_ratio: ratio, mode: resolution?.toUpperCase() === "4K" ? "4K" : resolution?.toUpperCase() === "1080P" ? "pro" : "std", multi_shots: false };
  }
  if (model.id === "kling-3-turbo-text") {
    return { prompt, duration: String(duration), resolution: resolution?.toLowerCase(), aspect_ratio: ratio };
  }
  if (model.id === "kling-3-turbo-image") {
    return { prompt, image_urls: roleUrls("start-frame").slice(0, 1), duration: String(duration), resolution: resolution?.toLowerCase() };
  }
  if (model.id === "kling-3-motion") {
    return {
      prompt,
      input_urls: [...roleUrls("start-frame"), ...roleUrls("reference-image")].slice(0, 1),
      video_urls: [...roleUrls("reference-video"), ...roleUrls("motion-video")].slice(0, 1),
      mode: resolution?.toLowerCase(),
      character_orientation: "image",
      background_source: "input_video",
    };
  }
  if (model.id === "grok-video-text") {
    return { prompt, aspect_ratio: ratio, mode: "normal", duration: String(duration), resolution: resolution?.toLowerCase(), nsfw_checker: false };
  }
  if (model.id === "grok-video-image") {
    const imageUrls = [...roleUrls("reference-image"), ...roleUrls("start-frame")].slice(0, 7);
    return { prompt, image_urls: imageUrls, ...(imageUrls.length > 1 ? { aspect_ratio: ratio } : {}), mode: "normal", duration: String(duration), resolution: resolution?.toLowerCase() };
  }
  if (model.id === "grok-video-1-5") {
    const imageUrls = [...roleUrls("reference-image"), ...roleUrls("start-frame")].slice(0, 7);
    return { prompt, ...(imageUrls.length ? { image_urls: imageUrls } : {}), ...(imageUrls.length === 1 ? {} : { aspect_ratio: ratio }), resolution: resolution?.toLowerCase(), duration };
  }
  if (model.id === "wan-2-7") {
    const firstFrameUrl = roleUrls("start-frame")[0];
    const lastFrameUrl = roleUrls("end-frame")[0];
    const firstClipUrl = roleUrls("reference-video")[0];
    const audioUrl = roleUrls("reference-audio")[0];
    const imageMode = Boolean(firstFrameUrl || lastFrameUrl || firstClipUrl);
    return imageMode
      ? { prompt, negative_prompt: negativePrompt, first_frame_url: firstFrameUrl, last_frame_url: lastFrameUrl, first_clip_url: firstClipUrl, driving_audio_url: audioUrl, resolution: resolution?.toLowerCase(), duration, prompt_extend: true, watermark: false }
      : { prompt, negative_prompt: negativePrompt, audio_url: audioUrl, resolution: resolution?.toLowerCase(), ratio, duration, prompt_extend: true, watermark: false };
  }
  throw new Error(`Kie.ai payload adapter is missing for ${model.id}`);
}

export async function startGeneration(input: StartInput) {
  const model = getKieModel(input.modelId);
  if (input.references.length > model.maxReferences) {
    throw new Error(`${model.label} accepts at most ${model.maxReferences} reference inputs`);
  }
  const references = input.providerWorkflow?.kind === "grok-image-edit" && input.providerWorkflow.stage === "image-edit"
    ? []
    : input.references;
  const uploaded = await Promise.all(references.map(async (reference) => ({ ...(await uploadKieReference(reference.path, reference.mimeType, reference.label)), role: reference.role })));
  const prompt = model.id === "grok-image-2"
    ? providerPrompt(input.prompt)
    : kieProviderPrompt(input.prompt, uploaded.map((item) => item.label));
  assertKiePromptLength(model.id, prompt);
  const callBackUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/api/webhooks/kie` : undefined;
  let body: Record<string, unknown>;
  if (model.id === "grok-image-2") {
    const workflow = input.providerWorkflow;
    const providerModel = workflow?.stage === "segment-map"
      ? "grok-imagine-image-2-0/segment-map"
      : workflow?.stage === "image-edit"
        ? "grok-imagine-image-2-0/image-edit"
        : model.providerModel;
    const providerInput = workflow?.stage === "segment-map"
      ? { image_url: uploaded[0]?.assetUrl }
      : workflow?.stage === "image-edit"
        ? { prompt, task_id: workflow.segmentTaskId }
        : buildKieInput(model.id, { prompt, aspectRatio: input.aspectRatio, resolution: input.resolution, duration: input.duration, generateAudio: input.generateAudio }, uploaded);
    if (workflow?.stage === "segment-map" && !uploaded[0]?.assetUrl) throw new Error("Grok Image Edit requires one image reference");
    if (workflow?.stage === "image-edit" && !workflow.segmentTaskId) throw new Error("Grok Image Edit segment map is missing");
    body = {
      model: providerModel,
      ...(callBackUrl ? { callBackUrl } : {}),
      input: providerInput,
    };
  } else if (model.providerPath === "/api/v1/veo/generate") {
    const roleUrls = (role: string) => uploaded.filter((reference) => reference.role === role).map((reference) => reference.assetUrl);
    const frameUrls = [...roleUrls("start-frame"), ...roleUrls("end-frame")].slice(0, 2);
    const materialUrls = roleUrls("reference-image").slice(0, 3);
    const generationType = materialUrls.length
      ? "REFERENCE_2_VIDEO"
      : frameUrls.length
        ? "FIRST_AND_LAST_FRAMES_2_VIDEO"
        : "TEXT_2_VIDEO";
    body = {
      prompt,
      ...((materialUrls.length || frameUrls.length) ? { imageUrls: materialUrls.length ? materialUrls : frameUrls } : {}),
      model: model.providerModel,
      callBackUrl,
      aspect_ratio: (input.aspectRatio || model.defaultRatio || "16:9") === "auto" ? "Auto" : input.aspectRatio || model.defaultRatio || "16:9",
      resolution: (input.resolution || model.defaultResolution || "720P").toLowerCase(),
      duration: Number(input.duration || model.defaultDuration || "8"),
      enableFallback: false,
      enableTranslation: true,
      generationType,
    };
  } else {
    let providerModel = model.providerModel;
    if (model.id === "gpt-image-2") providerModel = uploaded.length ? "gpt-image-2-image-to-image" : "gpt-image-2-text-to-image";
    if (model.id === "seedream-5-lite") providerModel = uploaded.length ? "seedream/5-lite-image-to-image" : "seedream/5-lite-text-to-image";
    if (model.id === "seedream-5-pro") providerModel = uploaded.length ? "seedream/5-pro-image-to-image" : "seedream/5-pro-text-to-image";
    if (model.id === "flux-2-flex") providerModel = uploaded.length ? "flux-2/flex-image-to-image" : "flux-2/flex-text-to-image";
    if (model.id === "wan-2-7") providerModel = uploaded.some((reference) => reference.role === "start-frame" || reference.role === "end-frame" || reference.role === "reference-video") ? "wan/2-7-image-to-video" : "wan/2-7-text-to-video";
    body = {
      model: providerModel,
      ...(callBackUrl ? { callBackUrl } : {}),
      input: buildKieInput(model.id, { prompt, aspectRatio: input.aspectRatio, resolution: input.resolution, duration: input.duration, generateAudio: input.generateAudio }, uploaded),
    };
  }
  await acquireKieGenerationPermit();
  const response = await kieFetch(model.providerPath, { method: "POST", body: JSON.stringify(body) });
  const task = normalizeKieTask(response);
  if (!task.task_id) throw new Error("Kie.ai did not return a task ID");
  return { ...task, status: task.status || "waiting", model };
}

export function assertKiePromptLength(modelId: string, prompt: string) {
  const model = getKieModel(modelId);
  const limit = model.maxPromptLength || 5_000;
  if (prompt.length > limit) {
    throw new Error(`${model.label} accepts prompts up to ${limit.toLocaleString("en-US")} characters`);
  }
}

export async function getGeneration(modelId: string, taskId: string) {
  const model = getKieModel(modelId);
  const path = model.providerStatusPath || "/api/v1/jobs/recordInfo";
  return normalizeKieTask(await kieFetch(`${path}?taskId=${encodeURIComponent(taskId)}`, { method: "GET" }));
}

export function verifyKieWebhook(taskId: string, headers: Headers) {
  const secret = process.env.KIE_WEBHOOK_HMAC_KEY;
  const timestamp = headers.get("x-webhook-timestamp");
  const signature = headers.get("x-webhook-signature");
  if (!secret || !taskId || !timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = createHmac("sha256", secret).update(`${taskId}.${timestamp}`).digest("base64");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
