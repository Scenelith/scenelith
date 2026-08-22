import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, readProjectGraphSnapshot, rowToHook, userCanAccessProject } from "@/lib/postgres-db";
import { intelligenceProvider } from "@/platform/providers/registry";
import { persistedProjectIdSchema } from "@/lib/project-id";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;
const schema = z.object({ projectId: persistedProjectIdSchema });

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "hook-extract", identity: auth.user.id, limit: 12, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "projectId is required" }, { status: 400 });
  if (!await userCanAccessProject(auth.user.id, parsed.data.projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const project = await db.prepare("SELECT workspace_id, source_url FROM projects WHERE id = ?").get(parsed.data.projectId) as { workspace_id: string; source_url: string | null } | undefined;
  if (!project) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const asset = await db.prepare("SELECT id, storage_path, mime_type FROM assets WHERE project_id = ? AND kind IN ('slide','scene') ORDER BY created_at LIMIT 1").get(parsed.data.projectId) as { id: string; storage_path: string; mime_type: string } | undefined;
  if (!asset) return Response.json({ error: "No first slide found" }, { status: 404 });
  const analysis = await intelligenceProvider().extractHookFromImage(asset.storage_path, asset.mime_type);
  if (!analysis.hook) return Response.json({ error: "No visible hook text found on the first slide" }, { status: 422 });
  const existing = await db.prepare("SELECT * FROM hooks WHERE workspace_id = ? AND source_asset_id = ? AND kind = 'original'").get(project.workspace_id, asset.id) as Record<string, unknown> | undefined;
  if (existing) return Response.json({ hook: rowToHook(existing) });
  const id = crypto.randomUUID();
  let views = 0;
  const graph = (await readProjectGraphSnapshot(parsed.data.projectId)).graph;
  views = Number(graph.nodes?.find((node) => node.data?.kind === "source")?.data?.postStats?.views || 0);
  await db.prepare("INSERT INTO hooks (id, workspace_id, project_id, source_asset_id, source_url, kind, text, angle, language, views_count, created_at) VALUES (?, ?, ?, ?, ?, 'original', ?, ?, ?, ?, ?)").run(id, project.workspace_id, parsed.data.projectId, asset.id, project.source_url, analysis.hook, analysis.angle, analysis.language, views, new Date().toISOString());
  return Response.json({ hook: rowToHook(await db.prepare("SELECT * FROM hooks WHERE id = ?").get(id) as Record<string, unknown>) });
}
