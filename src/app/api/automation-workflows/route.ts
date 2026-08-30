import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { createAutomationWorkflow, listAutomationWorkflows, publishAutomationWorkflow } from "@/lib/automation-workflows/repository";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
import { automationCapabilitiesForWorkspace } from "@/lib/automation-workflows/permissions";
import { db, workspaceIdForProject } from "@/lib/postgres-db";

export const runtime = "nodejs";

const createSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  sourceWorkflowId: z.string().min(1).optional(),
});

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const projectId = new URL(request.url).searchParams.get("projectId") || "";
  if (!projectId) return Response.json({ error: "Canvas is required" }, { status: 400 });
  const workflows = await listAutomationWorkflows(auth.user.id, projectId);
  if (!workflows) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const workspaceId = await workspaceIdForProject(projectId);
  const capabilities = workspaceId ? await automationCapabilitiesForWorkspace(auth.user.id, workspaceId) : null;
  const visibleWorkflows = capabilities?.edit || capabilities?.publish ? workflows : workflows
    .filter((workflow) => workflow.status === "system" || Boolean(workflow.publishedVersionId))
    .map((workflow) => ({ ...workflow, status: workflow.status === "system" ? "system" as const : "published" as const, draftVersionId: null }));
  const alertRows = capabilities?.manageTriggers && workspaceId
    ? await db.prepare(`SELECT workflow_id, COUNT(*) AS count FROM automation_trigger_alerts
        WHERE workspace_id = ? AND project_id = ? AND status = 'open' GROUP BY workflow_id`).all(workspaceId, projectId) as Array<{ workflow_id: string; count: number }>
    : [];
  const openTriggerAlerts = Object.fromEntries(alertRows.map((row) => [row.workflow_id, Number(row.count || 0)]));
  return Response.json({ workflows: visibleWorkflows, capabilities, openTriggerAlerts }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-workflow-write", identity: auth.user.id, limit: 60, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Name and canvas are required" }, { status: 400 });
  let detail;
  try {
    detail = await createAutomationWorkflow({ userId: auth.user.id, ...parsed.data });
    if (detail?.draft?.validation.valid) {
      const capabilities = await automationCapabilitiesForWorkspace(auth.user.id, detail.workflow.workspaceId);
      if (capabilities.publish) detail = (await publishAutomationWorkflow(auth.user.id, detail.workflow.id))?.detail || detail;
    }
  }
  catch (error) { return automationApiErrorResponse(error, "Workflow could not be created"); }
  if (!detail) return Response.json({ error: "Workflow source or canvas not found" }, { status: 404 });
  return Response.json(detail, { status: 201 });
}
