import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { createAutomationWorkflowTrigger, listAutomationWorkflowTriggers } from "@/lib/automation-workflows/triggers";
import { getAutomationWorkflow } from "@/lib/automation-workflows/repository";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { appendAuditEvent } from "@/lib/audit-log";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";

export const runtime = "nodejs";
const createSchema = z.object({
  projectId: z.string().min(1),
  type: z.enum(["schedule", "webhook", "canvas-event"]),
  name: z.string().trim().min(1).max(120),
  overlapPolicy: z.enum(["queue", "skip", "cancel-previous"]).default("queue"),
  maxConcurrentRuns: z.number().int().min(1).max(32).default(1),
  config: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), z.unknown()).default({}),
}).strict();

export async function GET(_request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  const { workflowId } = await context.params;
  let triggers;
  try { triggers = await listAutomationWorkflowTriggers(auth.user.id, workflowId); }
  catch (error) { return automationApiErrorResponse(error, "Triggers could not be listed"); }
  if (!triggers) return Response.json({ error: "Workflow not found" }, { status: 404 });
  return Response.json({ triggers }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-trigger-update", identity: auth.user.id, limit: 60, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Trigger configuration is invalid" }, { status: 400 });
  const { workflowId } = await context.params;
  let result;
  try { result = await createAutomationWorkflowTrigger({ userId: auth.user.id, workflowId, ...parsed.data }); }
  catch (error) { return automationApiErrorResponse(error, "Trigger inputs are invalid"); }
  if (!result) return Response.json({ error: "Take the workflow live before adding automatic starts" }, { status: 409 });
  const workflow = await getAutomationWorkflow(auth.user.id, workflowId);
  if (workflow) await appendAuditEvent({ workspaceId: workflow.workflow.workspaceId, actorUserId: auth.user.id, action: "automation.trigger.created", targetType: "automation_trigger", targetId: result.trigger.id, metadata: { workflowId, type: result.trigger.type } });
  return Response.json(result, { status: 201 });
}
