import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { importProvider } from "@/platform/providers/registry";
import { db, userCanAccessProject } from "@/lib/postgres-db";
import { persistedProjectIdSchema } from "@/lib/project-id";

export const runtime = "nodejs";

const schema = z.object({
  url: z.string().url().refine((url) => /tiktok\.com/i.test(url), "TikTok URL required"),
  projectId: persistedProjectIdSchema.optional(),
});

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "TikTok URL required" }, { status: 400 });
  if (parsed.data.projectId && !await userCanAccessProject(auth.user.id, parsed.data.projectId)) return Response.json({ error: "Project not found" }, { status: 404 });
  try {
    const post = await importProvider("tikwm").fetchTikTokStats(parsed.data.url);
    if (parsed.data.projectId) {
      await db.prepare("UPDATE hooks SET views_count = ? WHERE project_id = ? AND kind = 'original'").run(post.stats.views, parsed.data.projectId);
    }
    return Response.json({ post });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not refresh TikTok stats" }, { status: 502 });
  }
}
