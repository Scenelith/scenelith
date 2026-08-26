import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { deleteAutomationCredential, rotateAutomationCredential } from "@/lib/automation-workflows/credentials";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { appendAuditEvent } from "@/lib/audit-log";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";

export const runtime = "nodejs";
const payloadSchema = z.object({ payload: z.record(z.string(), z.string().max(20_000)).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 20) }).strict();

export async function PATCH(request: Request, context: { params: Promise<{ credentialId: string }> }) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-credential-rotate", identity: auth.user.id, limit: 30, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "New credential values are required" }, { status: 400 });
  const { credentialId } = await context.params;
  let credential;
  try { credential = await rotateAutomationCredential({ userId: auth.user.id, credentialId, payload: parsed.data.payload }); }
  catch (error) { return automationApiErrorResponse(error, "Credential could not be rotated"); }
  if (!credential) return Response.json({ error: "Credential not found" }, { status: 404 });
  await appendAuditEvent({ workspaceId: credential.workspaceId, actorUserId: auth.user.id, action: "automation.credential.rotated", targetType: "automation_credential", targetId: credentialId });
  return Response.json({ credential });
}

export async function DELETE(request: Request, context: { params: Promise<{ credentialId: string }> }) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const { credentialId } = await context.params;
  try {
    const credential = await deleteAutomationCredential({ userId: auth.user.id, credentialId });
    if (!credential) return Response.json({ error: "Credential not found" }, { status: 404 });
    await appendAuditEvent({ workspaceId: credential.workspaceId, actorUserId: auth.user.id, action: "automation.credential.deleted", targetType: "automation_credential", targetId: credentialId });
    return Response.json({ deleted: true });
  } catch (error) {
    return automationApiErrorResponse(error, "Could not delete credential", 409);
  }
}
