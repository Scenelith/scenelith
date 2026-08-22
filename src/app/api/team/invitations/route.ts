import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db } from "@/lib/postgres-db";
import { emailDeliveryConfigured, sendTeamInvitationEmail } from "@/lib/email";
import { createTeamInvitation, recordInvitationDelivery, TeamError, teamSnapshot } from "@/lib/team";
import { persistedProjectIdSchema } from "@/lib/project-id";
import { appendAuditEvent } from "@/lib/audit-log";
import { readRuntimeConfig } from "@/platform/runtime-config";

export const runtime = "nodejs";

const accessSchema = z.array(z.object({
  workspaceId: z.string().uuid(),
  projectIds: z.array(persistedProjectIdSchema).min(1).max(250),
})).min(1).max(50);
const schema = z.object({ workspaceId: z.string().uuid(), email: z.string().trim().email().max(254), access: accessSchema });

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  try {
    const invitation = await createTeamInvitation({ workspaceId: parsed.data.workspaceId, ownerUserId: auth.user.id, email: parsed.data.email, access: parsed.data.access });
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
    await appendAuditEvent({ workspaceId: parsed.data.workspaceId, actorUserId: auth.user.id, action: "team.invitation_created", targetType: "invitation", targetId: invitation.id, metadata: { projectCount: parsed.data.access.reduce((total, entry) => total + entry.projectIds.length, 0), delivered: delivery.ok } });
    if (!delivery.ok && readRuntimeConfig().deploymentType === "selfhost" && !emailDeliveryConfigured()) {
      return Response.json({
        team: await teamSnapshot(parsed.data.workspaceId, auth.user.id),
        invitationLink: `/invite/${encodeURIComponent(invitation.token)}`,
        delivery: "manual",
      }, { status: 201 });
    }
    if (!delivery.ok) return Response.json({ error: "Invitation saved, but the email could not be sent. Try resend from the pending list." }, { status: 502 });
    return Response.json({ team: await teamSnapshot(parsed.data.workspaceId, auth.user.id) }, { status: 201 });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
