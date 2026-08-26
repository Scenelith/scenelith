import { requireApiUser } from "@/lib/auth";
import { db, userCanAccessProject } from "@/lib/postgres-db";
import { publicGenerationErrorMessage } from "@/lib/generation-lifecycle";
import type { BackgroundTaskRecord } from "@/lib/types";

export const runtime = "nodejs";

const generationComplete = new Set(["completed", "complete", "succeeded", "success"]);
const generationFailed = new Set(["fail", "failed", "error", "cancelled", "canceled"]);

function generationTaskStatus(value: string): BackgroundTaskRecord["status"] {
  const status = value.toLowerCase();
  if (generationComplete.has(status)) return "completed";
  if (generationFailed.has(status)) return "failed";
  if (["created", "queued", "dispatching"].includes(status)) return "queued";
  return "running";
}

function generationProgress(row: { status: string; media_type: string; created_at: string; output_asset_id: string | null; output_url: string | null }) {
  const status = generationTaskStatus(row.status);
  if (status === "completed" || status === "failed") return 100;
  if (row.output_asset_id || row.output_url) return 96;
  if (status === "queued") return row.status.toLowerCase() === "dispatching" ? 9 : 4;
  const elapsed = Math.max(0, Date.now() - new Date(row.created_at).getTime());
  const expected = row.media_type === "video" ? 8 * 60_000 : 75_000;
  return Math.min(91, 16 + Math.round((1 - Math.exp(-elapsed / expected)) * 75));
}

function generationStageLabel(row: { status: string; media_type: string; output_asset_id: string | null; output_url: string | null }) {
  const taskStatus = generationTaskStatus(row.status);
  if (taskStatus === "completed") return `${row.media_type === "video" ? "Video" : "Image"} ready`;
  if (taskStatus === "failed") return "Generation stopped";
  if (row.output_asset_id || row.output_url || row.status.toLowerCase() === "finalizing") return "Saving the finished result";
  if (taskStatus === "queued") return row.status.toLowerCase() === "dispatching" ? "Sending to generation" : "Waiting for a generation slot";
  return `Generating ${row.media_type === "video" ? "video" : "image"}`;
}

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const generations = await db.prepare(`SELECT g.*, p.name AS project_name
    FROM generations g
    JOIN projects p ON p.id = g.project_id
    WHERE g.requested_by_user_id = ?
      AND (lower(g.status) NOT IN ('completed','complete','succeeded','success','fail','failed','error','cancelled','canceled')
        OR g.updated_at >= ?)
    ORDER BY CASE WHEN lower(g.status) IN ('completed','complete','succeeded','success','fail','failed','error','cancelled','canceled') THEN 1 ELSE 0 END,
      g.created_at DESC
    LIMIT 32`).all(auth.user.id, new Date(Date.now() - 48 * 60 * 60_000).toISOString()) as Array<{
      id: string; project_id: string; project_name: string; node_id: string; status: string; media_type: string;
      model_id: string; operation: string; output_url: string | null; output_asset_id: string | null; error: string | null;
      credit_cost: number; created_at: string; updated_at: string;
    }>;

  const automations = await db.prepare(`SELECT job.*, project.name AS project_name
    FROM tiktok_automation_jobs job
    JOIN projects project ON project.id = job.project_id
    WHERE job.user_id = ?
      AND (job.status IN ('queued','running') OR job.updated_at >= ?)
    ORDER BY CASE WHEN job.status IN ('queued','running') THEN 0 ELSE 1 END, job.created_at DESC
    LIMIT 20`).all(auth.user.id, new Date(Date.now() - 48 * 60 * 60_000).toISOString()) as Array<{
      id: string; project_id: string; project_name: string; source_node_id: string; status: string; stage_label: string;
      progress: number; error: string | null; created_at: string; updated_at: string;
    }>;

  const workflowRuns = await db.prepare(`SELECT run.*, project.name AS project_name, workflow.name AS workflow_name
    FROM automation_runs run
    JOIN projects project ON project.id = run.project_id
    JOIN automation_workflows workflow ON workflow.id = run.workflow_id
    WHERE run.user_id = ?
      AND (run.status IN ('queued','running') OR run.updated_at >= ?)
    ORDER BY CASE WHEN run.status IN ('queued','running') THEN 0 ELSE 1 END, run.created_at DESC
    LIMIT 20`).all(auth.user.id, new Date(Date.now() - 48 * 60 * 60_000).toISOString()) as Array<{
      id: string; project_id: string; project_name: string; workflow_id: string; workflow_name: string; status: string;
      stage_label: string; progress: number; error: string | null; charged_credits: number; created_at: string; updated_at: string;
    }>;

  const visibleGenerations = [];
  for (const row of generations) {
    if (await userCanAccessProject(auth.user.id, row.project_id)) visibleGenerations.push(row);
  }
  const generationTasks: BackgroundTaskRecord[] = visibleGenerations.map((row) => ({
    id: row.id,
    kind: "generation",
    projectId: row.project_id,
    projectName: row.project_name,
    nodeId: row.node_id,
    title: row.operation === "edit" ? "Image edit" : row.media_type === "video" ? "Video generation" : "Image generation",
    status: generationTaskStatus(row.status),
    stageLabel: generationStageLabel(row),
    progress: generationProgress(row),
    mediaType: row.media_type === "video" ? "video" : "image",
    modelId: row.model_id,
    operation: row.operation === "edit" ? "edit" : "generation",
    outputUrl: row.output_asset_id ? `/api/assets/${row.output_asset_id}` : row.output_url,
    assetId: row.output_asset_id,
    creditCost: Number(row.credit_cost || 0),
    error: row.error ? publicGenerationErrorMessage(row.error) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const visibleAutomations = [];
  for (const row of automations) {
    if (await userCanAccessProject(auth.user.id, row.project_id)) visibleAutomations.push(row);
  }
  const automationTasks: BackgroundTaskRecord[] = visibleAutomations.map((row) => ({
    id: row.id,
    kind: "automation",
    projectId: row.project_id,
    projectName: row.project_name,
    nodeId: row.source_node_id,
    title: "TikTok automation",
    status: row.status === "completed" ? "completed" : row.status === "failed" || row.status === "cancelled" ? "failed" : row.status === "queued" ? "queued" : "running",
    stageLabel: row.stage_label,
    progress: Math.max(0, Math.min(100, Number(row.progress || 0))),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const visibleWorkflowRuns = [];
  for (const row of workflowRuns) {
    if (await userCanAccessProject(auth.user.id, row.project_id)) visibleWorkflowRuns.push(row);
  }
  const workflowTasks: BackgroundTaskRecord[] = visibleWorkflowRuns.map((row) => ({
    id: row.id,
    kind: "automation",
    projectId: row.project_id,
    projectName: row.project_name,
    nodeId: row.workflow_id,
    title: row.workflow_name,
    status: row.status === "completed" ? "completed" : row.status === "failed" || row.status === "cancelled" ? "failed" : row.status === "queued" ? "queued" : "running",
    stageLabel: row.stage_label,
    progress: Math.max(0, Math.min(100, Number(row.progress || 0))),
    creditCost: Number(row.charged_credits || 0),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const tasks = [...generationTasks, ...automationTasks, ...workflowTasks]
    .sort((left, right) => {
      const leftActive = left.status === "queued" || left.status === "running";
      const rightActive = right.status === "queued" || right.status === "running";
      return Number(rightActive) - Number(leftActive) || Date.parse(right.createdAt) - Date.parse(left.createdAt);
    })
    .slice(0, 24);
  return Response.json({
    tasks,
    activeCount: tasks.filter((task) => task.status === "queued" || task.status === "running").length,
  });
}
