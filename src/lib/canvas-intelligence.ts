import { db, readProjectGraphSnapshot, usageWorkspaceForUserProject, userCanAccessAsset, userCanAccessProject } from "@/lib/postgres-db";
import { intelligenceProvider } from "@/platform/providers/registry";
import { usageSummary } from "@/modules/usage";
import { editionServer } from "@/editions/current/server";
import { AssistantCreditError, runAssistantUsage } from "@/lib/assistant-usage";
import { DEFAULT_ASSISTANT_MODEL_ID, getAssistantModel } from "@/lib/assistant-models";
import { videoMasterTargetAcceptsAsset } from "@/lib/video-master-validation";

function serviceError(message: string, status: number, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

async function assistantWorkspace(userId: string, projectId: string, feature: "assistant" | "prompt") {
  if (!await userCanAccessProject(userId, projectId)) throw serviceError("Canvas not found", 404);
  const workspaceId = await usageWorkspaceForUserProject(userId, projectId);
  if (!workspaceId || !(await usageSummary(workspaceId)).assistantEnabled) {
    const denial = editionServer.featureAccessDenial(feature);
    throw serviceError(String((denial.body as { error?: unknown }).error || `${feature} is unavailable`), denial.status, denial.body);
  }
  return workspaceId;
}

export async function runCanvasAssistant(input: {
  userId: string;
  projectId: string;
  instruction: string;
  connectedText?: string;
  systemPrompt?: string;
  imageAssetIds?: string[];
  assistantModelId?: string;
}) {
  const instruction = input.instruction.trim();
  if (!instruction || instruction.length > 10_000) throw serviceError("Describe the prompt you want to create", 400);
  const connectedText = input.connectedText || "";
  const systemPrompt = input.systemPrompt || "";
  const imageAssetIds = [...new Set(input.imageAssetIds || [])];
  if (connectedText.length > 20_000 || systemPrompt.length > 10_000 || imageAssetIds.length > 14) throw serviceError("Assistant input is too large", 400);
  const workspaceId = await assistantWorkspace(input.userId, input.projectId, "assistant");
  try {
    const selectedModel = getAssistantModel(input.assistantModelId || DEFAULT_ASSISTANT_MODEL_ID);
    if (imageAssetIds.length && !selectedModel.supportsVision) throw serviceError(`${selectedModel.label} supports text only. Disconnect image references or choose a vision model.`, 400);
    const images = await Promise.all(imageAssetIds.map(async (assetId) => {
      if (!await userCanAccessAsset(input.userId, assetId)) throw serviceError("A connected image is no longer available", 404);
      const asset = await db.prepare("SELECT storage_path, mime_type, filename FROM assets WHERE id = ?").get(assetId) as { storage_path: string; mime_type: string; filename: string } | undefined;
      if (!asset || !asset.mime_type.startsWith("image/")) throw serviceError("A connected image is no longer available", 404);
      return { path: asset.storage_path, mimeType: asset.mime_type, title: asset.filename || "Connected image" };
    }));
    const metered = await runAssistantUsage({
      modelId: selectedModel.id,
      workspaceId,
      userId: input.userId,
      kind: "assistant_node",
      inputCharacters: instruction.length + connectedText.length + systemPrompt.length,
      imageCount: images.length,
      maxOutputTokens: 4_096,
      run: () => intelligenceProvider().generateAssistantPrompt({ instruction, connectedText, systemPrompt, images }),
    });
    return { output: metered.result, chargedCredits: metered.chargedCredits, modelId: selectedModel.id };
  } catch (error) {
    if (error instanceof AssistantCreditError) throw serviceError(error.message, error.status, { code: error.code, requiredCredits: error.requiredCredits });
    throw error;
  }
}

export type CanvasPromptReference = {
  assetId: string;
  token: string;
  title: string;
  role?: "reference-image" | "start-frame" | "end-frame" | "motion-video" | "reference-video" | "reference-audio";
  purpose?: "edit-source" | "canvas" | "identity" | "upload";
  durationSeconds?: number;
};

export async function composeCanvasGenerationPrompt(input: {
  userId: string;
  projectId: string;
  brief: string;
  mediaType: "image" | "video";
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
  systemPrompt?: string;
  assistantModelId?: string;
  references?: CanvasPromptReference[];
  videoMasterContext?: {
    nodeId: string; clipId: string; clipTitle: string; timelineDurationSeconds: number; generationDurationSeconds?: number;
    sourceKind: "source-segment" | "uploaded-clip" | "new-scene"; sourceAspectRatio: string; outputAspectRatio: string; outputRatioChanged: boolean; sourceAssetId?: string;
  };
  sceneSource?: { assetId: string; token: string; title: string; durationSeconds: number };
}) {
  const brief = input.brief.trim();
  const references = input.references || [];
  if (brief.length < 2 || brief.length > 5_000 || references.length > 50) throw serviceError("Describe what you want to create", 400);
  const workspaceId = await assistantWorkspace(input.userId, input.projectId, "prompt");
  try {
    const selectedAssistantModel = getAssistantModel(input.assistantModelId || DEFAULT_ASSISTANT_MODEL_ID);
    if (references.length && !selectedAssistantModel.supportsVision) throw serviceError(`${selectedAssistantModel.label} supports text only. Remove visual references or choose a vision model.`, 400);
    const loadedReferences = await Promise.all(references.map(async (reference) => {
      if (!await userCanAccessAsset(input.userId, reference.assetId)) throw serviceError(`${reference.token} is no longer available`, 404);
      const asset = await db.prepare("SELECT storage_path, mime_type FROM assets WHERE id = ?").get(reference.assetId) as { storage_path: string; mime_type: string } | undefined;
      if (!asset) throw serviceError(`${reference.token} is no longer available`, 404);
      return { path: asset.storage_path, mimeType: asset.mime_type, token: reference.token, title: reference.title, role: reference.role, purpose: reference.purpose, durationSeconds: reference.durationSeconds };
    }));
    let sceneSource: { path: string; mimeType: string; token: string; title: string; durationSeconds?: number } | undefined;
    if (input.sceneSource) {
      const context = input.videoMasterContext;
      if (!context) throw serviceError("Selected scene context is missing", 400);
      const projectGraph = (await readProjectGraphSnapshot(input.projectId)).graph;
      const asset = await db.prepare("SELECT storage_path, mime_type, metadata_json FROM assets WHERE id = ?").get(input.sceneSource.assetId) as { storage_path: string; mime_type: string; metadata_json: string | null } | undefined;
      if (!asset || !asset.mime_type.startsWith("video/") || !await userCanAccessAsset(input.userId, input.sceneSource.assetId)
        || !videoMasterTargetAcceptsAsset(projectGraph, context.nodeId, context.clipId, input.sceneSource.assetId, asset.metadata_json)) {
        throw serviceError("The selected scene source changed. Reopen the assistant and try again.", 409);
      }
      sceneSource = { path: asset.storage_path, mimeType: asset.mime_type, token: input.sceneSource.token, title: input.sceneSource.title, durationSeconds: input.sceneSource.durationSeconds };
    }
    const metered = await runAssistantUsage({
      modelId: selectedAssistantModel.id,
      workspaceId,
      userId: input.userId,
      kind: "prompt_assistant",
      inputCharacters: brief.length + String(input.systemPrompt || "").length + loadedReferences.reduce((sum, reference) => sum + reference.title.length + reference.token.length, 0),
      imageCount: loadedReferences.filter((reference) => reference.mimeType.startsWith("image/")).length
        + Math.min(12, loadedReferences.filter((reference) => reference.mimeType.startsWith("video/")).length * 5),
      maxOutputTokens: 4_096,
      run: () => intelligenceProvider().composeGenerationPrompt({
        brief,
        references: loadedReferences,
        sceneSource,
        mediaType: input.mediaType,
        modelId: input.modelId,
        modelLabel: input.modelLabel,
        duration: input.duration,
        generateAudio: input.generateAudio,
        editMode: input.editMode,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        sourceAspectRatio: input.sourceAspectRatio,
        sourceDimensions: input.sourceDimensions,
        outputSizeChanged: input.outputSizeChanged,
        systemPrompt: input.systemPrompt,
        videoMasterContext: input.videoMasterContext,
      }),
    });
    return { prompt: metered.result, chargedCredits: metered.chargedCredits, assistantModelId: selectedAssistantModel.id };
  } catch (error) {
    if (error instanceof AssistantCreditError) throw serviceError(error.message, error.status, { code: error.code, requiredCredits: error.requiredCredits });
    throw error;
  }
}
