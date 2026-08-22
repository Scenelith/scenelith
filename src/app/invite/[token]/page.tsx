import { invitationSummary } from "@/lib/team";
import { InvalidInvitation, InviteAcceptance } from "@/components/InviteAcceptance";

export const runtime = "nodejs";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await invitationSummary(token);
  if (!invitation) return <InvalidInvitation />;
  return <InviteAcceptance
    token={token}
    workspaceName={invitation.workspace_name}
    inviterUsername={invitation.inviter_name}
    invitedEmail={invitation.invited_email}
  />;
}
