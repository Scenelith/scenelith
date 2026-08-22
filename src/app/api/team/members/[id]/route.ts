import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { removeTeamMember, TeamError, teamSnapshot, updateTeamMemberAccess } from "@/lib/team";
import { persistedProjectIdSchema } from "@/lib/project-id";
import { revokeCollaborativeAccess } from "@/lib/collaboration-store";
import { appendAuditEvent } from "@/lib/audit-log";

export const runtime = "nodejs";
const schema = z.object({ workspaceId: z.string().uuid() });
const updateSchema = z.object({
  workspaceId: z.string().uuid(),
  access: z.array(z.object({ workspaceId: z.string().uuid(), projectIds: z.array(persistedProjectIdSchema).min(1).max(250) })).min(1).max(50),
});

export async function PATCH(request: Request, context: RouteContext<"/api/team/members/[id]">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose at least one canvas" }, { status: 400 });
  const { id } = await context.params;
  try {
    const changed = await updateTeamMemberAccess({ workspaceId: parsed.data.workspaceId, ownerUserId: auth.user.id, memberUserId: id, access: parsed.data.access });
    if (changed.revokedProjectIds.length) await revokeCollaborativeAccess(id, changed.revokedProjectIds);
    await appendAuditEvent({ workspaceId: parsed.data.workspaceId, actorUserId: auth.user.id, action: "team.access_updated", targetType: "user", targetId: id, metadata: { revokedProjectCount: changed.revokedProjectIds.length, grantedProjectCount: parsed.data.access.reduce((total, entry) => total + entry.projectIds.length, 0) } });
    return Response.json({ team: await teamSnapshot(parsed.data.workspaceId, auth.user.id) });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export async function DELETE(request: Request, context: RouteContext<"/api/team/members/[id]">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const { id } = await context.params;
  try {
    const removed = await removeTeamMember({ workspaceId: parsed.data.workspaceId, ownerUserId: auth.user.id, memberUserId: id });
    await revokeCollaborativeAccess(id, removed.revokedProjectIds);
    await appendAuditEvent({ workspaceId: parsed.data.workspaceId, actorUserId: auth.user.id, action: "team.member_removed", targetType: "user", targetId: id, metadata: { revokedProjectCount: removed.revokedProjectIds.length } });
    return Response.json({ team: await teamSnapshot(parsed.data.workspaceId, auth.user.id) });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
