import { z, type ZodError } from "zod";
import { DEFAULT_ASSISTANT_MODEL_ID } from "./assistant-models";
import { persistedProjectIdSchema } from "./project-id";

export const promptComposeRequestSchema = z.object({
  projectId: persistedProjectIdSchema,
  brief: z.string().trim().min(2).max(5000),
  mediaType: z.enum(["image", "video"]).default("image"),
  modelId: z.string().max(100).optional(),
  modelLabel: z.string().max(160).optional(),
  duration: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  generateAudio: z.boolean().optional(),
  editMode: z.boolean().optional(),
  aspectRatio: z.string().max(20).optional(),
  resolution: z.string().max(20).optional(),
  sourceAspectRatio: z.string().max(20).optional(),
  sourceDimensions: z.string().max(40).optional(),
  outputSizeChanged: z.boolean().optional(),
  videoMasterContext: z.object({
    nodeId: z.string().min(1).max(160),
    clipId: z.string().min(1).max(160),
    clipTitle: z.string().min(1).max(160),
    timelineDurationSeconds: z.number().positive().max(3600),
    generationDurationSeconds: z.number().positive().max(3600).optional(),
    sourceKind: z.enum(["source-segment", "uploaded-clip", "new-scene"]),
    sourceAspectRatio: z.string().max(20),
    outputAspectRatio: z.string().max(20),
    outputRatioChanged: z.boolean(),
    sourceAssetId: z.string().uuid().optional(),
  }).optional(),
  sceneSource: z.object({
    assetId: z.string().uuid(),
    token: z.string().regex(/^@[\p{L}\p{N}_]+$/u).max(80),
    title: z.string().min(1).max(160),
    durationSeconds: z.number().positive().max(3600),
  }).optional(),
  assistantModelId: z.string().max(120).optional().default(DEFAULT_ASSISTANT_MODEL_ID),
  references: z.array(z.object({
    assetId: z.string().uuid(),
    token: z.string().min(2).max(80),
    title: z.string().min(1).max(160),
    role: z.enum(["reference-image", "start-frame", "end-frame", "motion-video", "reference-video", "reference-audio"]).optional(),
    purpose: z.enum(["edit-source", "canvas", "identity", "upload"]).optional(),
    durationSeconds: z.number().positive().max(3600).optional(),
  })).max(50).default([]),
});

export function promptComposeValidationMessage(error: ZodError) {
  const rootField = error.issues[0]?.path[0];
  if (rootField === "brief") return "Describe what you want to create";
  if (rootField === "references") return "One or more connected references are invalid. Reconnect them and try again.";
  return "Prompt assistant request is invalid";
}
