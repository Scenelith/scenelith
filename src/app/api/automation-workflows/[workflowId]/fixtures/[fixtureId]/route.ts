import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { deleteAutomationWorkflowFixture } from "@/lib/automation-workflows/fixtures";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
import { appendAuditEvent } from "@/lib/audit-log";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ workflowId: string; fixtureId: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-fixture-write", identity: auth.user.id, limit: 120, windowSeconds: 600 });
  if (limited) return limited;
  const params = await context.params;
  let result;
  try { result = await deleteAutomationWorkflowFixture({ userId: auth.user.id, ...params }); }
  catch (error) { return automationApiErrorResponse(error, "Fixture could not be deleted"); }
  if (!result?.deleted) return Response.json({ error: "Fixture not found" }, { status: 404 });
  await appendAuditEvent({ workspaceId: result.workspaceId, actorUserId: auth.user.id, action: "automation.fixture.deleted", targetType: "automation_fixture", targetId: result.id, metadata: { workflowId: params.workflowId } });
  return Response.json(result);
}
