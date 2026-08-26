import { db, mutateProjectGraphSnapshot } from "./postgres-db";
import { mutateCollaborativeGraph } from "./collaboration-store";
import { advanceGenerationProviderWorkflow, queuedGenerationPosition } from "./generation-dispatch";
import { createAssetThumbnail } from "./image-thumbnails";
import { getGeneration, KieRateLimitError } from "./kie";
import {
  generationTimedOut,
  publicGenerationErrorMessage,
  timeoutGeneration,
} from "./generation-lifecycle";
import { usageAuthority } from "@/modules/usage";
import { optimizeMp4ForStreaming, probeVideoMetadata, type VideoMetadata } from "./media-probe";
import { putStorageObject, safeExtension } from "./storage";
import type { FrameNode, ProjectGraph } from "./types";
import { videoMasterTimelineDuration } from "./video-master";

export const completedGenerationStatuses = new Set(["completed", "complete", "succeeded", "success"]);
export const failedGenerationStatuses = new Set(["fail", "failed", "error", "cancelled", "canceled"]);
const emptyCompletedGraceMs = 30 * 1000;
const emptyCompletedMessage = "Generation completed without returning media. The prompt or references may have been blocked by a safety filter.";

export type GenerationStateRow = {
  id: string;
  project_id: string;
  node_id: string;
  provider_task_id: string | null;
  status: string;
  output_url: string | null;
  output_asset_id: string | null;
  error: string | null;
  model_id: string;
  media_type: string;
  operation: string;
  credit_cost: number;
  created_at: string;
  updated_at: string;
};

function providerErrorMessage(value: unknown) {
  if (!value) return null;
  if (typeof value === "string") return publicGenerationErrorMessage(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = record.message || record.error || record.detail;
    if (message) return publicGenerationErrorMessage(String(message));
  }
  return publicGenerationErrorMessage(String(value));
}

export async function readGenerationState(id: string) {
  return await db.prepare("SELECT * FROM generations WHERE id = ?").get(id) as GenerationStateRow | undefined;
}

async function updateGenerationNode(generation: GenerationStateRow, changes: {
  outputUrl?: string;
  assetId?: string;
  durationSeconds?: number;
  error?: string | null;
}) {
  let persistedTargetClipId: string | undefined;
  if (changes.outputUrl) {
    try {
      const dispatch = await db.prepare("SELECT payload_json FROM generation_dispatch_jobs WHERE generation_id = ?")
        .get(generation.id) as { payload_json: string } | undefined;
      persistedTargetClipId = String((JSON.parse(dispatch?.payload_json || "{}") as { targetClipId?: string }).targetClipId || "") || undefined;
    } catch {}
  }
  const mutate = process.env.COLLABORATION_INTERNAL_SECRET
    ? (mutator: (graph: ProjectGraph) => ProjectGraph) => mutateCollaborativeGraph(generation.project_id, mutator)
    : async (mutator: (graph: ProjectGraph) => ProjectGraph) => await mutateProjectGraphSnapshot(generation.project_id, mutator);
  await mutate((graph: ProjectGraph) => {
    const nodeIndex = (graph.nodes || []).findIndex((node) => node.id === generation.node_id);
    if (nodeIndex < 0) return graph;

    const node = graph.nodes[nodeIndex] as FrameNode;
    const output = changes.outputUrl ? {
      url: changes.outputUrl,
      assetId: changes.assetId,
      mediaType: generation.media_type === "video" ? "video" as const : "image" as const,
      modelId: generation.model_id,
      durationSeconds: changes.durationSeconds,
    } : null;
    const priorOutput = generation.operation === "edit" && node.data.outputUrl && node.data.assetId ? {
      url: node.data.outputUrl,
      assetId: node.data.assetId,
      mediaType: node.data.mediaType || "image" as const,
      modelId: node.data.modelId,
    } : null;
    const outputHistory = output
      ? [...(node.data.generatedOutputs || []), ...(priorOutput ? [priorOutput] : []), output]
        .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
        .slice(-20)
      : node.data.generatedOutputs;
    const editReferencesByAssetId = generation.operation === "edit" && output?.assetId && node.data.assetId
      ? {
        ...(node.data.editReferencesByAssetId || {}),
        [output.assetId]: [...(node.data.editReferencesByAssetId?.[node.data.assetId] || [])],
      }
      : node.data.editReferencesByAssetId;
    const targetClipId = node.data.videoMasterGeneratingClipId || persistedTargetClipId;
    if (output && node.data.kind === "videoMaster" && targetClipId) {
      const clipId = targetClipId;
      const clips = node.data.videoMasterClips || [];
      if (clips.some((clip) => clip.id === clipId)) {
        const targetClip = clips.find((clip) => clip.id === clipId);
        const timelineDuration = videoMasterTimelineDuration(targetClip);
        const physicalDuration = Number(changes.durationSeconds || 0);
        const generatedDuration = physicalDuration > 0
          ? physicalDuration
          : Math.max(.1, Number(node.data.duration || timelineDuration));
        const nextClips = clips.map((clip) => {
          if (clip.id !== clipId) return clip;
          const clipOutput = { url: output.url, assetId: output.assetId, modelId: output.modelId, durationSeconds: generatedDuration };
          const history = [...(clip.generatedOutputs || []), clipOutput]
            .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
            .slice(-20);
          return {
            ...clip,
            origin: "generated" as const,
            outputUrl: output.url,
            outputAssetId: output.assetId,
            generatedDuration,
            generatedOutputs: history,
            modelId: output.modelId,
          };
        });
        graph.nodes = [...graph.nodes];
        graph.nodes[nodeIndex] = {
          ...node,
          data: {
            ...node.data,
            outputUrl: undefined,
            assetId: undefined,
            generatedOutputs: undefined,
            activeGeneratedOutputIndex: undefined,
            generatedAt: generation.created_at,
            status: "ready" as const,
            queueReason: undefined,
            generationError: undefined,
            videoMasterClips: nextClips,
            videoMasterGeneratingClipId: undefined,
          },
        };
        return graph;
      }
    }
    const nextNode: FrameNode = {
      ...node,
      data: {
        ...node.data,
        ...(output ? {
          outputUrl: output.url,
          assetId: output.assetId,
          mediaType: output.mediaType,
          modelId: output.modelId,
          generatedAt: generation.created_at,
          generatedOutputs: outputHistory,
          activeGeneratedOutputIndex: Math.max(0, (outputHistory?.length || 1) - 1),
          editReferencesByAssetId,
          status: "ready" as const,
          queueReason: undefined,
          generationError: undefined,
          ...(generation.operation === "edit" ? { subtitle: "Image edited in place" } : {}),
        } : {
          status: "failed" as const,
          queueReason: undefined,
          generationError: changes.error || "Generation failed",
        }),
      },
    };
    graph.nodes = [...graph.nodes];
    graph.nodes[nodeIndex] = nextNode;
    return graph;
  });
}

export async function persistGenerationOutput(id: string, outputUrl: string) {
  const generation = await readGenerationState(id);
  if (!generation) throw new Error("Generation was not found");
  if (generation.output_asset_id) {
    const durationSeconds = await generatedAssetDurationSeconds(generation.output_asset_id);
    await updateGenerationNode(generation, { outputUrl: `/api/assets/${generation.output_asset_id}`, assetId: generation.output_asset_id, durationSeconds });
    return generation.output_asset_id;
  }

  let bytes: Buffer;
  let contentType = generation.media_type === "video" ? "video/mp4" : "image/png";
  if (/^https?:\/\//i.test(outputUrl) || outputUrl.startsWith("data:")) {
    const response = await fetch(outputUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not save generated output (${response.status})`);
    contentType = response.headers.get("content-type")?.split(";")[0] || contentType;
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    bytes = Buffer.from(outputUrl, "base64");
  }

  const extension = safeExtension(/^https?:\/\//i.test(outputUrl) || outputUrl.startsWith("data:") ? new URL(outputUrl).pathname : "generated", contentType);
  if (generation.media_type === "video" && extension === ".mp4") {
    bytes = await optimizeMp4ForStreaming(bytes);
    contentType = "video/mp4";
  }
  const physicalVideoMetadata: VideoMetadata = generation.media_type === "video"
    ? await probeVideoMetadata(bytes, extension).catch(() => ({}))
    : {};
  const assetId = crypto.randomUUID();
  const filename = `${id}${extension}`;
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(generation.project_id) as { workspace_id: string } | undefined;
  if (!project?.workspace_id) throw new Error("Generation project has no workspace");
  const stored = await putStorageObject(bytes, `workspaces/${project.workspace_id}/projects/${generation.project_id}/generations/${filename}`, { contentType });
  const dispatchJob = await db.prepare("SELECT payload_json FROM generation_dispatch_jobs WHERE generation_id = ?").get(id) as { payload_json: string } | undefined;
  let generationMetadata: Record<string, unknown> = {};
  try {
    const payload = JSON.parse(dispatchJob?.payload_json || "{}") as Record<string, unknown>;
    const requestedDurationSeconds = Number(payload.duration || 0) || undefined;
    generationMetadata = {
      modelId: payload.modelId,
      resolution: payload.resolution,
      requestedDurationSeconds,
      duration: generation.media_type === "video" ? physicalVideoMetadata.durationSeconds || requestedDurationSeconds : undefined,
      durationSeconds: generation.media_type === "video" ? physicalVideoMetadata.durationSeconds || requestedDurationSeconds : undefined,
      width: physicalVideoMetadata.width,
      height: physicalVideoMetadata.height,
      aspectRatio: physicalVideoMetadata.aspectRatio,
    };
  } catch {}

  const generationEventOwner = !generation.node_id.startsWith("automation-")
    ? await db.prepare("SELECT requested_by_user_id FROM generations WHERE id = ?").get(id) as { requested_by_user_id: string } | undefined
    : undefined;
  const now = new Date().toISOString();
  const persisted = await db.transaction(async () => {
    const current = await db.prepare("SELECT output_asset_id FROM generations WHERE id = ?").get(id) as { output_asset_id: string | null } | undefined;
    if (current?.output_asset_id) return { assetId: current.output_asset_id, inserted: false };
    await db.prepare(`INSERT INTO assets
      (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at)
      VALUES (?, ?, ?, ?, 'generated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        assetId,
        project.workspace_id,
        generation.project_id,
        generation.media_type === "video" ? "generated_video" : "generated_image",
        filename,
        stored.reference,
        stored.provider,
        stored.bucket,
        stored.key,
        stored.size,
        stored.contentHash,
        contentType,
        JSON.stringify({ generationId: id, sourceUrl: outputUrl, ...generationMetadata }),
        now,
      );
    await db.prepare("UPDATE generations SET output_asset_id = ?, output_url = ?, updated_at = ? WHERE id = ? AND output_asset_id IS NULL")
      .run(assetId, outputUrl, now, id);
    if (generationEventOwner?.requested_by_user_id) {
      const { fireAutomationCanvasEvent } = await import("./automation-workflows/triggers");
      await fireAutomationCanvasEvent({
        userId: generationEventOwner.requested_by_user_id,
        projectId: generation.project_id,
        event: "generation.completed",
        payload: { generationId: id, nodeId: generation.node_id, assetId, mediaType: generation.media_type, operation: generation.operation },
        sourceKey: `generation:${id}`,
      });
    }
    return { assetId, inserted: true };
  })();

  if (persisted.inserted && contentType.startsWith("image/")) {
    try {
      const thumbnail = await createAssetThumbnail(bytes, {
        id: persisted.assetId,
        workspaceId: project.workspace_id,
        storagePath: stored.reference,
        objectKey: stored.key,
      });
      await db.prepare(`UPDATE assets
        SET thumbnail_storage_path = ?, thumbnail_size_bytes = ?, thumbnail_content_hash = ?, thumbnail_mime_type = 'image/webp'
        WHERE id = ?`).run(thumbnail.stored.reference, thumbnail.stored.size, thumbnail.stored.contentHash, persisted.assetId);
    } catch (error) {
      console.error("Generated image thumbnail could not be prepared", { assetId: persisted.assetId, error });
    }
  }
  const latest = await readGenerationState(id) || generation;
  await updateGenerationNode(latest, {
    outputUrl: `/api/assets/${persisted.assetId}`,
    assetId: persisted.assetId,
    durationSeconds: physicalVideoMetadata.durationSeconds,
  });
  return persisted.assetId;
}

async function generatedAssetDurationSeconds(assetId: string | null) {
  if (!assetId) return undefined;
  const row = await db.prepare("SELECT metadata_json FROM assets WHERE id = ?").get(assetId) as { metadata_json: string | null } | undefined;
  try {
    const metadata = JSON.parse(row?.metadata_json || "{}") as { durationSeconds?: number | string; duration?: number | string };
    const durationSeconds = Number(metadata.durationSeconds || metadata.duration || 0);
    return Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : undefined;
  } catch {
    return undefined;
  }
}

export async function generationClientState(generation: GenerationStateRow) {
  return {
    id: generation.id,
    status: generation.status,
    queuePosition: await queuedGenerationPosition(generation.id),
    outputUrl: generation.output_asset_id ? `/api/assets/${generation.output_asset_id}` : generation.output_url,
    assetId: generation.output_asset_id,
    mediaType: generation.media_type,
    modelId: generation.model_id,
    operation: generation.operation,
    nodeId: generation.node_id,
    projectId: generation.project_id,
    creditCost: Number(generation.credit_cost || 0),
    createdAt: generation.created_at,
    updatedAt: generation.updated_at,
    durationSeconds: generatedAssetDurationSeconds(generation.output_asset_id),
    error: generation.error ? publicGenerationErrorMessage(generation.error) : null,
  };
}

export async function reconcileGeneration(id: string) {
  let generation = await readGenerationState(id);
  if (!generation) throw new Error("Generation was not found");
  if (["cancelled", "canceled"].includes(String(generation.status).toLowerCase())) return generation;
  if (!generation.provider_task_id) {
    return generation;
  }

  try {
    const task = await getGeneration(generation.model_id, generation.provider_task_id);
    const providerStatus = String(task?.status || generation.status).toLowerCase();
    if (await advanceGenerationProviderWorkflow({
      generationId: id,
      providerTaskId: generation.provider_task_id,
      providerStatus,
    })) return (await readGenerationState(id))!;
    const outputUrl = task?.generated?.[0] || generation.output_url;
    const reportedError = providerErrorMessage(task?.error);
    const timedOut = !outputUrl
      && !reportedError
      && !completedGenerationStatuses.has(providerStatus)
      && !failedGenerationStatuses.has(providerStatus)
      && generationTimedOut(generation.created_at, generation.media_type);
    if (timedOut) {
      await timeoutGeneration(id, generation.media_type);
      const timedOutGeneration = (await readGenerationState(id))!;
      await updateGenerationNode(timedOutGeneration, { error: timedOutGeneration.error });
      return timedOutGeneration;
    }

    const completedWithoutOutput = completedGenerationStatuses.has(providerStatus) && !outputUrl;
    const emptyResultExpired = completedWithoutOutput && Date.now() - new Date(generation.created_at).getTime() >= emptyCompletedGraceMs;
    const status = reportedError || failedGenerationStatuses.has(providerStatus)
      ? "failed"
      : completedWithoutOutput
        ? emptyResultExpired ? "failed" : "finalizing"
        : providerStatus;
    const error = reportedError || (emptyResultExpired ? emptyCompletedMessage : null);
    const now = new Date().toISOString();
    await db.prepare("UPDATE generations SET status = ?, output_url = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, outputUrl, error, now, id);
    if (status === "failed") {
      await (await usageAuthority()).releaseGeneration(id, "provider_generation_failed");
      await updateGenerationNode((await readGenerationState(id))!, { error });
    }
    if (outputUrl) {
      await persistGenerationOutput(id, outputUrl);
      if (completedGenerationStatuses.has(providerStatus)) await (await usageAuthority()).settleGeneration(id);
    }
    generation = (await readGenerationState(id))!;
    return generation;
  } catch (error) {
    if (error instanceof KieRateLimitError) return (await readGenerationState(id))!;
    if (generationTimedOut(generation.created_at, generation.media_type)) {
      await timeoutGeneration(id, generation.media_type);
      const timedOutGeneration = (await readGenerationState(id))!;
      await updateGenerationNode(timedOutGeneration, { error: timedOutGeneration.error });
      return timedOutGeneration;
    }
    throw error;
  }
}

export async function finalizeGenerationFromWebhook(input: {
  generationId: string;
  status: string;
  outputUrl?: string | null;
  error?: string | null;
}) {
  const current = await readGenerationState(input.generationId);
  if (current && ["cancelled", "canceled"].includes(String(current.status).toLowerCase())) return current;
  const normalizedStatus = input.status.toLowerCase();
  if (input.error || failedGenerationStatuses.has(normalizedStatus)) {
    await (await usageAuthority()).releaseGeneration(input.generationId, "provider_webhook_failed");
    const failed = await readGenerationState(input.generationId);
    if (failed) await updateGenerationNode(failed, { error: input.error });
    return failed;
  }
  if (input.outputUrl) {
    await persistGenerationOutput(input.generationId, input.outputUrl);
    if (completedGenerationStatuses.has(normalizedStatus)) await (await usageAuthority()).settleGeneration(input.generationId);
  }
  return await readGenerationState(input.generationId);
}
