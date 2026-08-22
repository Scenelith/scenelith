import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { acceptPendingTeamInvitation, pendingTeamInvitationsForUser, TeamError } from "@/lib/team";

export const runtime = "nodejs";
const schema = z.object({ invitationId: z.string().uuid() });

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  return Response.json({
    emailVerified: auth.user.emailVerified,
    invitations: await pendingTeamInvitationsForUser(auth.user.id, auth.user.email),
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invitation not found" }, { status: 404 });
  try {
    return Response.json({ accepted: await acceptPendingTeamInvitation({
      invitationId: parsed.data.invitationId,
      userId: auth.user.id,
      userEmail: auth.user.email,
      emailVerified: auth.user.emailVerified,
    }) });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
