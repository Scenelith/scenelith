import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { db, ensureDefaultWorkspace, listAccessibleWorkspaceRows, rowToWorkspace } from "@/lib/postgres-db";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  await ensureDefaultWorkspace(auth.user.id);
  return Response.json({ workspaces: (await listAccessibleWorkspaceRows(auth.user.id)).map(rowToWorkspace) });
}

const schema = z.object({ name: z.string().trim().min(1).max(80), rolePrompt: z.string().max(4000).optional() });

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const account = await db.prepare("SELECT team_managed FROM users WHERE id = ?").get(auth.user.id) as { team_managed: number } | undefined;
  if (account?.team_managed) return Response.json({ error: "Team members cannot create private projects" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "App name is required" }, { status: 400 });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare("INSERT INTO workspaces (id, name, role_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, parsed.data.name, parsed.data.rolePrompt || "", now, now);
    await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, auth.user.id, now);
  })();
  return Response.json({ workspace: rowToWorkspace(await db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, unknown>) });
}
