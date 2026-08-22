import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { revokeTeamInvitation, TeamError, teamSnapshot, updateTeamInvitationAccess } from "@/lib/team";
import { persistedProjectIdSchema } from "@/lib/project-id";

export const runtime = "nodejs";
const schema = z.object({ workspaceId: z.string().uuid() });
const updateSchema = z.object({
  workspaceId: z.string().uuid(),
  access: z.array(z.object({ workspaceId: z.string().uuid(), projectIds: z.array(persistedProjectIdSchema).min(1).max(250) })).min(1).max(50),
});

export async function PATCH(request: Request, context: RouteContext<"/api/team/invitations/[id]">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose at least one canvas" }, { status: 400 });
  const { id } = await context.params;
  try {
    await updateTeamInvitationAccess({ workspaceId: parsed.data.workspaceId, ownerUserId: auth.user.id, invitationId: id, access: parsed.data.access });
    return Response.json({ team: await teamSnapshot(parsed.data.workspaceId, auth.user.id) });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export async function DELETE(request: Request, context: RouteContext<"/api/team/invitations/[id]">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const { id } = await context.params;
  try {
    await revokeTeamInvitation({ workspaceId: parsed.data.workspaceId, ownerUserId: auth.user.id, invitationId: id });
    return Response.json({ team: await teamSnapshot(parsed.data.workspaceId, auth.user.id) });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
