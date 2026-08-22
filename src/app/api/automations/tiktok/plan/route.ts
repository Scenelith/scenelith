import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { userCanAccessProject, workspaceIdForProject } from "@/lib/postgres-db";
import {
  enqueueTikTokAutomationJob,
  getTikTokAutomationJob,
} from "@/lib/tiktok-automation-jobs";
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

  const queued = await enqueueTikTokAutomationJob({ userId: auth.user.id, workspaceId, request: parsed.data });
  return Response.json(queued, { status: 202 });
}

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const jobId = new URL(request.url).searchParams.get("jobId") || "";
  if (!jobId) return Response.json({ error: "Automation job is required" }, { status: 400 });
  const job = await getTikTokAutomationJob(jobId, auth.user.id);
  if (!job) return Response.json({ error: "Automation job not found" }, { status: 404 });
  return Response.json(job, { headers: { "cache-control": "no-store" } });
}
