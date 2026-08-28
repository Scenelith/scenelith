import { requireApiUser } from "@/lib/auth";
import { getAutomationWorkflowNodeRunDetails } from "@/lib/automation-workflows/runs";

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/automation-runs/[runId]/nodes/[nodeId]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { runId, nodeId } = await context.params;
  const attempts = await getAutomationWorkflowNodeRunDetails(auth.user.id, runId, nodeId);
  if (!attempts) return Response.json({ error: "Automation run not found" }, { status: 404 });
  return Response.json({ attempts }, { headers: { "cache-control": "no-store" } });
}
