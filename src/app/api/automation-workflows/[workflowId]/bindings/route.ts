import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { bindAutomationCredential, bindAutomationSubworkflow, unbindAutomationWorkflowSlot } from "@/lib/automation-workflows/credentials";
import { getAutomationWorkflow } from "@/lib/automation-workflows/repository";
import { db } from "@/lib/postgres-db";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { appendAuditEvent } from "@/lib/audit-log";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
import { canPerformAutomationAction } from "@/lib/automation-workflows/permissions";

export const runtime = "nodejs";
const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("credential"), slotKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), credentialId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("subworkflow"), slotKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), targetWorkflowId: z.string().min(1) }).strict(),
]);

export async function GET(_request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  const { workflowId } = await context.params;
  const workflow = await getAutomationWorkflow(auth.user.id, workflowId);
  if (!workflow) return Response.json({ error: "Workflow not found" }, { status: 404 });
  if (!await canPerformAutomationAction(auth.user.id, workflow.workflow.workspaceId, "automation.edit")) return Response.json({ error: "This workspace role cannot edit automations", code: "AUTOMATION_PERMISSION_DENIED", permission: "automation.edit" }, { status: 403 });
  const canManageCredentials = await canPerformAutomationAction(auth.user.id, workflow.workflow.workspaceId, "automation.credentials.manage");
  const bindings = await db.prepare(`SELECT binding.slot_key AS "slotKey", binding.binding_type AS type,
    binding.credential_id AS "credentialId", credential.name AS "credentialName", binding.target_workflow_id AS "targetWorkflowId", target.name AS "targetWorkflowName"
    FROM automation_workflow_bindings binding
    LEFT JOIN automation_credentials credential ON credential.id = binding.credential_id
    LEFT JOIN automation_workflows target ON target.id = binding.target_workflow_id
    WHERE binding.workflow_id = ? ORDER BY binding.slot_key`).all(workflowId) as Array<Record<string, unknown>>;
  return Response.json({ bindings: bindings.map((binding) => binding.type === "credential" && !canManageCredentials
    ? { ...binding, credentialId: null, credentialName: null, credentialConnected: true }
    : binding) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-binding-update", identity: auth.user.id, limit: 120, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Credential slot and credential are required" }, { status: 400 });
  const { workflowId } = await context.params;
  const workflow = await getAutomationWorkflow(auth.user.id, workflowId);
  if (!workflow) return Response.json({ error: "Workflow not found" }, { status: 404 });
  let binding;
  try {
    binding = parsed.data.type === "credential"
      ? await bindAutomationCredential({ userId: auth.user.id, workflowId, workspaceId: workflow.workflow.workspaceId, slotKey: parsed.data.slotKey, credentialId: parsed.data.credentialId })
      : await bindAutomationSubworkflow({ userId: auth.user.id, workflowId, workspaceId: workflow.workflow.workspaceId, slotKey: parsed.data.slotKey, targetWorkflowId: parsed.data.targetWorkflowId });
  } catch (error) {
    return automationApiErrorResponse(error, "Could not save deployment binding");
  }
  await appendAuditEvent({ workspaceId: workflow.workflow.workspaceId, actorUserId: auth.user.id, action: "automation.binding.updated", targetType: "automation_workflow", targetId: workflowId, metadata: { type: parsed.data.type, slotKey: parsed.data.slotKey } });
  return Response.json({ binding }, { status: 201 });
}

export async function DELETE(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-binding-update", identity: auth.user.id, limit: 120, windowSeconds: 600 });
  if (limited) return limited;
  const slotKey = new URL(request.url).searchParams.get("slotKey") || "";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(slotKey)) return Response.json({ error: "Deployment slot is invalid" }, { status: 400 });
  const { workflowId } = await context.params;
  const workflow = await getAutomationWorkflow(auth.user.id, workflowId);
  if (!workflow) return Response.json({ error: "Workflow not found" }, { status: 404 });
  let result;
  try { result = await unbindAutomationWorkflowSlot({ userId: auth.user.id, workflowId, workspaceId: workflow.workflow.workspaceId, slotKey }); }
  catch (error) { return automationApiErrorResponse(error, "Could not delete deployment binding"); }
  if (!result) return Response.json({ error: "Workflow not found" }, { status: 404 });
  await appendAuditEvent({ workspaceId: workflow.workflow.workspaceId, actorUserId: auth.user.id, action: "automation.binding.deleted", targetType: "automation_workflow", targetId: workflowId, metadata: { slotKey } });
  return Response.json(result);
}
