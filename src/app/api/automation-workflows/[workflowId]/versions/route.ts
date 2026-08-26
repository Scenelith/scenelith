import { requireApiUser } from "@/lib/auth";
import { listAutomationWorkflowVersions } from "@/lib/automation-workflows/repository";

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/automation-workflows/[workflowId]/versions">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { workflowId } = await context.params;
  const versions = await listAutomationWorkflowVersions(auth.user.id, workflowId);
  if (!versions) return Response.json({ error: "Workflow not found" }, { status: 404 });
  return Response.json({ versions }, { headers: { "cache-control": "private, no-store" } });
}
