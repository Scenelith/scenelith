import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db } from "@/lib/postgres-db";
import { emailDeliveryConfigured, sendTeamInvitationEmail } from "@/lib/email";
import { prepareInvitationResend, recordInvitationDelivery, TeamError, teamSnapshot } from "@/lib/team";
import { readRuntimeConfig } from "@/platform/runtime-config";

export const runtime = "nodejs";
const schema = z.object({ workspaceId: z.string().uuid() });

export async function POST(request: Request, context: RouteContext<"/api/team/invitations/[id]/resend">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const { id } = await context.params;
  try {
    const invitation = await prepareInvitationResend({ workspaceId: parsed.data.workspaceId, ownerUserId: auth.user.id, invitationId: id });
    const workspace = await db.prepare("SELECT name FROM workspaces WHERE id = ?").get(parsed.data.workspaceId) as { name: string };
    const delivery = await sendTeamInvitationEmail({
      email: invitation.email,
      inviterEmail: auth.user.email,
      workspaceName: workspace.name,
      token: invitation.token,
      invitationId: invitation.id,
      attempt: invitation.attempt,
    });
    await recordInvitationDelivery({ invitationId: invitation.id, providerEmailId: delivery.ok ? delivery.id : undefined, error: delivery.ok ? undefined : delivery.error });
    if (!delivery.ok && readRuntimeConfig().deploymentType === "selfhost" && !emailDeliveryConfigured()) {
      return Response.json({
        team: await teamSnapshot(parsed.data.workspaceId, auth.user.id),
        invitationLink: `/invite/${encodeURIComponent(invitation.token)}`,
        delivery: "manual",
      });
    }
    if (!delivery.ok) return Response.json({ error: "Resend could not deliver this invitation. Try again later." }, { status: 502 });
    return Response.json({ team: await teamSnapshot(parsed.data.workspaceId, auth.user.id) });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
