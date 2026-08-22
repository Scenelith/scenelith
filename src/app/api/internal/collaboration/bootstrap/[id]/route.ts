import { db, readProjectGraphSnapshot } from "@/lib/postgres-db";

export const runtime = "nodejs";

function authorized(request: Request) {
  const secret = process.env.COLLABORATION_INTERNAL_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request, context: RouteContext<"/api/internal/collaboration/bootstrap/[id]">) {
  if (!authorized(request)) return Response.json({ error: "Not found" }, { status: 404 });
  const { id } = await context.params;
  const project = await db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const snapshot = await readProjectGraphSnapshot(id);
  return Response.json({
    graph: snapshot.graph,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
  }, { headers: { "cache-control": "no-store" } });
}
