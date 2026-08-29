import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { publishAutomationWorkflow } from "@/lib/automation-workflows/repository";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/automation-workflows/[workflowId]/publish">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-workflow-publish", identity: auth.user.id, limit: 20, windowSeconds: 600 });
  if (limited) return limited;
  const { workflowId } = await context.params;
  let result;
  try { result = await publishAutomationWorkflow(auth.user.id, workflowId); }
  catch (error) { return automationApiErrorResponse(error, "Workflow could not be taken live"); }
  if (!result) return Response.json({ error: "Workflow is read-only, unavailable or has no draft" }, { status: 404 });
  if (!result.validation.valid) return Response.json({ error: "Fix validation issues before going live", ...result }, { status: 422 });
  return Response.json(result.detail);
}
