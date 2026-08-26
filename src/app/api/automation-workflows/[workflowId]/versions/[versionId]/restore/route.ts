import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { restoreAutomationWorkflowVersion } from "@/lib/automation-workflows/repository";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/automation-workflows/[workflowId]/versions/[versionId]/restore">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-workflow-restore", identity: auth.user.id, limit: 20, windowSeconds: 600 });
  if (limited) return limited;
  const { workflowId, versionId } = await context.params;
  try {
    const detail = await restoreAutomationWorkflowVersion({ userId: auth.user.id, workflowId, versionId });
    if (!detail) return Response.json({ error: "Workflow is read-only or unavailable" }, { status: 404 });
    return Response.json(detail);
  } catch (error) {
    return automationApiErrorResponse(error, "Workflow version is unavailable", 409);
  }
}
