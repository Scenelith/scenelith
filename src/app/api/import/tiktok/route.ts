import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, rowToHook, userCanAccessProject } from "@/lib/postgres-db";
import { importProvider, intelligenceProvider } from "@/platform/providers/registry";
import { persistedProjectIdSchema } from "@/lib/project-id";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { fireAutomationCanvasEvent } from "@/lib/automation-workflows/triggers";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  projectId: persistedProjectIdSchema,
  url: z.string().url().refine((url) => /tiktok\.com/i.test(url), "TikTok URL required"),
});

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "tiktok-import", identity: auth.user.id, limit: 6, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Paste a direct TikTok post link" }, { status: 400 });
  if (!await userCanAccessProject(auth.user.id, parsed.data.projectId)) return Response.json({ error: "Project not found" }, { status: 404 });
  const project = await db.prepare("SELECT id, workspace_id FROM projects WHERE id = ?").get(parsed.data.projectId) as { id: string; workspace_id: string } | undefined;
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  try {
    const result = await importProvider("tikwm").importTikTok(parsed.data.url, parsed.data.projectId);
    await db.transaction(async () => {
      await db.prepare("UPDATE projects SET name = ?, source_url = ?, status = 'imported', updated_at = ? WHERE id = ?").run(
        result.post.title.slice(0, 120) || "TikTok study",
        parsed.data.url,
        new Date().toISOString(),
        parsed.data.projectId,
      );
      await fireAutomationCanvasEvent({
        userId: auth.user.id,
        projectId: parsed.data.projectId,
        event: "tiktok.imported",
        payload: { sourceUrl: parsed.data.url, assetIds: result.assets.map((asset) => asset.id), title: String(result.post.title || "") },
      });
    });
    let hook = null;
    let hookError: string | null = null;
    const firstVisual = result.assets.find((asset) => asset.kind === "slide" || asset.kind === "scene");
    if (firstVisual) {
      try {
        const stored = await db.prepare("SELECT storage_path, mime_type FROM assets WHERE id = ?").get(firstVisual.id) as { storage_path: string; mime_type: string };
        const analysis = await intelligenceProvider().extractHookFromImage(stored.storage_path, stored.mime_type);
        if (analysis.hook) {
          const hookId = crypto.randomUUID();
          await db.prepare("INSERT INTO hooks (id, workspace_id, project_id, source_asset_id, source_url, kind, text, angle, language, views_count, created_at) VALUES (?, ?, ?, ?, ?, 'original', ?, ?, ?, ?, ?)").run(hookId, project.workspace_id, parsed.data.projectId, firstVisual.id, parsed.data.url, analysis.hook, analysis.angle, analysis.language, result.post.stats.views, new Date().toISOString());
          hook = rowToHook(await db.prepare("SELECT * FROM hooks WHERE id = ?").get(hookId) as Record<string, unknown>);
        }
      } catch (error) {
        hookError = error instanceof Error ? error.message : "Hook extraction failed";
      }
    }
    return Response.json({ ...result, hook, hookError });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "TikTok import failed" },
      { status: 502 },
    );
  }
}
