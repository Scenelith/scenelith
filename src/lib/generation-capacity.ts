import { usageSummary } from "@/modules/usage";
import { db, usageWorkspaceForUserProject } from "./postgres-db";

export async function activeGenerationCount(workspaceId: string) {
  const active = await db.prepare(`SELECT COUNT(*) AS count FROM generations g
    WHERE g.usage_workspace_id = ?
      AND lower(g.status) NOT IN ('failed','fail','error','cancelled','canceled','completed','complete','succeeded','success')
      AND g.output_url IS NULL AND g.output_asset_id IS NULL`).get(workspaceId) as { count: number };
  return Number(active.count);
}

export async function generationCapacity(userId: string, projectId: string) {
  const workspaceId = await usageWorkspaceForUserProject(userId, projectId);
  if (!workspaceId) return null;
  const [usage, active] = await Promise.all([usageSummary(workspaceId), activeGenerationCount(workspaceId)]);
  return { concurrency: usage.generationConcurrency, available: Math.max(0, usage.generationConcurrency - active), retryAfterMs: 3000 };
}
