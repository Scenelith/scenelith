import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { AutomationWorkflowDraftConflictError, getAutomationWorkflow, saveAutomationWorkflowDraft } from "@/lib/automation-workflows/repository";
import { automationWorkflowGraphSchema } from "@/lib/automation-workflows/types";
import { automationRunInputFields } from "@/lib/automation-workflows/validation";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
import { automationCapabilitiesForWorkspace } from "@/lib/automation-workflows/permissions";

export const runtime = "nodejs";

const saveSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  changeNote: z.string().trim().max(500).optional(),
  baseDraftVersionId: z.string().min(1).nullable(),
  graph: automationWorkflowGraphSchema,
});

export async function GET(_request: Request, context: RouteContext<"/api/automation-workflows/[workflowId]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { workflowId } = await context.params;
  const detail = await getAutomationWorkflow(auth.user.id, workflowId);
  if (!detail) return Response.json({ error: "Workflow not found" }, { status: 404 });
  const capabilities = await automationCapabilitiesForWorkspace(auth.user.id, detail.workflow.workspaceId);
  const canViewDraft = capabilities.edit || capabilities.publish;
  if (!canViewDraft && !detail.published) return Response.json({ error: "Workflow not found" }, { status: 404 });
  const visible = canViewDraft ? detail : { ...detail, draft: null };
  const productionRunInputs = detail.published ? automationRunInputFields(detail.published.graph) : [];
  const draftRunInputs = canViewDraft && detail.draft ? automationRunInputFields(detail.draft.graph) : [];
  return Response.json({
    ...visible,
    capabilities,
    runInputs: productionRunInputs,
    draftRunInputs,
  }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: Request, context: RouteContext<"/api/automation-workflows/[workflowId]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-workflow-write", identity: auth.user.id, limit: 60, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Workflow graph is invalid" }, { status: 400 });
  const { workflowId } = await context.params;
  let detail;
  try {
    detail = await saveAutomationWorkflowDraft({ userId: auth.user.id, workflowId, ...parsed.data });
  } catch (error) {
    if (error instanceof AutomationWorkflowDraftConflictError) return Response.json({ error: error.message, code: "DRAFT_CONFLICT" }, { status: 409 });
    return automationApiErrorResponse(error, "Workflow could not be saved");
  }
  if (!detail) return Response.json({ error: "Workflow is read-only or unavailable" }, { status: 404 });
  return Response.json(detail);
}
