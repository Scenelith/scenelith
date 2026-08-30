import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { promptComposeRequestSchema, promptComposeValidationMessage } from "@/lib/prompt-compose-request";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { composeCanvasGenerationPrompt } from "@/lib/canvas-intelligence";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "assistant-tools", identity: auth.user.id, limit: 30, windowSeconds: 60 });
  if (limited) return limited;
  const parsed = promptComposeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: promptComposeValidationMessage(parsed.error) }, { status: 400 });
  try {
    return Response.json(await composeCanvasGenerationPrompt({ userId: auth.user.id, ...parsed.data }));
  } catch (error) {
    const value = error as { status?: number; code?: string; requiredCredits?: number };
    return Response.json({ error: error instanceof Error ? error.message : "Prompt assistant failed", ...(value.code ? { code: value.code } : {}), ...(value.requiredCredits ? { requiredCredits: value.requiredCredits } : {}) }, { status: value.status || 502 });
  }
}
