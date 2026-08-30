import { assistantModels, DEFAULT_ASSISTANT_MODEL_ID } from "@/lib/assistant-models";
import { generationProvider } from "@/platform/providers/registry";
import type { FrameNodeData, FramePortType, GeneratorInputRole } from "@/lib/types";

export const mcpCanvasNodeTypes = ["image_generator", "video_generator", "assistant", "note"] as const;
export type McpCanvasNodeType = (typeof mcpCanvasNodeTypes)[number];

export const mcpGeneratorInputRoles = [
  "reference-image",
  "start-frame",
  "end-frame",
  "motion-video",
  "reference-video",
  "reference-audio",
] as const satisfies readonly GeneratorInputRole[];

export function canvasGenerationModels() {
  return generationProvider().models.map((model) => ({
    id: model.id,
    label: model.label,
    mediaType: model.mediaType,
    description: model.description,
    maxPromptLength: model.maxPromptLength || 5_000,
    maxReferences: model.maxReferences,
    ratios: model.ratios,
    ratiosByResolution: model.ratiosByResolution || null,
    referenceRatiosByResolution: model.referenceRatiosByResolution || null,
    referenceOnlyRatios: model.referenceOnlyRatios || [],
    resolutions: model.resolutions,
    videoInputOnlyResolutions: model.videoInputOnlyResolutions || [],
    durations: model.durations || [],
    durationSource: model.durationSource || "select",
    defaultRatio: model.defaultRatio || model.ratios[0],
    defaultResolution: model.defaultResolution || model.resolutions[0],
    defaultDuration: model.defaultDuration || model.durations?.[0] || null,
    defaultGenerateAudio: model.defaultGenerateAudio || false,
    supportsAudio: model.supportsAudio || false,
    inputPorts: model.inputPorts || (model.mediaType === "image" && model.maxReferences > 0
      ? [{ id: "reference-image", label: "Reference images", kind: "image" as const, max: model.maxReferences }]
      : []),
  }));
}

export function canvasAssistantModels() {
  return assistantModels.map((model) => ({ id: model.id, label: model.label, provider: model.provider, supportsVision: model.supportsVision }));
}

export function defaultCanvasNodeData(type: McpCanvasNodeType, input: {
  title?: string;
  modelId?: string;
  textModelId?: string;
  prompt?: string;
  instruction?: string;
  systemPrompt?: string;
  noteText?: string;
  noteColor?: "yellow" | "blue" | "rose" | "gray";
}) {
  const now = new Date().toISOString();
  if (type === "assistant") {
    const textModelId = input.textModelId || DEFAULT_ASSISTANT_MODEL_ID;
    if (!assistantModels.some((model) => model.id === textModelId)) throw new Error("Assistant model is not available");
    return {
      kind: "assistant",
      title: input.title?.trim() || "Assistant",
      subtitle: "AI Assistant",
      assistantInput: input.instruction || "",
      assistantOutput: "",
      systemPrompt: input.systemPrompt || "",
      textModelId,
      nodeWidth: 430,
      status: "idle",
      createdAt: now,
    } satisfies FrameNodeData;
  }
  if (type === "note") {
    return {
      kind: "note",
      title: input.title?.trim() || "Canvas note",
      subtitle: "",
      noteText: input.noteText || "Write a note…",
      noteColor: input.noteColor || "yellow",
      nodeWidth: 330,
      nodeHeight: 410,
      status: "idle",
      createdAt: now,
    } satisfies FrameNodeData;
  }
  const mediaType = type === "video_generator" ? "video" : "image";
  const models = generationProvider().models.filter((model) => model.mediaType === mediaType);
  const preferredId = input.modelId || (mediaType === "video" ? "seedance-2-fast" : "nano-banana-2");
  const model = models.find((candidate) => candidate.id === preferredId) || models[0];
  if (!model) throw new Error(`No ${mediaType} generation model is available`);
  return {
    kind: "prompt",
    title: input.title?.trim() || (mediaType === "video" ? "Video Generator" : "Image Generator"),
    subtitle: "Standalone generator",
    prompt: input.prompt || "",
    mediaType,
    modelId: model.id,
    aspectRatio: (mediaType === "image" && model.ratios.includes("1:1") ? "1:1" : model.defaultRatio || model.ratios[0] || (mediaType === "video" ? "16:9" : "1:1")) as FrameNodeData["aspectRatio"],
    ratioMode: "custom",
    resolution: (model.defaultResolution || model.resolutions[0] || (mediaType === "video" ? "720P" : "1K")) as FrameNodeData["resolution"],
    duration: model.defaultDuration || model.durations?.[0] || "5",
    generateAudio: model.defaultGenerateAudio || false,
    generationCount: 1,
    status: "idle",
    createdAt: now,
  } satisfies FrameNodeData;
}

export function canvasNodeOutputType(data: FrameNodeData, sourceHandle?: string | null): FramePortType {
  if (sourceHandle === "text-output" || data.kind === "assistant") return "text";
  if (sourceHandle === "audio-output") return "audio";
  if (sourceHandle === "video-output" || sourceHandle?.startsWith("segment-output:") || data.mediaType === "video") return "video";
  return "image";
}

export function inputRolePortType(role: GeneratorInputRole): FramePortType {
  if (role === "motion-video" || role === "reference-video") return "video";
  if (role === "reference-audio") return "audio";
  return "image";
}

export function canvasCapabilityDocument() {
  return {
    revisionSafety: "Every mutation requires the exact current canvas revision.",
    nodeTypes: [
      { type: "image_generator", createsKind: "prompt", supports: ["prompt", "model", "ratio", "resolution", "batch", "visual references", "generation"] },
      { type: "video_generator", createsKind: "prompt", supports: ["prompt", "model", "ratio", "resolution", "duration", "audio", "typed references", "generation"] },
      { type: "assistant", createsKind: "assistant", supports: ["instruction", "system prompt", "text model", "text input", "visual context", "run"] },
      { type: "note", createsKind: "note", supports: ["text", "color", "size"] },
      { type: "library_asset", createsKind: "scene", createdBy: "place_canvas_asset" },
      { type: "identity", createsKind: "persona", createdBy: "place_canvas_identity" },
      { type: "tiktok_source", createsKind: "source and scene", createdBy: "import_tiktok_to_canvas" },
      { type: "video_master", createsKind: "videoMaster", createdBy: "create_video_master" },
    ],
    connectionRoles: mcpGeneratorInputRoles.map((role) => ({ role, accepts: inputRolePortType(role) })),
    outputTypes: ["text", "image", "video", "audio"],
    assistantModels: canvasAssistantModels(),
    generationModels: canvasGenerationModels(),
  };
}
