import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { appendAuditEvent } from "@/lib/audit-log";
import { replayAutomationTriggerDelivery } from "@/lib/automation-workflows/deliveries";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ deliveryId: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-delivery-replay", identity: auth.user.id, limit: 30, windowSeconds: 600 });
  if (limited) return limited;
  const { deliveryId } = await context.params;
  try {
    const delivery = await replayAutomationTriggerDelivery({ userId: auth.user.id, deliveryId });
    if (!delivery) return Response.json({ error: "Delivery not found" }, { status: 404 });
    await appendAuditEvent({ workspaceId: delivery.workspaceId, actorUserId: auth.user.id, action: "automation.trigger_delivery.replayed", targetType: "automation_trigger_delivery", targetId: deliveryId, metadata: { replayDeliveryId: delivery.id, workflowId: delivery.workflowId } });
    return Response.json({ delivery }, { status: 202 });
  } catch (error) {
    return automationApiErrorResponse(error, "Delivery could not be replayed", 409);
  }
}
