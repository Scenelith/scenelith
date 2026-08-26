import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { enqueueAutomationNodePreview } from "@/lib/automation-workflows/fixtures";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";

export const runtime = "nodejs";
const schema = z.object({ fixtureId: z.string().min(1), nodeId: z.string().min(1).max(120) }).strict();
export async function POST(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-node-preview", identity: auth.user.id, limit: 60, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose a fixture and step" }, { status: 400 });
  try {
    const result = await enqueueAutomationNodePreview({ userId: auth.user.id, workflowId: (await context.params).workflowId, ...parsed.data });
    if (!result) return Response.json({ error: "Fixture not found" }, { status: 404 });
    return Response.json(result, { status: 202 });
  } catch (error) {
    return automationApiErrorResponse(error, "Step preview could not start");
  }
}
