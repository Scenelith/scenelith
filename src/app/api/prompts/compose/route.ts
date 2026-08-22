import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, readProjectGraphSnapshot, usageWorkspaceForUserProject, userCanAccessAsset, userCanAccessProject } from "@/lib/postgres-db";
import { intelligenceProvider } from "@/platform/providers/registry";
import { usageSummary } from "@/modules/usage";
import { editionServer } from "@/editions/current/server";
import { AssistantCreditError, runAssistantUsage } from "@/lib/assistant-usage";
import { getAssistantModel } from "@/lib/assistant-models";
import { promptComposeRequestSchema, promptComposeValidationMessage } from "@/lib/prompt-compose-request";
import { videoMasterTargetAcceptsAsset } from "@/lib/video-master-validation";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "assistant-tools", identity: auth.user.id, limit: 30, windowSeconds: 60 });
  if (limited) return limited;
  const parsed = promptComposeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: promptComposeValidationMessage(parsed.error) }, { status: 400 });
  if (!await userCanAccessProject(auth.user.id, parsed.data.projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const workspaceId = await usageWorkspaceForUserProject(auth.user.id, parsed.data.projectId);
  if (!workspaceId || !(await usageSummary(workspaceId)).assistantEnabled) {
    const denial = editionServer.featureAccessDenial("prompt");
    return Response.json(denial.body, { status: denial.status });
  }
  try {
    const selectedAssistantModel = getAssistantModel(parsed.data.assistantModelId);
    if (parsed.data.references.length && !selectedAssistantModel.supportsVision) {
      return Response.json({ error: `${selectedAssistantModel.label} supports text only. Remove visual references or choose a vision model.` }, { status: 400 });
    }
    const references = await Promise.all(parsed.data.references.map(async (reference) => {
      if (!await userCanAccessAsset(auth.user.id, reference.assetId)) throw new Error(`${reference.token} is no longer available`);
      const asset = await db.prepare("SELECT storage_path, mime_type FROM assets WHERE id = ?").get(reference.assetId) as { storage_path: string; mime_type: string } | undefined;
      if (!asset) throw new Error(`${reference.token} is no longer available`);
      return { path: asset.storage_path, mimeType: asset.mime_type, token: reference.token, title: reference.title, role: reference.role, purpose: reference.purpose, durationSeconds: reference.durationSeconds };
    }));
    let sceneSource: { path: string; mimeType: string; token: string; title: string; durationSeconds?: number } | undefined;
    if (parsed.data.sceneSource) {
      const context = parsed.data.videoMasterContext;
      if (!context) return Response.json({ error: "Selected scene context is missing" }, { status: 400 });
      const projectGraph = (await readProjectGraphSnapshot(parsed.data.projectId)).graph;
      const asset = await db.prepare("SELECT storage_path, mime_type, metadata_json FROM assets WHERE id = ?").get(parsed.data.sceneSource.assetId) as { storage_path: string; mime_type: string; metadata_json: string | null } | undefined;
      if (!asset || !asset.mime_type.startsWith("video/") || !await userCanAccessAsset(auth.user.id, parsed.data.sceneSource.assetId) || !videoMasterTargetAcceptsAsset(projectGraph, context.nodeId, context.clipId, parsed.data.sceneSource.assetId, asset.metadata_json)) {
        return Response.json({ error: "The selected scene source changed. Reopen the assistant and try again." }, { status: 409 });
      }
      sceneSource = { path: asset.storage_path, mimeType: asset.mime_type, token: parsed.data.sceneSource.token, title: parsed.data.sceneSource.title, durationSeconds: parsed.data.sceneSource.durationSeconds };
    }
    const metered = await runAssistantUsage({
      modelId: selectedAssistantModel.id,
      workspaceId,
      userId: auth.user.id,
      kind: "prompt_assistant",
      inputCharacters: parsed.data.brief.length + references.reduce((sum, reference) => sum + reference.title.length + reference.token.length, 0),
      imageCount: references.filter((reference) => reference.mimeType.startsWith("image/")).length
        + Math.min(12, references.filter((reference) => reference.mimeType.startsWith("video/")).length * 5),
      maxOutputTokens: 4_096,
      run: () => intelligenceProvider().composeGenerationPrompt({
        brief: parsed.data.brief,
        references,
        sceneSource,
        mediaType: parsed.data.mediaType,
        modelId: parsed.data.modelId,
        modelLabel: parsed.data.modelLabel,
        duration: parsed.data.duration,
        generateAudio: parsed.data.generateAudio,
        editMode: parsed.data.editMode,
        aspectRatio: parsed.data.aspectRatio,
        resolution: parsed.data.resolution,
        sourceAspectRatio: parsed.data.sourceAspectRatio,
        sourceDimensions: parsed.data.sourceDimensions,
        outputSizeChanged: parsed.data.outputSizeChanged,
        videoMasterContext: parsed.data.videoMasterContext,
      }),
    });
    return Response.json({ prompt: metered.result, chargedCredits: metered.chargedCredits });
  } catch (error) {
    if (error instanceof AssistantCreditError) {
      return Response.json({ error: error.message, code: error.code, requiredCredits: error.requiredCredits }, { status: error.status });
    }
    return Response.json({ error: error instanceof Error ? error.message : "Prompt assistant failed" }, { status: 502 });
  }
}
