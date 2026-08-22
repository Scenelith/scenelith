import { requireApiUser } from "@/lib/auth";
import { userCanAccessGeneration } from "@/lib/postgres-db";
import { publicGenerationErrorMessage } from "@/lib/generation-lifecycle";
import { generationClientState, readGenerationState, reconcileGeneration } from "@/lib/generation-state";

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/generate/[id]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!await userCanAccessGeneration(auth.user.id, id)) {
    return Response.json({ error: "Generation not found" }, { status: 404 });
  }

  const current = await readGenerationState(id);
  if (!current) return Response.json({ error: "Generation not found" }, { status: 404 });
  try {
    const generation = await reconcileGeneration(id);
    const client = await generationClientState(generation);
    return Response.json({ generation: client, ...(client.error ? { error: client.error } : {}) });
  } catch (error) {
    const latest = await readGenerationState(id);
    if (latest) {
      const client = await generationClientState(latest);
      if (client.outputUrl || client.error) return Response.json({ generation: client, ...(client.error ? { error: client.error } : {}) });
    }
    return Response.json({ error: error instanceof Error ? publicGenerationErrorMessage(error.message) : "Could not check generation status" }, { status: 502 });
  }
}
