import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, usageWorkspaceForUserProject, userCanAccessAsset, userCanAccessProject } from "@/lib/postgres-db";
import { intelligenceProvider } from "@/platform/providers/registry";
import { usageSummary } from "@/modules/usage";
import { editionServer } from "@/editions/current/server";
import { AssistantCreditError, runAssistantUsage } from "@/lib/assistant-usage";
import { DEFAULT_ASSISTANT_MODEL_ID, getAssistantModel } from "@/lib/assistant-models";
import { persistedProjectIdSchema } from "@/lib/project-id";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({
  projectId: persistedProjectIdSchema,
  instruction: z.string().trim().min(1).max(10000),
  connectedText: z.string().max(20000).optional().default(""),
  systemPrompt: z.string().max(10000).optional().default(""),
  imageAssetIds: z.array(z.string().uuid()).max(14).default([]),
  assistantModelId: z.string().max(120).optional().default(DEFAULT_ASSISTANT_MODEL_ID),
});

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "assistant-tools", identity: auth.user.id, limit: 30, windowSeconds: 60 });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Describe the prompt you want to create" }, { status: 400 });
  if (!await userCanAccessProject(auth.user.id, parsed.data.projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const workspaceId = await usageWorkspaceForUserProject(auth.user.id, parsed.data.projectId);
  if (!workspaceId || !(await usageSummary(workspaceId)).assistantEnabled) {
    const denial = editionServer.featureAccessDenial("assistant");
    return Response.json(denial.body, { status: denial.status });
  }
  try {
    const selectedModel = getAssistantModel(parsed.data.assistantModelId);
    if (parsed.data.imageAssetIds.length && !selectedModel.supportsVision) {
      return Response.json({ error: `${selectedModel.label} supports text only. Disconnect image references or choose a vision model.` }, { status: 400 });
    }
    const images = await Promise.all(parsed.data.imageAssetIds.map(async (assetId) => {
      if (!await userCanAccessAsset(auth.user.id, assetId)) throw new Error("A connected image is no longer available");
      const asset = await db.prepare("SELECT storage_path, mime_type, filename FROM assets WHERE id = ?").get(assetId) as { storage_path: string; mime_type: string; filename: string } | undefined;
      if (!asset) throw new Error("A connected image is no longer available");
      return { path: asset.storage_path, mimeType: asset.mime_type, title: asset.filename || "Connected image" };
    }));
    const metered = await runAssistantUsage({
      modelId: selectedModel.id,
      workspaceId,
      userId: auth.user.id,
      kind: "assistant_node",
      inputCharacters: parsed.data.instruction.length + parsed.data.connectedText.length + parsed.data.systemPrompt.length,
      imageCount: images.length,
      maxOutputTokens: 4_096,
      run: () => intelligenceProvider().generateAssistantPrompt({ ...parsed.data, images }),
    });
    return Response.json({ output: metered.result, chargedCredits: metered.chargedCredits });
  } catch (error) {
    if (error instanceof AssistantCreditError) {
      return Response.json({ error: error.message, code: error.code, requiredCredits: error.requiredCredits }, { status: error.status });
    }
    return Response.json({ error: error instanceof Error ? error.message : "Assistant failed" }, { status: 502 });
  }
}
