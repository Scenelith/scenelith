import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { db, rowToWorkspace, workspaceRoleForUser } from "@/lib/postgres-db";

export const runtime = "nodejs";
const schema = z.object({ name: z.string().trim().min(1).max(80).optional(), rolePrompt: z.string().max(4000).optional() });

export async function PATCH(request: Request, context: RouteContext<"/api/workspaces/[id]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid app settings" }, { status: 400 });
  const { id } = await context.params;
  if (await workspaceRoleForUser(auth.user.id, id) !== "owner") return Response.json({ error: "App not found" }, { status: 404 });
  const current = await db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!current) return Response.json({ error: "App not found" }, { status: 404 });
  await db.prepare("UPDATE workspaces SET name = ?, role_prompt = ?, updated_at = ? WHERE id = ?").run(parsed.data.name ?? current.name, parsed.data.rolePrompt ?? current.role_prompt, new Date().toISOString(), id);
  return Response.json({ workspace: rowToWorkspace(await db.prepare(`SELECT w.*, wm.role AS member_role FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id WHERE w.id = ? AND wm.user_id = ?`).get(id, auth.user.id) as Record<string, unknown>) });
}
