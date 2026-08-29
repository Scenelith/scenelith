import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { retryAutomationWorkflowRun } from "@/lib/automation-workflows/runs";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";

const retrySchema = z.object({ nodeId: z.string().min(1).max(120) }).strict();

export async function POST(request: Request, context: RouteContext<"/api/automation-runs/[runId]/retry">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-workflow-retry", identity: auth.user.id, limit: 30, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = retrySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Retry step is invalid" }, { status: 400 });
  const { runId } = await context.params;
  const result = await retryAutomationWorkflowRun({ userId: auth.user.id, runId, ...parsed.data });
  if (!("runId" in result)) return Response.json(result, { status: result.status });
  return Response.json(result, { status: 202 });
}
