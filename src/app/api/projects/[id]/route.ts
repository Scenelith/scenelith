import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, readProjectGraphSnapshot, rowToProject, summarizeProjectGraph, userCanAccessProject, workspaceRoleForUser } from "@/lib/postgres-db";
import { deleteCollaborativeGraph, writeCollaborativeGraph } from "@/lib/collaboration-store";
import { normalizeProjectGraph } from "@/lib/canvas-graph";
import type { ProjectGraph } from "@/lib/types";
import { appendAuditEvent } from "@/lib/audit-log";

export const runtime = "nodejs";

const updateSchema = z.object({
  revision: z.number().int().positive().optional(),
  name: z.string().min(1).max(120).optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
  status: z.string().max(40).optional(),
  graph: z.object({
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  }).optional(),
});

export async function GET(request: Request, context: RouteContext<"/api/projects/[id]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!await userCanAccessProject(auth.user.id, id)) return Response.json({ error: "Project not found" }, { status: 404 });
  const row = await db.prepare("SELECT id, workspace_id, name, source_url, status, created_at, updated_at FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return Response.json({ error: "Project not found" }, { status: 404 });
  const snapshot = await readProjectGraphSnapshot(id);
  const etag = `W/\"canvas-${id}-${snapshot.revision}\"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } });
  return Response.json({ project: await rowToProject(row, snapshot) }, { headers: { etag, "cache-control": "private, no-cache" } });
}

export async function PATCH(request: Request, context: RouteContext<"/api/projects/[id]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid project data" }, { status: 400 });
  const { id } = await context.params;
  if (!await userCanAccessProject(auth.user.id, id)) return Response.json({ error: "Project not found" }, { status: 404 });
  // A graph is a versioned document. Never accept a whole-graph write from an
  // old client that does not know which snapshot it edited: after a deploy,
  // such a tab could otherwise replace a populated canvas with its empty shell.
  if (parsed.data.graph && parsed.data.revision === undefined) {
    return Response.json({ error: "Canvas revision is required", conflict: true }, { status: 428 });
  }
  const current = await db.prepare("SELECT id, workspace_id, name, source_url, status, created_at, updated_at FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!current) return Response.json({ error: "Project not found" }, { status: 404 });
  const normalizedGraph = parsed.data.graph ? normalizeProjectGraph(parsed.data.graph as ProjectGraph) : null;
  let writtenSnapshot: { graph: ProjectGraph; revision: number; stateVector: string; updatedAt: string } | null = null;
  const updatedAt = new Date().toISOString();
  if (normalizedGraph) {
    const written = await writeCollaborativeGraph(id, normalizedGraph, parsed.data.revision!);
    if ("conflict" in written) {
      const latest = await db.prepare("SELECT id, workspace_id, name, source_url, status, created_at, updated_at FROM projects WHERE id = ?").get(id) as Record<string, unknown>;
      const snapshot = { ...written.snapshot, summary: summarizeProjectGraph(written.snapshot.graph) };
      return Response.json({ error: "Canvas changed in another session", conflict: true, project: await rowToProject(latest, snapshot) }, { status: 409 });
    }
    writtenSnapshot = written;
  }
  await db.prepare(`UPDATE projects SET name = ?, source_url = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    parsed.data.name ?? current.name,
    parsed.data.sourceUrl === undefined ? current.source_url : parsed.data.sourceUrl,
    parsed.data.status ?? current.status,
    updatedAt,
    id,
  );
  const updated = await db.prepare("SELECT id, workspace_id, name, source_url, status, created_at, updated_at FROM projects WHERE id = ?").get(id) as Record<string, unknown>;
  const snapshot = writtenSnapshot
    ? { ...writtenSnapshot, summary: summarizeProjectGraph(writtenSnapshot.graph) }
    : await readProjectGraphSnapshot(id);
  return Response.json({ ok: true, project: await rowToProject(updated, snapshot) });
}

export async function DELETE(request: Request, context: RouteContext<"/api/projects/[id]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const { id } = await context.params;
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(id) as { workspace_id: string } | undefined;
  if (!project || await workspaceRoleForUser(auth.user.id, project.workspace_id) !== "owner") {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const assetCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM assets WHERE project_id = ?").get(id) as { count: number }).count || 0);
  await db.transaction(async () => {
    await appendAuditEvent({
      workspaceId: project.workspace_id,
      actorUserId: auth.user.id,
      action: "project.deleted",
      targetType: "project",
      targetId: id,
      metadata: { assetCount },
    });
    await db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  })();
  // The database tombstone is already authoritative. This call immediately
  // evicts the deleted document from every realtime replica; a temporary
  // collaboration outage cannot resurrect it.
  await deleteCollaborativeGraph(id).catch((error) => {
    console.error("Deleted canvas realtime eviction failed", { projectId: id, error });
  });
  return Response.json({ ok: true });
}
