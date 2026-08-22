import { z } from "zod";
import { writeProjectGraphSnapshot } from "@/lib/postgres-db";
import { normalizeProjectGraph } from "@/lib/canvas-graph";
import type { ProjectGraph } from "@/lib/types";

export const runtime = "nodejs";

const schema = z.object({
  sourceRevision: z.number().int().positive(),
  graph: z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }),
});

export async function POST(request: Request, context: RouteContext<"/api/internal/collaboration/mirror/[id]">) {
  const secret = process.env.COLLABORATION_INTERNAL_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid projection" }, { status: 400 });
  const { id } = await context.params;
  const result = await writeProjectGraphSnapshot(id, normalizeProjectGraph(parsed.data.graph as ProjectGraph), {
    sourceRevision: parsed.data.sourceRevision,
  });
  if (!result.ok) return Response.json({ error: "Projection conflict" }, { status: 409 });
  return Response.json({ ok: true, sourceRevision: parsed.data.sourceRevision, recoveryRevision: result.snapshot.revision });
}
