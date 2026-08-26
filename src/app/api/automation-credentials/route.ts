import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { createAutomationCredential, listAutomationCredentials } from "@/lib/automation-workflows/credentials";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { appendAuditEvent } from "@/lib/audit-log";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";

export const runtime = "nodejs";

const createSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["api-key", "bearer", "basic", "header"]),
  payload: z.record(z.string(), z.string().max(20_000)).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 20),
}).strict();

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
  let credentials;
  try { credentials = workspaceId ? await listAutomationCredentials(auth.user.id, workspaceId) : null; }
  catch (error) { return automationApiErrorResponse(error, "Credentials could not be listed"); }
  if (!credentials) return Response.json({ error: "Workspace not found" }, { status: 404 });
  return Response.json({ credentials }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-credential-create", identity: auth.user.id, limit: 30, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Credential name, kind and values are required" }, { status: 400 });
  let credential;
  try { credential = await createAutomationCredential({ userId: auth.user.id, ...parsed.data }); }
  catch (error) { return automationApiErrorResponse(error, "Credential could not be created"); }
  if (!credential) return Response.json({ error: "Workspace not found" }, { status: 404 });
  await appendAuditEvent({ workspaceId: parsed.data.workspaceId, actorUserId: auth.user.id, action: "automation.credential.created", targetType: "automation_credential", targetId: credential.id, metadata: { name: parsed.data.name, kind: parsed.data.kind } });
  return Response.json({ credential }, { status: 201 });
}
