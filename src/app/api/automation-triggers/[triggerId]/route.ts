import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { deleteAutomationWorkflowTrigger, setAutomationWorkflowTriggerStatus } from "@/lib/automation-workflows/triggers";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { appendAuditEvent } from "@/lib/audit-log";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
export const runtime = "nodejs";
const schema = z.object({ status: z.enum(["active", "paused"]) }).strict();
export async function PATCH(request: Request, context: { params: Promise<{ triggerId: string }> }) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-trigger-update", identity: auth.user.id, limit: 60, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Status is invalid" }, { status: 400 });
  let result;
  try { result = await setAutomationWorkflowTriggerStatus(auth.user.id, (await context.params).triggerId, parsed.data.status); }
  catch (error) { return automationApiErrorResponse(error, "Trigger cannot be activated"); }
  if (!result) return Response.json({ error: "Trigger not found" }, { status: 404 });
  await appendAuditEvent({ workspaceId: result.workspaceId, actorUserId: auth.user.id, action: "automation.trigger.status_changed", targetType: "automation_trigger", targetId: result.id, metadata: { workflowId: result.workflowId, status: result.status } });
  return Response.json(result);
}

export async function DELETE(request: Request, context: { params: Promise<{ triggerId: string }> }) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-trigger-update", identity: auth.user.id, limit: 60, windowSeconds: 600 });
  if (limited) return limited;
  let result;
  try { result = await deleteAutomationWorkflowTrigger(auth.user.id, (await context.params).triggerId); }
  catch (error) { return automationApiErrorResponse(error, "Trigger could not be deleted"); }
  if (!result) return Response.json({ error: "Trigger not found" }, { status: 404 });
  await appendAuditEvent({ workspaceId: result.workspaceId, actorUserId: auth.user.id, action: "automation.trigger.deleted", targetType: "automation_trigger", targetId: result.id, metadata: { workflowId: result.workflowId } });
  return Response.json({ id: result.id, deleted: true });
}
