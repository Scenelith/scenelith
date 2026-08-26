import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { enqueueAutomationWorkflowRun, listAutomationWorkflowRuns } from "@/lib/automation-workflows/runs";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";

const runSchema = z.object({
  projectId: z.string().min(1),
  workflowId: z.string().min(1),
  inputs: z.record(z.string().max(260), z.unknown()).default({}),
  mode: z.enum(["production", "test"]).default("production"),
});

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || "";
  if (!projectId) return Response.json({ error: "Canvas is required" }, { status: 400 });
  const runs = await listAutomationWorkflowRuns({
    userId: auth.user.id,
    projectId,
    workflowId: url.searchParams.get("workflowId") || undefined,
    before: url.searchParams.get("before") || undefined,
    limit: Number(url.searchParams.get("limit") || 30),
  });
  if (!runs) return Response.json({ error: "Canvas not found" }, { status: 404 });
  return Response.json({ runs }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-workflow-run", identity: auth.user.id, limit: 30, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = runSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Workflow, canvas and run inputs are required" }, { status: 400 });
  const result = await enqueueAutomationWorkflowRun({
    userId: auth.user.id,
    projectId: parsed.data.projectId,
    workflowId: parsed.data.workflowId,
    runtimeInputs: parsed.data.inputs,
    mode: parsed.data.mode,
  });
  if (!("runId" in result)) return Response.json(result, { status: result.status });
  return Response.json(result, { status: 202 });
}
