import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { userCanAccessProject, workspaceIdForProject } from "@/lib/postgres-db";
import { ensureDefaultAutomationWorkflow, getAutomationWorkflow } from "@/lib/automation-workflows/repository";
import { enqueueAutomationWorkflowRun, getAutomationWorkflowRun } from "@/lib/automation-workflows/runs";
import { automationNodeDefinition } from "@/lib/automation-workflows/registry";
import { automationRunInputFields } from "@/lib/automation-workflows/validation";
import { getTikTokAutomationJob } from "@/lib/tiktok-automation-jobs";
import { tiktokAutomationPlanSchema } from "@/lib/tiktok-automation-runner";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-plan", identity: auth.user.id, limit: 12, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = tiktokAutomationPlanSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose a TikTok slideshow, adaptation mode and image model" }, { status: 400 });
  if (!await userCanAccessProject(auth.user.id, parsed.data.projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const workspaceId = await workspaceIdForProject(parsed.data.projectId);
  if (!workspaceId) return Response.json({ error: "Canvas not found" }, { status: 404 });

  const workflow = await ensureDefaultAutomationWorkflow(workspaceId, auth.user.id);
  const detail = await getAutomationWorkflow(auth.user.id, workflow.id);
  if (!detail?.published) return Response.json({ error: "The system workflow is unavailable" }, { status: 503 });
  const inputs: Record<string, unknown> = {};
  for (const field of automationRunInputFields(detail.published.graph)) {
    const node = detail.published.graph.nodes.find((candidate) => candidate.id === field.nodeId);
    const definition = node && automationNodeDefinition(node.type, node.version);
    if (node?.type === "input.tiktok-source" && field.bindingId === "source") inputs[field.key] = parsed.data.sourceNodeId;
    else if (node?.type === "input.tiktok-source" && field.bindingId === "caption") inputs[field.key] = parsed.data.caption;
    else if (node?.type === "input.identity" && field.bindingId === "identity") inputs[field.key] = parsed.data.personaId || "";
    else if (node?.type === "input.creative-settings" && field.bindingId in parsed.data.preferences) inputs[field.key] = parsed.data.preferences[field.bindingId as keyof typeof parsed.data.preferences];
    else if (node?.type === "generation.image" && field.bindingId === "modelId") inputs[field.key] = parsed.data.modelId;
    else if (field.value !== undefined) inputs[field.key] = field.value;
    else if (!field.required) inputs[field.key] = "";
    else return Response.json({ error: `Legacy automation adapter needs a value for ${definition?.title || field.label}` }, { status: 409 });
  }
  const queued = await enqueueAutomationWorkflowRun({
    userId: auth.user.id,
    projectId: parsed.data.projectId,
    workflowId: workflow.id,
    runtimeInputs: inputs,
  });
  if (!("runId" in queued)) return Response.json(queued, { status: queued.status });
  return Response.json({ jobId: queued.runId, status: queued.runStatus, deduplicated: queued.deduplicated }, { status: 202 });
}

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const jobId = new URL(request.url).searchParams.get("jobId") || "";
  if (!jobId) return Response.json({ error: "Automation job is required" }, { status: 400 });
  const run = await getAutomationWorkflowRun(auth.user.id, jobId);
  if (run) return Response.json({
    id: run.id,
    status: run.status,
    stage: "workflow",
    stageLabel: run.stageLabel,
    progress: run.progress,
    result: run.output,
    error: run.error,
    code: run.code,
    attempts: run.attempts,
    queuePosition: run.queuePosition,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  }, { headers: { "cache-control": "no-store" } });
  const job = await getTikTokAutomationJob(jobId, auth.user.id);
  if (!job) return Response.json({ error: "Automation job not found" }, { status: 404 });
  return Response.json(job, { headers: { "cache-control": "no-store" } });
}
