import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
import { setSystemAutomationModelOverride } from "@/lib/automation-workflows/repository";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";

const updateSchema = z.object({
  nodeId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(200).nullable(),
});

export async function PUT(request: Request, context: RouteContext<"/api/automation-workflows/[workflowId]/system-model">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-system-model-write", identity: auth.user.id, limit: 60, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Model selection is invalid" }, { status: 400 });
  const { workflowId } = await context.params;
  try {
    const detail = await setSystemAutomationModelOverride({ userId: auth.user.id, workflowId, ...parsed.data });
    if (!detail) return Response.json({ error: "System workflow not found or unavailable" }, { status: 404 });
    return Response.json(detail);
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 422;
    return automationApiErrorResponse(error, "System workflow model could not be saved", Number.isInteger(status) ? status : 422);
  }
}
