import { requireApiUser } from "@/lib/auth";
import { db, ensureDefaultWorkspace, listAccessibleProjectRows, rowToProject, rowToProjectListItem, workspaceRoleForUser } from "@/lib/postgres-db";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const rows = await listAccessibleProjectRows(auth.user.id);
  return Response.json({ projects: rows.map(rowToProjectListItem) });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = (await request.json().catch(() => ({}))) as { name?: string; workspaceId?: string };
  const workspaceId = body.workspaceId || (await ensureDefaultWorkspace(auth.user.id))?.id;
  if (!workspaceId) return Response.json({ error: "Team members cannot create private canvases" }, { status: 403 });
  if (await workspaceRoleForUser(auth.user.id, workspaceId) !== "owner") return Response.json({ error: "App not found" }, { status: 404 });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO projects (id, workspace_id, name, status, graph_json, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)",
  ).run(id, workspaceId, body.name?.trim() || "Canvas 01", JSON.stringify({ nodes: [], edges: [] }), now, now);
  return Response.json({
    project: await rowToProject(await db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown>),
  });
}
