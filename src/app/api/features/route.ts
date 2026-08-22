import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { getFeatureRequest, listFeatureRequests, notifyAdmins } from "@/lib/community";
import { db, userCanAccessWorkspace } from "@/lib/postgres-db";

export const runtime = "nodejs";

const createFeatureSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(5, "Title must be at least 5 characters").max(120, "Title must be 120 characters or fewer"),
  description: z.string().trim().min(30, "Explain the request in at least 30 characters").max(5000, "Description must be 5,000 characters or fewer"),
});

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  return Response.json({ features: await listFeatureRequests(auth.user) });
}

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = createFeatureSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid feature request" }, { status: 400 });
  if (parsed.data.workspaceId && !await userCanAccessWorkspace(auth.user.id, parsed.data.workspaceId)) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO feature_requests (id, user_id, workspace_id, title, description, status, moderation_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', '', ?, ?)`)
    .run(id, auth.user.id, parsed.data.workspaceId || null, parsed.data.title, parsed.data.description, now, now);
  await notifyAdmins({ kind: "admin_queue", title: "Feature awaiting review", body: parsed.data.title, actionType: "admin", actionId: `feature:${id}` });
  return Response.json({ feature: await getFeatureRequest(auth.user, id) }, { status: 201 });
}
