import { usageAuthority } from "@/modules/usage";
import { db } from "./postgres-db";

const imageTimeoutMs = 5 * 60 * 1000;
const videoTimeoutMs = 45 * 60 * 1000;
const terminalStatuses = new Set(["completed", "complete", "succeeded", "success", "fail", "failed", "error", "cancelled", "canceled"]);
const lifecycleSweepIntervalMs = 30 * 1000;

type LifecycleGlobal = typeof globalThis & {
  scenelithGenerationLifecycleTimer?: ReturnType<typeof setInterval>;
};

const shared = globalThis as LifecycleGlobal;

export function generationTimeoutMs(mediaType: string) {
  return mediaType === "video" ? videoTimeoutMs : imageTimeoutMs;
}

export function generationTimedOut(createdAt: string, mediaType: string, now = Date.now()) {
  const createdAtMs = new Date(createdAt).getTime();
  return Number.isFinite(createdAtMs) && now - createdAtMs >= generationTimeoutMs(mediaType);
}

export function generationTimeoutMessage(mediaType: string) {
  const minutes = Math.round(generationTimeoutMs(mediaType) / 60_000);
  return `This ${mediaType === "video" ? "video" : "image"} was not completed within ${minutes} minutes. Credits were returned; run the node again.`;
}

export function isGenerationTimeoutError(value: unknown) {
  return typeof value === "string"
    && (value.startsWith("This image was not completed within ")
      || value.startsWith("This video was not completed within ")
      || value.startsWith("Kie.ai did not finish this "))
    && value.includes("Credits were returned");
}

export function publicGenerationErrorMessage(value: string) {
  return value
    .replace(/\bKie(?:\.ai)?(?:\s+provider)?\b/gi, "Generation service")
    .replace(/\bprovider\b/gi, "generation service");
}

export async function timeoutGeneration(generationId: string, mediaType: string, now = Date.now()) {
  return await db.transaction(async () => {
    const generation = await db.prepare("SELECT status, output_url, output_asset_id FROM generations WHERE id = ?").get(generationId) as
      | { status: string; output_url: string | null; output_asset_id: string | null }
      | undefined;
    if (!generation || generation.output_url || generation.output_asset_id || terminalStatuses.has(generation.status.toLowerCase())) return false;
    const message = generationTimeoutMessage(mediaType);
    const changed = await db.prepare(`UPDATE generations SET status = 'failed', error = ?, updated_at = ?
      WHERE id = ? AND output_url IS NULL AND output_asset_id IS NULL`).run(message, new Date(now).toISOString(), generationId);
    if (changed.changes !== 1) return false;
    await db.prepare(`UPDATE generation_dispatch_jobs SET status = 'failed', last_error = ?, updated_at = ?
      WHERE generation_id = ? AND status IN ('queued', 'dispatching', 'dispatched')`).run(message, new Date(now).toISOString(), generationId);
    await (await usageAuthority()).releaseGeneration(generationId, "provider_timeout");
    return true;
  })();
}

async function expireRows(active: Array<{ id: string; media_type: string; created_at: string }>, now: number) {
  let expired = 0;
  for (const generation of active) {
    if (generationTimedOut(generation.created_at, generation.media_type, now) && await timeoutGeneration(generation.id, generation.media_type, now)) expired += 1;
  }
  return expired;
}

export async function expireStaleGenerations(workspaceId: string, now = Date.now()) {
  const active = await db.prepare(`SELECT g.id, g.media_type, g.created_at
    FROM generations g
    JOIN projects p ON p.id = g.project_id
    WHERE p.workspace_id = ?
      AND g.output_url IS NULL
      AND g.output_asset_id IS NULL
      AND lower(g.status) NOT IN ('completed','complete','succeeded','success','fail','failed','error','cancelled','canceled')
    ORDER BY g.created_at ASC
    LIMIT 500`).all(workspaceId) as Array<{ id: string; media_type: string; created_at: string }>;
  return await expireRows(active, now);
}

export async function expireAllStaleGenerations(now = Date.now()) {
  const active = await db.prepare(`SELECT id, media_type, created_at
    FROM generations
    WHERE output_url IS NULL
      AND output_asset_id IS NULL
      AND lower(status) NOT IN ('completed','complete','succeeded','success','fail','failed','error','cancelled','canceled')
    ORDER BY created_at ASC
    LIMIT 1000`).all() as Array<{ id: string; media_type: string; created_at: string }>;
  return await expireRows(active, now);
}

export function ensureGenerationLifecycleSweeper() {
  if (shared.scenelithGenerationLifecycleTimer) return;
  shared.scenelithGenerationLifecycleTimer = setInterval(async () => {
    try {
      const expired = await expireAllStaleGenerations();
      if (expired > 0) console.warn("[generation:timeout-sweep]", JSON.stringify({ expired }));
    } catch (error) {
      console.error("[generation:timeout-sweep-failed]", error);
    }
  }, lifecycleSweepIntervalMs);
  shared.scenelithGenerationLifecycleTimer.unref?.();
}
