"use client";

import { useState } from "react";
import { ArrowRight, FolderKanban, LoaderCircle, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import BrandMark from "@/components/BrandMark";

export function InviteAcceptance({
  token,
  workspaceName,
  inviterUsername,
  invitedEmail,
}: {
  token: string;
  workspaceName: string;
  inviterUsername: string;
  invitedEmail: string;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const passwordsMatch = Boolean(confirmPassword) && password === confirmPassword;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8) { setError("Use at least 8 characters"); return; }
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    setBusy(true); setError("");
    const response = await fetch("/api/team/invitations/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password, confirmPassword }),
    });
    const body = await response.json().catch(() => ({})) as { accepted?: { workspaceId: string }; error?: string };
    if (!response.ok || !body.accepted) {
      setError(body.error || "Could not create your team access");
      setBusy(false);
      return;
    }
    window.location.href = `/canvas?workspace=${encodeURIComponent(body.accepted.workspaceId)}`;
  };

  return <main className="invite-page">
    <section className="invite-card invite-onboarding">
      <header className="invite-brand"><BrandMark title="Scenelith" /><span>SCENELITH</span><small>TEAM ACCESS</small></header>
      <div className="invite-heading">
        <p className="eyebrow">PRIVATE PROJECT INVITATION</p>
        <h1>Create your team access</h1>
        <p><strong>{inviterUsername}</strong> invited you to collaborate on <b>{workspaceName}</b>.</p>
      </div>

      <div className="invite-project-meta">
        <span><FolderKanban size={15} /><small>PROJECT</small><strong>{workspaceName}</strong></span>
        <span><ShieldCheck size={15} /><small>ACCESS</small><strong>Team member</strong></span>
      </div>

      <form className="invite-setup-form" onSubmit={(event) => void submit(event)}>
        <label><span><Mail size={13} />Email</span><input type="email" value={invitedEmail} readOnly autoComplete="email" /></label>
        <label><span><LockKeyhole size={13} />Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" placeholder="At least 8 characters" required /></label>
        <label><span><LockKeyhole size={13} />Confirm password</span><input className={confirmPassword && !passwordsMatch ? "is-invalid" : ""} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" placeholder="Enter the same password again" required /></label>
        {error && <p className="invite-error" role="alert">{error}</p>}
        <button className="invite-primary" type="submit" disabled={busy || password.length < 8 || !passwordsMatch}>{busy ? <LoaderCircle className="spin" size={15} /> : null}<span>Create account and join</span>{!busy && <ArrowRight size={15} />}</button>
      </form>

      <p className="invite-security"><LockKeyhole size={12} />This link verifies your invited email. Later, sign in normally with this email and password.</p>
    </section>
  </main>;
}

export function InvalidInvitation() {
  return <main className="invite-page"><section className="invite-card invite-invalid"><header className="invite-brand"><BrandMark title="Scenelith" /><span>SCENELITH</span></header><div className="invite-heading"><p className="eyebrow">TEAM ACCESS</p><h1>Invitation unavailable</h1><p>This link is invalid, expired, or has already been used.</p></div><a className="invite-primary" href="/canvas">Open Scenelith<ArrowRight size={15} /></a></section></main>;
}
