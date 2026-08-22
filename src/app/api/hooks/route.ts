import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { db, rowToHook, userCanAccessHook, userCanAccessProject, userCanAccessWorkspace } from "@/lib/postgres-db";
import { intelligenceProvider } from "@/platform/providers/registry";
import { persistedProjectIdSchema } from "@/lib/project-id";

export const runtime = "nodejs";
export const maxDuration = 120;

async function listHooks(workspaceId: string, userId: string) {
  const rows = await db.prepare("SELECT * FROM hooks WHERE workspace_id = ? ORDER BY views_count DESC, created_at DESC").all(workspaceId) as Record<string, unknown>[];
  const visible = [];
  for (const row of rows) {
    if (await userCanAccessHook(userId, String(row.id))) visible.push(row);
  }
  return visible.map(rowToHook);
}

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
  if (!workspaceId) return Response.json({ error: "workspaceId is required" }, { status: 400 });
  if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
  return Response.json({ hooks: await listHooks(workspaceId, auth.user.id) });
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("manual"), workspaceId: z.string().uuid(), projectId: persistedProjectIdSchema.nullable().optional(), text: z.string().trim().min(1).max(1000), views: z.number().int().min(0).optional() }),
  z.object({ action: z.literal("generate"), workspaceId: z.string().uuid(), sourceHookId: z.string().uuid(), brief: z.string().max(2000).optional(), count: z.number().int().min(1).max(10).optional() }),
]);

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid hook request" }, { status: 400 });
  if (!await userCanAccessWorkspace(auth.user.id, parsed.data.workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
  if (parsed.data.action === "manual" && parsed.data.projectId) {
    const projectMatchesWorkspace = await db.prepare("SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?")
      .get(parsed.data.projectId, parsed.data.workspaceId);
    if (!projectMatchesWorkspace || !await userCanAccessProject(auth.user.id, parsed.data.projectId)) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
  }
  const now = new Date().toISOString();
  if (parsed.data.action === "manual") {
    await db.prepare("INSERT INTO hooks (id, workspace_id, project_id, kind, text, views_count, created_at) VALUES (?, ?, ?, 'manual', ?, ?, ?)").run(crypto.randomUUID(), parsed.data.workspaceId, parsed.data.projectId || null, parsed.data.text, parsed.data.views || 0, now);
    return Response.json({ hooks: await listHooks(parsed.data.workspaceId, auth.user.id) });
  }
  if (!await userCanAccessHook(auth.user.id, parsed.data.sourceHookId)) return Response.json({ error: "Source hook not found" }, { status: 404 });
  const requested = await db.prepare("SELECT * FROM hooks WHERE id = ? AND workspace_id = ?").get(parsed.data.sourceHookId, parsed.data.workspaceId) as Record<string, unknown> | undefined;
  if (!requested) return Response.json({ error: "Source hook not found" }, { status: 404 });
  const source = requested.kind === "generated" && requested.parent_hook_id
    ? await db.prepare("SELECT * FROM hooks WHERE id = ? AND workspace_id = ?").get(requested.parent_hook_id, parsed.data.workspaceId) as Record<string, unknown> | undefined
    : requested;
  if (!source || source.kind === "generated") return Response.json({ error: "Original hook not found" }, { status: 404 });
  const workspace = await db.prepare("SELECT role_prompt FROM workspaces WHERE id = ?").get(parsed.data.workspaceId) as { role_prompt: string } | undefined;
  const requestedCount = parsed.data.count || 1;
  const previousRows = await db.prepare("SELECT text FROM hooks WHERE workspace_id = ? AND parent_hook_id = ? AND kind = 'generated'").all(parsed.data.workspaceId, source.id) as Array<{ text: string }>;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const excluded = new Set(previousRows.map((item) => normalize(item.text)));
  excluded.add(normalize(String(source.text)));
  const variants: Array<{ text: string; angle: string }> = [];
  for (let attempt = 0; attempt < 3 && variants.length < requestedCount; attempt += 1) {
    const batch = await intelligenceProvider().generateHookVariants({
      original: String(source.text),
      rolePrompt: workspace?.role_prompt || "",
      brief: parsed.data.brief,
      count: requestedCount - variants.length,
      avoid: [...previousRows.map((item) => item.text), ...variants.map((item) => item.text)],
    });
    for (const variant of batch) {
      const normalized = normalize(variant.text);
      if (!normalized || excluded.has(normalized)) continue;
      excluded.add(normalized);
      variants.push(variant);
    }
  }
  if (variants.length < requestedCount) return Response.json({ error: "Gemini repeated the previous hook. Try Regen again." }, { status: 502 });
  const insert = db.prepare("INSERT INTO hooks (id, workspace_id, project_id, parent_hook_id, kind, text, angle, language, created_at) VALUES (?, ?, ?, ?, 'generated', ?, ?, ?, ?)");
  const transaction = db.transaction(async () => {
    await db.prepare("DELETE FROM hooks WHERE workspace_id = ? AND parent_hook_id = ? AND kind = 'generated'").run(parsed.data.workspaceId, source.id);
    variants.forEach((variant) => insert.run(crypto.randomUUID(), parsed.data.workspaceId, source.project_id || null, source.id, variant.text, variant.angle, source.language || "", new Date().toISOString()));
  });
  await transaction();
  return Response.json({ hooks: await listHooks(parsed.data.workspaceId, auth.user.id) });
}
