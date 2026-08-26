import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { listAutomationTriggerDeliveries } from "@/lib/automation-workflows/deliveries";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";

export const runtime = "nodejs";
const querySchema = z.object({
  projectId: z.string().min(1),
  workflowId: z.string().min(1).optional(),
  triggerId: z.string().min(1).optional(),
  status: z.enum(["queued", "processing", "retry_wait", "delivered", "dead_letter", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return Response.json({ error: "Delivery filters are invalid" }, { status: 400 });
  let deliveries;
  try { deliveries = await listAutomationTriggerDeliveries({ userId: auth.user.id, ...parsed.data }); }
  catch (error) { return automationApiErrorResponse(error, "Trigger deliveries could not be listed"); }
  if (!deliveries) return Response.json({ error: "Canvas not found" }, { status: 404 });
  return Response.json({ deliveries }, { headers: { "cache-control": "no-store" } });
}
