import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { cancelAutomationWorkflowRun, getAutomationWorkflowRun } from "@/lib/automation-workflows/runs";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/automation-runs/[runId]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { runId } = await context.params;
  const run = await getAutomationWorkflowRun(auth.user.id, runId);
  if (!run) return Response.json({ error: "Automation run not found" }, { status: 404 });
  return Response.json({ run }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request, context: RouteContext<"/api/automation-runs/[runId]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-run-cancel", identity: auth.user.id, limit: 120, windowSeconds: 600 });
  if (limited) return limited;
  const { runId } = await context.params;
  try {
    if (!await cancelAutomationWorkflowRun(auth.user.id, runId)) return Response.json({ error: "Automation run is already complete or unavailable" }, { status: 409 });
  } catch (error) { return automationApiErrorResponse(error, "Automation run could not be cancelled"); }
  return Response.json({ cancelled: true });
}
