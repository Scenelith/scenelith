import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { appendAuditEvent } from "@/lib/audit-log";
import { automationFixtureInputSchema, createAutomationWorkflowFixture, listAutomationWorkflowFixtures } from "@/lib/automation-workflows/fixtures";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  let fixtures;
  try { fixtures = await listAutomationWorkflowFixtures(auth.user.id, (await context.params).workflowId); }
  catch (error) { return automationApiErrorResponse(error, "Fixtures could not be listed"); }
  if (!fixtures) return Response.json({ error: "Workflow not found" }, { status: 404 });
  return Response.json({ fixtures }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 1_000_000) return Response.json({ error: "Fixture payload is too large" }, { status: 413 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-fixture-write", identity: auth.user.id, limit: 120, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = automationFixtureInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Fixture is invalid" }, { status: 400 });
  const { workflowId } = await context.params;
  try {
    const fixture = await createAutomationWorkflowFixture({ userId: auth.user.id, workflowId, value: parsed.data });
    if (!fixture) return Response.json({ error: "Workflow not found" }, { status: 404 });
    await appendAuditEvent({ workspaceId: fixture.workspaceId, actorUserId: auth.user.id, action: "automation.fixture.created", targetType: "automation_fixture", targetId: fixture.id, metadata: { workflowId } });
    return Response.json({ fixture }, { status: 201 });
  } catch (error) {
    return automationApiErrorResponse(error, "Fixture could not be saved");
  }
}
