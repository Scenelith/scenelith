import { randomUUID } from "node:crypto";
import { usageAuthority, taskCreditUsage } from "@/modules/usage";
import { queuedGenerationPosition, type GenerationDispatchPayload } from "./generation-dispatch";
import { expireStaleGenerations } from "./generation-lifecycle";
import { generationCreditCost } from "./generation-pricing";
import { db, usageWorkspaceForUserProject } from "./postgres-db";

export type GenerationAdmissionReference = {
  path: string;
  mimeType: string;
  label: string;
  role?: string;
  durationSeconds?: number;
};

export type GenerationAdmissionInput = {
  userId: string;
  projectId: string;
  nodeId: string;
  prompt: string;
  model: {
    id: string;
    mediaType: "image" | "video";
    providerPath: string;
  };
  references: GenerationAdmissionReference[];
  operation: "generation" | "edit";
  aspectRatio: string;
  resolution: string;
  duration: string;
  generateAudio: boolean;
  hasVideoInput: boolean;
  inputVideoDurationSeconds: number;
  beforeAdmit?: () => Promise<void>;
  targetClipId?: string;
  targetSourceAssetId?: string;
};

export type GenerationAdmissionResult =
  | { ok: true; generationId: string; status: "queued"; queuePosition: number | null; creditCost: number; creditUsage?: import("@/modules/usage/contracts").TaskCreditUsage }
  | { ok: false; status: 402 | 404 | 409 | 429 | 500; error: string; code: string; retryAfterMs?: number; concurrency?: number; requiredCredits?: number; generationId?: string };

export function generationDispatchPayload(input: GenerationAdmissionInput): GenerationDispatchPayload {
  return {
    modelId: input.model.id,
    prompt: input.prompt,
    references: input.references,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    duration: input.duration,
    generateAudio: input.generateAudio,
    targetClipId: input.targetClipId,
    targetSourceAssetId: input.targetSourceAssetId,
  };
}

/**
 * The single admission boundary used by interactive generations and automation
 * workers. Provider-specific validation happens before this function; durable
 * persistence, concurrency, usage reservation and dispatch happen only here.
 */
export async function admitGeneration(input: GenerationAdmissionInput): Promise<GenerationAdmissionResult> {
  const workspaceId = await usageWorkspaceForUserProject(input.userId, input.projectId);
  if (!workspaceId) return { ok: false, status: 404, error: "Canvas not found", code: "PROJECT_NOT_FOUND" };
  await expireStaleGenerations(workspaceId);

  const generationId = randomUUID();
  const creditCost = generationCreditCost(
    input.model.id,
    input.resolution,
    input.duration,
    input.references.length,
    {
      generateAudio: input.generateAudio,
      hasVideoInput: input.hasVideoInput,
      inputVideoDurationSeconds: input.inputVideoDurationSeconds,
    },
  );
  const now = new Date().toISOString();
  const usage = await usageAuthority();
  const concurrency = (await usage.summary(workspaceId)).generationConcurrency;
  const admitted = await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`generation-admission:${workspaceId}`);
    // One active request per Master prevents retries (and simultaneous UI/MCP
    // launches) from reserving credits twice or racing the Master's output state.
    if (input.targetClipId) {
      const existing = await db.prepare(`SELECT id FROM generations WHERE project_id = ? AND node_id = ?
        AND lower(status) NOT IN ('failed','fail','error','cancelled','canceled','completed','complete','succeeded','success')
        AND output_url IS NULL AND output_asset_id IS NULL LIMIT 1`).get(input.projectId, input.nodeId) as { id: string } | undefined;
      if (existing) return { existingGenerationId: existing.id };
    }
    await input.beforeAdmit?.();
    const active = await db.prepare(`SELECT COUNT(*) AS count FROM generations g
      WHERE g.usage_workspace_id = ?
        AND lower(g.status) NOT IN ('failed','fail','error','cancelled','canceled','completed','complete','succeeded','success')
        AND g.output_url IS NULL
        AND g.output_asset_id IS NULL`).get(workspaceId) as { count: number };
    if (active.count >= concurrency) return false;
    await db.prepare(
      `INSERT INTO generations (id, project_id, usage_workspace_id, requested_by_user_id, node_id, prompt, status, model_id, media_type, provider_path, operation, aspect_ratio, resolution, credit_cost, reference_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      generationId,
      input.projectId,
      workspaceId,
      input.userId,
      input.nodeId,
      input.prompt,
      input.model.id,
      input.model.mediaType,
      input.model.providerPath,
      input.operation,
      input.aspectRatio,
      input.resolution,
      creditCost,
      input.references.length,
      now,
      now,
    );
    return true;
  })();

  if (typeof admitted === "object") return { ok: false, status: 409, code: "GENERATION_ALREADY_RUNNING",
    error: "This Video Master already has an active generation. Poll generationId instead of starting another one.", generationId: admitted.existingGenerationId };

  if (!admitted) {
    return {
      ok: false,
      status: 429,
      error: `This instance runs ${concurrency} generation${concurrency === 1 ? "" : "s"} at a time`,
      code: "GENERATION_CONCURRENCY_LIMIT",
      concurrency,
      retryAfterMs: 3000,
    };
  }

  const reserved = await usage.reserveGeneration({
    generationId,
    workspaceId,
    userId: input.userId,
    credits: creditCost,
    metadata: {
      operation: input.operation,
      nodeId: input.nodeId,
      modelId: input.model.id,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      duration: input.duration,
      referenceCount: input.references.length,
      generateAudio: input.generateAudio,
      hasVideoInput: input.hasVideoInput,
      inputVideoDurationSeconds: input.inputVideoDurationSeconds,
    },
  });
  if (!reserved) {
    await db.prepare("UPDATE generations SET status = 'failed', error = 'Not enough generation credits', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), generationId);
    return {
      ok: false,
      status: 402,
      error: `This generation needs ${creditCost} usage units`,
      code: "INSUFFICIENT_USAGE",
      requiredCredits: creditCost,
    };
  }

  try {
    const payload = generationDispatchPayload(input);
    await db.prepare(
      `INSERT INTO generation_dispatch_jobs
       (generation_id, payload_json, status, attempts, available_at, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, ?, ?, ?)`,
    ).run(generationId, JSON.stringify(payload), now, now, now);
    const charges = await taskCreditUsage([{ id: generationId, kind: "generation" }]);
    return { ok: true, generationId, status: "queued", queuePosition: await queuedGenerationPosition(generationId), creditCost, creditUsage: charges[`generation:${generationId}`] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue generation";
    await db.prepare("UPDATE generations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(message, new Date().toISOString(), generationId);
    await usage.releaseGeneration(generationId, "dispatch_queue_failed");
    return { ok: false, status: 500, error: "Could not queue generation", code: "DISPATCH_QUEUE_FAILED" };
  }
}
