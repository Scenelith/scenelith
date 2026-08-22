"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, Clock3, LoaderCircle, MailCheck, RefreshCw, UsersRound, X } from "lucide-react";

type PendingInvitation = { id: string; workspaceId: string; workspaceName: string; inviterName: string; expiresAt: string; available: boolean };

export function PendingTeamInvitations() {
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [emailVerified, setEmailVerified] = useState(true);
  const [visible, setVisible] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    const response = await fetch("/api/team/invitations/pending", { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { invitations: PendingInvitation[]; emailVerified: boolean };
    setInvitations(body.invitations);
    setEmailVerified(body.emailVerified);
    setVisible(body.invitations.length > 0);
  };

  useEffect(() => { const timer = window.setTimeout(() => void load(), 350); return () => window.clearTimeout(timer); }, []);
  if (!visible || !invitations.length) return null;

  const accept = async (invitation: PendingInvitation) => {
    setBusyId(invitation.id); setError("");
    const response = await fetch("/api/team/invitations/pending", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId: invitation.id }),
    });
    const body = await response.json().catch(() => ({})) as { accepted?: { workspaceId: string }; error?: string };
    if (!response.ok || !body.accepted) {
      setError(body.error || "Could not join this workspace");
      setBusyId("");
      return;
    }
    window.location.assign(`/canvas?workspace=${encodeURIComponent(body.accepted.workspaceId)}`);
  };

  return <div className="pending-team-backdrop" role="presentation">
    <section className="pending-team-dialog" role="dialog" aria-modal="true" aria-label="Pending team invitations">
      <header><span className="pending-team-mark"><UsersRound size={20} /></span><div><p>SCENELITH / TEAM ACCESS</p><h2>{invitations.length === 1 ? "Your workspace is waiting" : "Your workspaces are waiting"}</h2><span>We found an invitation attached to your signed-in email.</span></div><button type="button" onClick={() => setVisible(false)} aria-label="Close invitations"><X size={17} /></button></header>
      <div className="pending-team-list">
        {invitations.map((invitation) => <article key={invitation.id}>
          <span className="pending-team-avatar">{invitation.workspaceName.slice(0,1).toUpperCase()}</span>
          <div><strong>{invitation.workspaceName}</strong><p>Invited by {invitation.inviterName}</p><small><Clock3 size={11} />Expires {new Date(invitation.expiresAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</small></div>
          <button type="button" disabled={Boolean(busyId) || !emailVerified || !invitation.available} onClick={() => void accept(invitation)}>{busyId === invitation.id ? <LoaderCircle className="spin" size={14} /> : invitation.available ? <ArrowRight size={14} /> : <X size={14} />}{invitation.available ? emailVerified ? "Join workspace" : "Confirm email first" : "Access paused"}</button>
        </article>)}
      </div>
      {!emailVerified && <div className="pending-team-verification"><MailCheck size={16} /><span><strong>Confirm your email to join</strong><p>Open the verification message we sent, confirm the address, then come back here.</p></span><button type="button" onClick={() => void load()}><RefreshCw size={12} />Check again</button></div>}
      {emailVerified && <div className="pending-team-session"><Check size={14} /><span>Once joined, this workspace stays on your account. Later, sign in normally with this email and password — no invitation link needed.</span></div>}
      {error && <p className="pending-team-error" role="alert">{error}</p>}
    </section>
  </div>;
}
