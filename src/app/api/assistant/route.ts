import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { DEFAULT_ASSISTANT_MODEL_ID } from "@/lib/assistant-models";
import { persistedProjectIdSchema } from "@/lib/project-id";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { runCanvasAssistant } from "@/lib/canvas-intelligence";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({
  projectId: persistedProjectIdSchema,
  instruction: z.string().trim().min(1).max(10000),
  connectedText: z.string().max(20000).optional().default(""),
  systemPrompt: z.string().max(10000).optional().default(""),
  imageAssetIds: z.array(z.string().uuid()).max(14).default([]),
  assistantModelId: z.string().max(120).optional().default(DEFAULT_ASSISTANT_MODEL_ID),
});

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "assistant-tools", identity: auth.user.id, limit: 30, windowSeconds: 60 });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Describe the prompt you want to create" }, { status: 400 });
  try {
    return Response.json(await runCanvasAssistant({ userId: auth.user.id, ...parsed.data }));
  } catch (error) {
    const value = error as { status?: number; code?: string; requiredCredits?: number };
    return Response.json({ error: error instanceof Error ? error.message : "Assistant failed", ...(value.code ? { code: value.code } : {}), ...(value.requiredCredits ? { requiredCredits: value.requiredCredits } : {}) }, { status: value.status || 502 });
  }
}
