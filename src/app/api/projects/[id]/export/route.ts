import { requireApiUser } from "@/lib/auth";
import { db, readProjectGraphSnapshot, userCanAccessProject } from "@/lib/postgres-db";
import { createScenelithDocument } from "@/lib/scenelith-document";

export const runtime = "nodejs";

function downloadName(value: string) {
  const safe = value.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${safe || "canvas"}.scenelith.json`;
}

export async function GET(_request: Request, context: RouteContext<"/api/projects/[id]/export">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!await userCanAccessProject(auth.user.id, id)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const project = await db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as { name: string } | undefined;
  if (!project) return Response.json({ error: "Canvas not found" }, { status: 404 });
  try {
    const snapshot = await readProjectGraphSnapshot(id);
    const document = createScenelithDocument({ title: project.name, graph: snapshot.graph });
    return new Response(`${JSON.stringify(document, null, 2)}\n`, {
      headers: {
        "content-type": "application/vnd.scenelith.canvas+json; charset=utf-8",
        "content-disposition": `attachment; filename="${downloadName(project.name)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Canvas export failed" }, { status: 422 });
  }
}
