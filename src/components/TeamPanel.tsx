"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check, ChevronDown, Clock3, Copy, Crown, FolderKanban, LayoutGrid, LoaderCircle, Mail,
  RefreshCw, Settings2, ShieldCheck, Trash2, UserRound, UsersRound, X,
} from "lucide-react";
import type { UserRecord, WorkspaceRecord } from "@/lib/types";

type AccessSelection = Array<{ workspaceId: string; projectIds: string[] }>;
type AccessWorkspace = { workspaceId: string; name: string; canvases: Array<{ projectId: string; name: string }> };
type TeamPerson = { userId: string; name: string; email: string; role: "owner" | "member"; joinedAt: string; access: AccessSelection };
type TeamInvite = { id: string; email: string; expiresAt: string; lastSentAt: string | null; sendCount: number; deliveryFailed: boolean; createdAt: string; access: AccessSelection };

type TeamState = {
  viewerRole: "owner" | "member";
  anchorWorkspaceId: string;
  entitlement: { enabled: boolean; policyId: string; policyName: string; seatLimit: number };
  seatCount: number | null;
  pendingCount: number | null;
  members: TeamPerson[];
  invitations: TeamInvite[];
  accessOptions: AccessWorkspace[];
};

async function teamRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = await response.json().catch(() => ({})) as { team?: TeamState; error?: string; invitationLink?: string; delivery?: "email" | "manual" };
  if (!response.ok) throw new Error(body.error || "Could not update the team");
  return body;
}

function dateLabel(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function accessCount(access: AccessSelection) {
  return { projects: access.length, canvases: access.reduce((total, item) => total + item.projectIds.length, 0) };
}

function accessSummary(access: AccessSelection) {
  const count = accessCount(access);
  return `${count.projects} project${count.projects === 1 ? "" : "s"} · ${count.canvases} canvas${count.canvases === 1 ? "" : "es"}`;
}

function toggleCanvas(access: AccessSelection, workspaceId: string, projectId: string) {
  const current = access.find((item) => item.workspaceId === workspaceId)?.projectIds || [];
  const nextIds = current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId];
  const withoutWorkspace = access.filter((item) => item.workspaceId !== workspaceId);
  return nextIds.length ? [...withoutWorkspace, { workspaceId, projectIds: nextIds }] : withoutWorkspace;
}

function setWorkspaceAccess(access: AccessSelection, workspace: AccessWorkspace, selected: boolean) {
  const withoutWorkspace = access.filter((item) => item.workspaceId !== workspace.workspaceId);
  return selected && workspace.canvases.length
    ? [...withoutWorkspace, { workspaceId: workspace.workspaceId, projectIds: workspace.canvases.map((canvas) => canvas.projectId) }]
    : withoutWorkspace;
}

function AccessPicker({ options, value, onChange, compact = false }: { options: AccessWorkspace[]; value: AccessSelection; onChange: (access: AccessSelection) => void; compact?: boolean }) {
  const [expanded, setExpanded] = useState<string[]>(() => options[0]?.workspaceId ? [options[0].workspaceId] : []);
  const selectedCanvasIds = useMemo(() => new Set(value.flatMap((group) => group.projectIds)), [value]);
  const count = accessCount(value);

  return <div className={`team-access-picker ${compact ? "is-compact" : ""}`}>
    <header>
      <span><small>ACCESS SCOPE</small><strong>Projects and canvases</strong></span>
      <p>{count.canvases ? accessSummary(value) : "Nothing selected"}</p>
    </header>
    <div className="team-access-tree">
      {options.map((project) => {
        const selectedCount = project.canvases.filter((canvas) => selectedCanvasIds.has(canvas.projectId)).length;
        const allSelected = project.canvases.length > 0 && selectedCount === project.canvases.length;
        const isOpen = expanded.includes(project.workspaceId);
        return <section className={`team-access-project ${selectedCount ? "has-access" : ""}`} key={project.workspaceId}>
          <div className="team-access-project-row">
            <button className={`team-access-check ${allSelected ? "is-selected" : selectedCount ? "is-partial" : ""}`} type="button" onClick={() => onChange(setWorkspaceAccess(value, project, !allSelected))} aria-label={`${allSelected ? "Remove" : "Grant"} access to all canvases in ${project.name}`}>
              {allSelected ? <Check size={12} /> : selectedCount ? <span /> : null}
            </button>
            <button className="team-access-expand" type="button" onClick={() => setExpanded((current) => current.includes(project.workspaceId) ? current.filter((id) => id !== project.workspaceId) : [...current, project.workspaceId])}>
              <FolderKanban size={15} /><span><strong>{project.name}</strong><small>{selectedCount} of {project.canvases.length} canvases</small></span><ChevronDown className={isOpen ? "is-open" : ""} size={15} />
            </button>
          </div>
          {isOpen && <div className="team-access-canvases">
            {project.canvases.length ? project.canvases.map((canvas) => {
              const selected = selectedCanvasIds.has(canvas.projectId);
              return <button className={selected ? "is-selected" : ""} type="button" key={canvas.projectId} aria-pressed={selected} onClick={() => onChange(toggleCanvas(value, project.workspaceId, canvas.projectId))}>
                <span><LayoutGrid size={14} /></span><strong>{canvas.name}</strong>
              </button>;
            }) : <p className="team-access-empty">This project has no canvases yet.</p>}
          </div>}
        </section>;
      })}
    </div>
  </div>;
}

type AccessEditor = { kind: "member" | "invitation"; id: string; label: string; access: AccessSelection } | null;

export function TeamPanel({ user, workspace, onOpenPricing, onClose }: { user: UserRecord; workspace: WorkspaceRecord; onOpenPricing: () => void; onClose: () => void }) {
  const [team, setTeam] = useState<TeamState | null>(null);
  const [email, setEmail] = useState("");
  const [inviteAccess, setInviteAccess] = useState<AccessSelection>([]);
  const [editor, setEditor] = useState<AccessEditor>(null);
  const [busyKey, setBusyKey] = useState("");
  const [confirmMemberId, setConfirmMemberId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [manualInviteLink, setManualInviteLink] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await teamRequest(`/api/team?workspaceId=${encodeURIComponent(workspace.id)}`);
      if (result.team) setTeam(result.team);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this team");
    }
  }, [workspace.id]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const seatCount = team?.seatCount || 0;
  const pendingCount = team?.pendingCount || 0;
  const occupiedSeats = seatCount + pendingCount;
  const availableSeats = Math.max(0, (team?.entitlement.seatLimit || 1) - occupiedSeats);
  const isOwner = team?.viewerRole === "owner";
  const teamWorkspaceId = team?.anchorWorkspaceId || workspace.id;

  const runAction = async (key: string, url: string, method: "POST" | "PATCH" | "DELETE", success: string, body: unknown) => {
    setBusyKey(key); setError(""); setNotice("");
    try {
      const result = await teamRequest(url, { method, body: JSON.stringify(body) });
      if (result.team) setTeam(result.team);
      setNotice(success);
      setConfirmMemberId("");
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the team");
      await load();
      return null;
    } finally {
      setBusyKey("");
    }
  };

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    const invitedEmail = email.trim();
    if (!invitedEmail || !inviteAccess.length) return;
    const result = await runAction("invite", "/api/team/invitations", "POST", `Invitation sent to ${invitedEmail}`, { workspaceId: teamWorkspaceId, email: invitedEmail, access: inviteAccess });
    if (result) {
      setEmail("");
      setInviteAccess([]);
      if (result.invitationLink) {
        setManualInviteLink(`${window.location.origin}${result.invitationLink}`);
        setNotice("Invitation link created. Copy it and send it to your teammate.");
      } else {
        setManualInviteLink("");
      }
    }
  };

  const saveEditor = async () => {
    if (!editor || !editor.access.length) return;
    const path = editor.kind === "member" ? `/api/team/members/${editor.id}` : `/api/team/invitations/${editor.id}`;
    const ok = await runAction(`access:${editor.id}`, path, "PATCH", `Access updated for ${editor.label}`, { workspaceId: teamWorkspaceId, access: editor.access });
    if (ok) setEditor(null);
  };

  const resendInvitation = async (invitation: TeamInvite) => {
    const result = await runAction(`resend:${invitation.id}`, `/api/team/invitations/${invitation.id}/resend`, "POST", `Invitation resent to ${invitation.email}`, { workspaceId: teamWorkspaceId });
    if (result?.invitationLink) {
      setManualInviteLink(`${window.location.origin}${result.invitationLink}`);
      setNotice("A fresh invitation link was created. Copy it and send it to your teammate.");
    }
  };

  return <section className="team-library" aria-label="Team settings">
    <header className="hook-page-head team-library-head">
      <div className="hook-page-title"><p className="eyebrow">SCENELITH / WORKSPACE</p><div><h1>Team</h1><span>{workspace.name} · shared access and permissions</span></div></div>
      <button className="hook-page-close" type="button" onClick={onClose} title="Back to canvas" aria-label="Close team settings"><X size={18} /></button>
    </header>

    <div className="team-library-body">
      {!team && !error && <div className="team-loading"><LoaderCircle className="spin" size={17} />Loading team access</div>}
      {team && <>
        {isOwner ? <div className="team-overview">
          <div><span className="team-overview-icon"><UsersRound size={18} /></span><span><small>WORKSPACE ACCESS</small><strong>{seatCount} active · {pendingCount} pending</strong><p>You control invitations, members and canvas access.</p></span></div>
          <div className="team-seat-meter"><span><small>{team.entitlement.enabled ? `${availableSeats} seat${availableSeats === 1 ? "" : "s"} available` : "Team access paused"}</small><b>{occupiedSeats}/{team.entitlement.seatLimit}</b></span><div>{Array.from({ length: team.entitlement.seatLimit }, (_, index) => <i className={index < occupiedSeats ? "is-filled" : ""} key={index} />)}</div></div>
        </div> : <div className="team-member-overview"><ShieldCheck size={18} /><span><small>YOUR TEAM ACCESS</small><strong>Assigned workspace access</strong><p>Only you and the workspace owner are visible here. Team size and other members stay private.</p></span></div>}

        {isOwner && !team.entitlement.enabled && <div className="team-upgrade-gate">
          <span><Crown size={18} /></span><div><small>STUDIO TEAM ACCESS</small><h2>Invite up to four teammates</h2><p>Studio includes five total team seats, one shared credit pool, and owner-controlled canvas access.</p></div><button type="button" onClick={onOpenPricing}>View Studio</button>
        </div>}

        {isOwner && team.entitlement.enabled && <form className="team-invite" onSubmit={(event) => void invite(event)}>
          <div className="team-invite-email"><span><Mail size={16} /></span><label><strong>Invite a teammate</strong><small>Use an email that does not already have a Scenelith account.</small><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@company.com" maxLength={254} required /></label></div>
          <AccessPicker options={team.accessOptions} value={inviteAccess} onChange={setInviteAccess} />
          <footer><p><ShieldCheck size={13} />They will see only the selected projects and canvases.</p><button type="submit" disabled={busyKey === "invite" || !email.trim() || !accessCount(inviteAccess).canvases || availableSeats === 0}>{busyKey === "invite" ? <LoaderCircle className="spin" size={14} /> : <Mail size={14} />}{availableSeats === 0 ? "No seats left" : "Send invite"}</button></footer>
        </form>}

        {(error || notice) && <div className={`team-feedback ${error ? "is-error" : "is-success"}`}>{error ? <X size={13} /> : <Check size={13} />}{error || notice}</div>}
        {manualInviteLink && <div className="team-feedback is-success"><input aria-label="Invitation link" readOnly value={manualInviteLink} onFocus={(event) => event.currentTarget.select()} /><button type="button" onClick={() => void navigator.clipboard.writeText(manualInviteLink)}><Copy size={13} />Copy link</button></div>}

        <section className="team-section">
          <header><span><small>PEOPLE</small><h2>{isOwner ? "Team members" : "Workspace access"}</h2></span>{isOwner && <p>{seatCount} of {team.entitlement.seatLimit} seats</p>}</header>
          <div className="team-member-list">
            {team.members.map((member) => <article className="team-member" key={member.userId}>
              <span className="team-avatar">{(member.name || member.email || "M").slice(0, 1).toUpperCase()}</span>
              <div><strong>{member.name || member.email || "Team member"}{member.userId === user.id && <em>You</em>}</strong>{member.email && <small>{member.email}</small>}<p>{member.role === "owner" ? "Workspace owner" : accessSummary(member.access)}</p></div>
              <span className={`team-role is-${member.role}`}>{member.role === "owner" ? <Crown size={12} /> : <UserRound size={12} />}{member.role === "owner" ? "Owner" : "Member"}</span>
              {isOwner && member.role === "member" && <div className="team-member-actions">
                <button type="button" title="Edit access" aria-label={`Edit access for ${member.name || member.email}`} onClick={() => setEditor({ kind: "member", id: member.userId, label: member.name || member.email, access: member.access })}><Settings2 size={14} /></button>
                {confirmMemberId === member.userId ? <div className="team-remove-confirm"><span>Delete account?</span><button type="button" onClick={() => setConfirmMemberId("")}>Cancel</button><button type="button" disabled={busyKey === member.userId} onClick={() => void runAction(member.userId, `/api/team/members/${member.userId}`, "DELETE", `${member.name || member.email} account deleted`, { workspaceId: teamWorkspaceId })}>{busyKey === member.userId ? <LoaderCircle className="spin" size={12} /> : null}Delete</button></div> : <button type="button" title="Delete member account" aria-label={`Delete ${member.name || member.email} account`} onClick={() => setConfirmMemberId(member.userId)}><Trash2 size={14} /></button>}
              </div>}
            </article>)}
          </div>
        </section>

        {isOwner && team.invitations.length > 0 && <section className="team-section">
          <header><span><small>PENDING</small><h2>Invitations</h2></span><p>Links expire after 7 days</p></header>
          <div className="team-member-list">
            {team.invitations.map((invitation) => <article className="team-member is-invitation" key={invitation.id}>
              <span className="team-avatar"><Clock3 size={16} /></span><div><strong>{invitation.email}</strong><small>{invitation.deliveryFailed ? "Email delivery failed" : `Expires ${dateLabel(invitation.expiresAt)}`}</small><p>{accessSummary(invitation.access)}</p></div>
              <span className={`team-role ${invitation.deliveryFailed ? "is-failed" : ""}`}>{invitation.deliveryFailed ? "Needs resend" : "Pending"}</span>
              <div className="team-invite-actions"><button type="button" title="Edit access" aria-label={`Edit access for ${invitation.email}`} disabled={Boolean(busyKey)} onClick={() => setEditor({ kind: "invitation", id: invitation.id, label: invitation.email, access: invitation.access })}><Settings2 size={13} /></button><button type="button" title="Resend invite" aria-label={`Resend invitation to ${invitation.email}`} disabled={Boolean(busyKey)} onClick={() => void resendInvitation(invitation)}>{busyKey === `resend:${invitation.id}` ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button><button type="button" title="Revoke invite" aria-label={`Revoke invitation to ${invitation.email}`} disabled={Boolean(busyKey)} onClick={() => void runAction(`revoke:${invitation.id}`, `/api/team/invitations/${invitation.id}`, "DELETE", `Invitation to ${invitation.email} revoked`, { workspaceId: teamWorkspaceId })}>{busyKey === `revoke:${invitation.id}` ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</button></div>
            </article>)}
          </div>
        </section>}

        <div className="team-permissions"><ShieldCheck size={16} /><span><strong>{isOwner ? "Owner permissions" : "Member permissions"}</strong><p>{isOwner ? "Manage members and exact project access." : "Open and edit only the canvases assigned by the owner. Team size and all other members stay private."}</p></span></div>
      </>}
      {error && !team && <div className="team-loading is-error"><X size={17} />{error}<button type="button" onClick={() => void load()}>Try again</button></div>}
    </div>

    {editor && team && <div className="team-access-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}>
      <section className="team-access-modal" role="dialog" aria-modal="true" aria-label={`Edit access for ${editor.label}`}>
        <header><span><small>MEMBER ACCESS</small><h2>{editor.label}</h2></span><button type="button" onClick={() => setEditor(null)} aria-label="Close access settings"><X size={18} /></button></header>
        <AccessPicker compact options={team.accessOptions} value={editor.access} onChange={(access) => setEditor({ ...editor, access })} />
        <footer><div><button type="button" onClick={() => setEditor(null)}>Cancel</button><button type="button" disabled={!accessCount(editor.access).canvases || busyKey === `access:${editor.id}`} onClick={() => void saveEditor()}>{busyKey === `access:${editor.id}` ? <LoaderCircle className="spin" size={14} /> : null}Save access</button></div></footer>
      </section>
    </div>}
  </section>;
}
