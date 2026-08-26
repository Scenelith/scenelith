import { z } from "zod";
import { fireAutomationWebhook } from "@/lib/automation-workflows/triggers";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
export const runtime = "nodejs";
const payloadSchema = z.record(z.string().max(200), z.unknown());
export async function POST(request: Request, context: { params: Promise<{ triggerId: string; token: string }> }) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 1_000_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  const payload = payloadSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) return Response.json({ error: "Payload must be a JSON object" }, { status: 400 });
  if (JSON.stringify(payload.data).length > 1_000_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  const { triggerId, token } = await context.params;
  const limited = await enforceDistributedRateLimit({ scope: "automation-webhook", identity: triggerId, limit: 120, windowSeconds: 60 });
  if (limited) return limited;
  const result = await fireAutomationWebhook(triggerId, token, payload.data, request.headers.get("idempotency-key"));
  if (!result) return Response.json({ error: "Webhook not found" }, { status: 404 });
  return Response.json(result, { status: result.status });
}
