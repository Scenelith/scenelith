import { createHash, randomBytes } from "node:crypto";
import { db, ensureStarterProject, userCanAccessWorkspace, workspaceRoleForUser } from "@/lib/postgres-db";
import { teamUsageEntitlement } from "@/modules/usage";

export type TeamAccessSelection = Array<{ workspaceId: string; projectIds: string[] }>;

export type TeamAccessWorkspace = {
  workspaceId: string;
  name: string;
  canvases: Array<{ projectId: string; name: string }>;
};

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  role: "owner" | "member";
  joinedAt: string;
  access: TeamAccessSelection;
};

export type TeamInvitation = {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  lastSentAt: string | null;
  sendCount: number;
  deliveryFailed: boolean;
  createdAt: string;
  access: TeamAccessSelection;
};

export class TeamError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function normalizedEmail(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

function invitationToken() {
  return randomBytes(32).toString("base64url");
}

function invitationTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function expireInvitations(workspaceId?: string) {
  const now = new Date().toISOString();
  if (workspaceId) {
    await db.prepare("UPDATE workspace_invitations SET status = 'expired', updated_at = ? WHERE workspace_id = ? AND status = 'pending' AND expires_at <= ?")
      .run(now, workspaceId, now);
  } else {
    await db.prepare("UPDATE workspace_invitations SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?")
      .run(now, now);
  }
}

export async function teamEntitlement(workspaceId: string) {
  return await teamUsageEntitlement(workspaceId);
}

function groupedAccess(rows: Array<{ workspace_id: string; project_id: string }>): TeamAccessSelection {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const projects = grouped.get(row.workspace_id) || [];
    if (!projects.includes(row.project_id)) projects.push(row.project_id);
    grouped.set(row.workspace_id, projects);
  }
  return [...grouped.entries()].map(([workspaceId, projectIds]) => ({ workspaceId, projectIds }));
}

export async function teamAccessCatalog(anchorWorkspaceId: string, ownerUserId: string): Promise<TeamAccessWorkspace[]> {
  if (await workspaceRoleForUser(ownerUserId, anchorWorkspaceId) !== "owner") throw new TeamError("Workspace not found", 404);
  const rows = await db.prepare(`SELECT w.id AS workspace_id, w.name AS workspace_name, p.id AS project_id, p.name AS project_name
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    LEFT JOIN projects p ON p.workspace_id = w.id
    WHERE wm.user_id = ? AND wm.role = 'owner'
    ORDER BY CASE WHEN w.id = ? THEN 0 ELSE 1 END, lower(w.name), p.updated_at DESC`)
    .all(ownerUserId, anchorWorkspaceId) as Array<{ workspace_id: string; workspace_name: string; project_id: string | null; project_name: string | null }>;
  const workspaces = new Map<string, TeamAccessWorkspace>();
  for (const row of rows) {
    const workspace = workspaces.get(row.workspace_id) || { workspaceId: row.workspace_id, name: row.workspace_name, canvases: [] };
    if (row.project_id) workspace.canvases.push({ projectId: row.project_id, name: row.project_name || "Untitled canvas" });
    workspaces.set(row.workspace_id, workspace);
  }
  return [...workspaces.values()];
}

async function normalizeAccessSelection(anchorWorkspaceId: string, ownerUserId: string, access?: TeamAccessSelection) {
  if (!access) {
    const starter = await ensureStarterProject(anchorWorkspaceId);
    access = [{ workspaceId: anchorWorkspaceId, projectIds: [starter.id] }];
  }
  if (!Array.isArray(access) || access.length === 0 || access.length > 50) throw new TeamError("Choose at least one canvas", 400);
  const requested = new Map<string, Set<string>>();
  for (const group of access) {
    if (!group?.workspaceId || !Array.isArray(group.projectIds) || !group.projectIds.length) continue;
    const projects = requested.get(group.workspaceId) || new Set<string>();
    for (const projectId of group.projectIds) if (projectId) projects.add(projectId);
    requested.set(group.workspaceId, projects);
  }
  const flat = [...requested.entries()].flatMap(([workspaceId, projectIds]) => [...projectIds].map((projectId) => ({ workspaceId, projectId })));
  if (!flat.length || flat.length > 250) throw new TeamError("Choose between 1 and 250 canvases", 400);
  const verifyWorkspace = db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner'");
  const verifyProject = db.prepare("SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?");
  for (const grant of flat) {
    if (!await verifyWorkspace.get(grant.workspaceId, ownerUserId) || !await verifyProject.get(grant.projectId, grant.workspaceId)) {
      throw new TeamError("One of the selected canvases is not available", 404);
    }
  }
  return { flat, grouped: groupedAccess(flat.map((grant) => ({ workspace_id: grant.workspaceId, project_id: grant.projectId }))) };
}

async function anchorForMemberInWorkspace(memberUserId: string, workspaceId: string) {
  return await db.prepare(`SELECT tm.anchor_workspace_id, tm.owner_user_id
    FROM team_memberships tm
    JOIN team_canvas_grants grant_row
      ON grant_row.anchor_workspace_id = tm.anchor_workspace_id AND grant_row.member_user_id = tm.member_user_id
    JOIN workspace_members owner_membership
      ON owner_membership.workspace_id = grant_row.workspace_id AND owner_membership.user_id = tm.owner_user_id AND owner_membership.role = 'owner'
    WHERE tm.member_user_id = ? AND grant_row.workspace_id = ? LIMIT 1`)
    .get(memberUserId, workspaceId) as { anchor_workspace_id: string; owner_user_id: string } | undefined;
}

export async function teamSnapshot(workspaceId: string, viewerUserId: string) {
  const viewerRole = await workspaceRoleForUser(viewerUserId, workspaceId);
  if (!viewerRole) throw new TeamError("Workspace not found", 404);
  if (viewerRole === "member" && !await userCanAccessWorkspace(viewerUserId, workspaceId)) throw new TeamError("Workspace not found", 404);
  const relation = viewerRole === "member" ? await anchorForMemberInWorkspace(viewerUserId, workspaceId) : null;
  if (viewerRole === "member" && !relation) throw new TeamError("Workspace not found", 404);
  const ownerTeam = viewerRole === "owner" ? await db.prepare(`SELECT tm.anchor_workspace_id
    FROM team_memberships tm
    LEFT JOIN team_canvas_grants grant_row
      ON grant_row.anchor_workspace_id = tm.anchor_workspace_id AND grant_row.member_user_id = tm.member_user_id
    WHERE tm.owner_user_id = ?
    GROUP BY tm.anchor_workspace_id
    ORDER BY MAX(CASE WHEN grant_row.workspace_id = ? THEN 1 ELSE 0 END) DESC, MAX(tm.updated_at) DESC
    LIMIT 1`).get(viewerUserId, workspaceId) as { anchor_workspace_id: string } | undefined : null;
  const anchorWorkspaceId = viewerRole === "owner" ? ownerTeam?.anchor_workspace_id || workspaceId : relation!.anchor_workspace_id;
  const ownerUserId = viewerRole === "owner" ? viewerUserId : relation!.owner_user_id;
  await expireInvitations(anchorWorkspaceId);
  const entitlement = await teamEntitlement(anchorWorkspaceId);

  const owner = await db.prepare(`SELECT u.id AS user_id, u.name, u.email, wm.created_at
    FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND wm.user_id = ? AND wm.role = 'owner'`).get(
      workspaceId,
      ownerUserId,
    ) as { user_id: string; name: string; email: string; created_at: string } | undefined;
  const ownerFallback = owner || await db.prepare("SELECT id AS user_id, name, email, created_at FROM users WHERE id = ?").get(ownerUserId) as { user_id: string; name: string; email: string; created_at: string };

  const memberRows = viewerRole === "owner"
    ? await db.prepare(`SELECT u.id AS user_id, u.name, u.email, tm.created_at
        FROM team_memberships tm JOIN users u ON u.id = tm.member_user_id
        WHERE tm.anchor_workspace_id = ? AND tm.owner_user_id = ? ORDER BY lower(u.name), lower(u.email)`)
      .all(anchorWorkspaceId, ownerUserId) as Array<{ user_id: string; name: string; email: string; created_at: string }>
    : await db.prepare("SELECT id AS user_id, name, email, created_at FROM users WHERE id = ?").all(viewerUserId) as Array<{ user_id: string; name: string; email: string; created_at: string }>;

  const memberGrantRows = viewerRole === "owner"
    ? await db.prepare(`SELECT member_user_id, workspace_id, project_id FROM team_canvas_grants
        WHERE anchor_workspace_id = ? ORDER BY member_user_id, created_at, project_id`)
      .all(anchorWorkspaceId) as Array<{ member_user_id: string; workspace_id: string; project_id: string }>
    : await db.prepare(`SELECT member_user_id, workspace_id, project_id FROM team_canvas_grants
        WHERE anchor_workspace_id = ? AND member_user_id = ? ORDER BY created_at, project_id`)
      .all(anchorWorkspaceId, viewerUserId) as Array<{ member_user_id: string; workspace_id: string; project_id: string }>;
  const rawMemberAccess = new Map<string, Array<{ workspace_id: string; project_id: string }>>();
  for (const row of memberGrantRows) {
    const rows = rawMemberAccess.get(row.member_user_id) || [];
    rows.push({ workspace_id: row.workspace_id, project_id: row.project_id });
    rawMemberAccess.set(row.member_user_id, rows);
  }
  const memberAccessByUser = new Map<string, TeamAccessSelection>();
  for (const [memberUserId, rows] of rawMemberAccess) memberAccessByUser.set(memberUserId, groupedAccess(rows));
  const members: TeamMember[] = [
    { userId: ownerFallback.user_id, name: ownerFallback.name, email: ownerFallback.email, role: "owner", joinedAt: ownerFallback.created_at, access: [] },
    ...memberRows.filter((row) => row.user_id !== ownerFallback.user_id).map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      role: "member" as const,
      joinedAt: row.created_at,
      access: memberAccessByUser.get(row.user_id) || [],
    })),
  ];

  const invitations = viewerRole === "owner" ? await db.prepare(`SELECT id, invited_email, status, expires_at, last_sent_at, send_count, last_send_error, created_at
    FROM workspace_invitations WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(anchorWorkspaceId) as Array<{
      id: string; invited_email: string; status: TeamInvitation["status"]; expires_at: string; last_sent_at: string | null;
      send_count: number; last_send_error: string | null; created_at: string;
    }> : [];

  const invitationGrantRows = viewerRole === "owner" ? await db.prepare(`SELECT grant_row.invitation_id, grant_row.workspace_id, grant_row.project_id
    FROM workspace_invitation_grants grant_row
    JOIN workspace_invitations invitation ON invitation.id = grant_row.invitation_id
    WHERE invitation.workspace_id = ? AND invitation.status = 'pending'
    ORDER BY grant_row.invitation_id, grant_row.created_at, grant_row.project_id`)
    .all(anchorWorkspaceId) as Array<{ invitation_id: string; workspace_id: string; project_id: string }> : [];
  const rawInvitationAccess = new Map<string, Array<{ workspace_id: string; project_id: string }>>();
  for (const row of invitationGrantRows) {
    const rows = rawInvitationAccess.get(row.invitation_id) || [];
    rows.push({ workspace_id: row.workspace_id, project_id: row.project_id });
    rawInvitationAccess.set(row.invitation_id, rows);
  }
  const invitationAccessById = new Map<string, TeamAccessSelection>();
  for (const [invitationId, rows] of rawInvitationAccess) invitationAccessById.set(invitationId, groupedAccess(rows));
  const accessOptions = viewerRole === "owner" ? await teamAccessCatalog(anchorWorkspaceId, ownerUserId) : [];

  return {
    viewerRole,
    anchorWorkspaceId,
    entitlement,
    seatCount: viewerRole === "owner" ? members.length : null,
    pendingCount: viewerRole === "owner" ? invitations.length : null,
    members,
    invitations: invitations.map((row): TeamInvitation => ({
      id: row.id,
      email: row.invited_email,
      status: row.status,
      expiresAt: row.expires_at,
      lastSentAt: row.last_sent_at,
      sendCount: row.send_count,
      deliveryFailed: Boolean(row.last_send_error),
      createdAt: row.created_at,
      access: invitationAccessById.get(row.id) || [],
    })),
    accessOptions,
  };
}

async function requireOwnerWithSeat(workspaceId: string, ownerUserId: string) {
  if (await workspaceRoleForUser(ownerUserId, workspaceId) !== "owner") throw new TeamError("Workspace not found", 404);
  const snapshot = await teamSnapshot(workspaceId, ownerUserId);
  if (!snapshot.entitlement.enabled) throw new TeamError("Team invitations require a Studio plan", 403);
  if ((snapshot.seatCount || 0) + (snapshot.pendingCount || 0) >= snapshot.entitlement.seatLimit) {
    throw new TeamError(`All ${snapshot.entitlement.seatLimit} Studio seats are already assigned or invited`, 409);
  }
  return snapshot;
}

async function replaceInvitationGrants(invitationId: string, rows: Array<{ workspaceId: string; projectId: string }>) {
  const now = new Date().toISOString();
  await db.prepare("DELETE FROM workspace_invitation_grants WHERE invitation_id = ?").run(invitationId);
  const insert = db.prepare("INSERT INTO workspace_invitation_grants (invitation_id, workspace_id, project_id, created_at) VALUES (?, ?, ?, ?)");
  for (const row of rows) await insert.run(invitationId, row.workspaceId, row.projectId, now);
}

export async function createTeamInvitation(input: { workspaceId: string; ownerUserId: string; email: string; access?: TeamAccessSelection }) {
  return await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`team-seats:${input.workspaceId}`);
    const email = normalizedEmail(input.email);
    if (!email) throw new TeamError("Enter a valid email", 400);
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`team-invite-email:${email}`);
    await requireOwnerWithSeat(input.workspaceId, input.ownerUserId);
    const access = await normalizeAccessSelection(input.workspaceId, input.ownerUserId, input.access);
    if (await db.prepare("SELECT 1 FROM users WHERE lower(email) = ?").get(email)) throw new TeamError("This email already has a Scenelith account", 409);
    if (await db.prepare("SELECT 1 FROM workspace_invitations WHERE lower(invited_email) = ? AND status = 'pending' AND expires_at > ?").get(email, new Date().toISOString())) {
      throw new TeamError("This email already has an active team invitation", 409);
    }
    const id = crypto.randomUUID();
    const token = invitationToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare(`INSERT INTO workspace_invitations
      (id, workspace_id, invited_email, invited_by_user_id, role, token_hash, status, expires_at, send_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'member', ?, 'pending', ?, 1, ?, ?)`).run(
        id, input.workspaceId, email, input.ownerUserId, invitationTokenHash(token), expiresAt, now.toISOString(), now.toISOString(),
      );
    await replaceInvitationGrants(id, access.flat);
    return { id, token, email, expiresAt, attempt: 1, access: access.grouped };
  })();
}

export async function updateTeamInvitationAccess(input: { workspaceId: string; ownerUserId: string; invitationId: string; access: TeamAccessSelection }) {
  return await db.transaction(async () => {
    if (await workspaceRoleForUser(input.ownerUserId, input.workspaceId) !== "owner") throw new TeamError("Workspace not found", 404);
    const invitation = await db.prepare("SELECT 1 FROM workspace_invitations WHERE id = ? AND workspace_id = ? AND status = 'pending'")
      .get(input.invitationId, input.workspaceId);
    if (!invitation) throw new TeamError("Invitation not found", 404);
    const access = await normalizeAccessSelection(input.workspaceId, input.ownerUserId, input.access);
    await replaceInvitationGrants(input.invitationId, access.flat);
  })();
}

export async function prepareInvitationResend(input: { workspaceId: string; ownerUserId: string; invitationId: string }) {
  if (await workspaceRoleForUser(input.ownerUserId, input.workspaceId) !== "owner") throw new TeamError("Workspace not found", 404);
  await expireInvitations(input.workspaceId);
  const entitlement = await teamEntitlement(input.workspaceId);
  if (!entitlement.enabled) throw new TeamError("Team invitations require a Studio plan", 403);
  const invite = await db.prepare(`SELECT invited_email, send_count, last_sent_at FROM workspace_invitations
    WHERE id = ? AND workspace_id = ? AND status = 'pending'`).get(input.invitationId, input.workspaceId) as { invited_email: string; send_count: number; last_sent_at: string | null } | undefined;
  if (!invite) throw new TeamError("Invitation not found", 404);
  if (invite.send_count >= 10) throw new TeamError("Revoke this invitation and create a new one if the email still needs access", 429);
  if (invite.last_sent_at && Date.now() - Date.parse(invite.last_sent_at) < 60_000) throw new TeamError("Wait a minute before sending this invitation again", 429);
  const token = invitationToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const attempt = invite.send_count + 1;
  await db.prepare(`UPDATE workspace_invitations SET token_hash = ?, expires_at = ?, send_count = ?, last_send_error = NULL, updated_at = ?
    WHERE id = ?`).run(invitationTokenHash(token), expiresAt, attempt, now.toISOString(), input.invitationId);
  return { id: input.invitationId, token, email: invite.invited_email, expiresAt, attempt };
}

export async function recordInvitationDelivery(input: { invitationId: string; providerEmailId?: string; error?: string }) {
  const now = new Date().toISOString();
  await db.prepare("UPDATE workspace_invitations SET last_sent_at = ?, provider_email_id = ?, last_send_error = ?, updated_at = ? WHERE id = ?")
    .run(input.error ? null : now, input.providerEmailId || null, input.error || null, now, input.invitationId);
}

export async function revokeTeamInvitation(input: { workspaceId: string; ownerUserId: string; invitationId: string }) {
  if (await workspaceRoleForUser(input.ownerUserId, input.workspaceId) !== "owner") throw new TeamError("Workspace not found", 404);
  const changed = await db.prepare(`UPDATE workspace_invitations SET status = 'revoked', updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status = 'pending'`).run(new Date().toISOString(), input.invitationId, input.workspaceId);
  if (changed.changes !== 1) throw new TeamError("Invitation not found", 404);
}

async function replaceMemberGrants(input: { anchorWorkspaceId: string; ownerUserId: string; memberUserId: string; rows: Array<{ workspaceId: string; projectId: string }> }) {
  const now = new Date().toISOString();
  await db.prepare("DELETE FROM team_canvas_grants WHERE anchor_workspace_id = ? AND member_user_id = ?").run(input.anchorWorkspaceId, input.memberUserId);
  const insertGrant = db.prepare(`INSERT INTO team_canvas_grants
    (anchor_workspace_id, member_user_id, workspace_id, project_id, granted_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertMembership = db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)");
  const selectedWorkspaces = new Set<string>();
  for (const row of input.rows) {
    selectedWorkspaces.add(row.workspaceId);
    await insertMembership.run(row.workspaceId, input.memberUserId, now);
    await insertGrant.run(input.anchorWorkspaceId, input.memberUserId, row.workspaceId, row.projectId, input.ownerUserId, now, now);
  }
  const ownedMemberWorkspaces = await db.prepare(`SELECT wm.workspace_id FROM workspace_members wm
    JOIN workspace_members owner ON owner.workspace_id = wm.workspace_id AND owner.user_id = ? AND owner.role = 'owner'
    WHERE wm.user_id = ? AND wm.role = 'member'`).all(input.ownerUserId, input.memberUserId) as Array<{ workspace_id: string }>;
  const removeMembership = db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'member'");
  for (const row of ownedMemberWorkspaces) if (!selectedWorkspaces.has(row.workspace_id)) await removeMembership.run(row.workspace_id, input.memberUserId);
}

export async function updateTeamMemberAccess(input: { workspaceId: string; ownerUserId: string; memberUserId: string; access: TeamAccessSelection }) {
  return await db.transaction(async () => {
    if (await workspaceRoleForUser(input.ownerUserId, input.workspaceId) !== "owner") throw new TeamError("Workspace not found", 404);
    const relation = await db.prepare("SELECT 1 FROM team_memberships WHERE anchor_workspace_id = ? AND owner_user_id = ? AND member_user_id = ?")
      .get(input.workspaceId, input.ownerUserId, input.memberUserId);
    if (!relation) throw new TeamError("Team member not found", 404);
    const previousProjectIds = (await db.prepare("SELECT project_id FROM team_canvas_grants WHERE anchor_workspace_id = ? AND member_user_id = ?")
      .all(input.workspaceId, input.memberUserId) as Array<{ project_id: string }>).map((row) => row.project_id);
    const access = await normalizeAccessSelection(input.workspaceId, input.ownerUserId, input.access);
    await replaceMemberGrants({ anchorWorkspaceId: input.workspaceId, ownerUserId: input.ownerUserId, memberUserId: input.memberUserId, rows: access.flat });
    await db.prepare("UPDATE team_memberships SET updated_at = ? WHERE anchor_workspace_id = ? AND member_user_id = ?")
      .run(new Date().toISOString(), input.workspaceId, input.memberUserId);
    const retained = new Set(access.flat.map((row) => row.projectId));
    return { revokedProjectIds: previousProjectIds.filter((projectId) => !retained.has(projectId)) };
  })();
}

export async function removeTeamMember(input: { workspaceId: string; ownerUserId: string; memberUserId: string }) {
  return await db.transaction(async () => {
    if (await workspaceRoleForUser(input.ownerUserId, input.workspaceId) !== "owner") throw new TeamError("Workspace not found", 404);
    const relation = await db.prepare("SELECT 1 FROM team_memberships WHERE anchor_workspace_id = ? AND owner_user_id = ? AND member_user_id = ?")
      .get(input.workspaceId, input.ownerUserId, input.memberUserId);
    if (!relation) throw new TeamError("Team member not found", 404);
    const account = await db.prepare("SELECT is_admin, team_managed FROM users WHERE id = ?").get(input.memberUserId) as { is_admin: number; team_managed: number } | undefined;
    if (!account) throw new TeamError("Team member not found", 404);
    if (account.is_admin) throw new TeamError("Administrator accounts cannot be deleted from team settings", 409);
    if (!account.team_managed) throw new TeamError("This legacy account cannot be deleted automatically", 409);
    const ownedWorkspace = await db.prepare("SELECT 1 FROM workspace_members WHERE user_id = ? AND role = 'owner' LIMIT 1").get(input.memberUserId);
    if (ownedWorkspace) throw new TeamError("This account owns another workspace and cannot be deleted here", 409);
    const revokedProjectIds = (await db.prepare("SELECT project_id FROM team_canvas_grants WHERE anchor_workspace_id = ? AND member_user_id = ?")
      .all(input.workspaceId, input.memberUserId) as Array<{ project_id: string }>).map((row) => row.project_id);
    const deleted = await db.prepare("DELETE FROM users WHERE id = ?").run(input.memberUserId);
    if (deleted.changes !== 1) throw new TeamError("Team member not found", 404);
    return { revokedProjectIds };
  })();
}

export async function invitationSummary(token: string) {
  if (!token || token.length > 200) return null;
  await expireInvitations();
  return await db.prepare(`SELECT wi.id, wi.invited_email, wi.expires_at, wi.invited_by_user_id, w.id AS workspace_id, w.name AS workspace_name,
      COALESCE(NULLIF(split_part(u.email::text, '@', 1), ''), u.email::text) AS inviter_name
    FROM workspace_invitations wi JOIN workspaces w ON w.id = wi.workspace_id JOIN users u ON u.id = wi.invited_by_user_id
    WHERE wi.token_hash = ? AND wi.status = 'pending' AND wi.expires_at > ?`).get(invitationTokenHash(token), new Date().toISOString()) as {
      id: string; invited_email: string; expires_at: string; invited_by_user_id: string; workspace_id: string; workspace_name: string; inviter_name: string;
    } | undefined;
}

type AcceptableInvitation = NonNullable<Awaited<ReturnType<typeof invitationSummary>>>;

export async function createInvitedTeamUser(input: { token: string; passwordHash: string }) {
  return await db.transaction(async () => {
    const invite = await invitationSummary(input.token);
    if (!invite) throw new TeamError("This invitation is invalid or has expired", 410);
    if (await db.prepare("SELECT 1 FROM users WHERE lower(email) = ?").get(normalizedEmail(invite.invited_email))) throw new TeamError("An account with this email already exists", 409);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const username = invite.invited_email.split("@", 1)[0]?.trim() || "Team member";
    await db.prepare(`INSERT INTO users
      (id, email, name, password_hash, email_verified_at, team_managed, is_admin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, true, false, ?, ?)`).run(userId, normalizedEmail(invite.invited_email), username, input.passwordHash, now, now, now);
    const accepted = await completeTeamInvitation(invite, { userId, userEmail: invite.invited_email, emailVerified: true });
    return { userId, email: normalizedEmail(invite.invited_email), ...accepted };
  })();
}

export async function pendingTeamInvitationsForUser(userId: string, userEmail: string) {
  await expireInvitations();
  const rows = await db.prepare(`SELECT wi.id, wi.invited_email, wi.expires_at, wi.invited_by_user_id, w.id AS workspace_id, w.name AS workspace_name,
      COALESCE(NULLIF(split_part(u.email::text, '@', 1), ''), u.email::text) AS inviter_name
    FROM workspace_invitations wi JOIN workspaces w ON w.id = wi.workspace_id JOIN users u ON u.id = wi.invited_by_user_id
    WHERE lower(wi.invited_email) = ? AND wi.status = 'pending' AND wi.expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.anchor_workspace_id = wi.workspace_id AND tm.member_user_id = ?)
    ORDER BY wi.created_at DESC`).all(normalizedEmail(userEmail), new Date().toISOString(), userId) as AcceptableInvitation[];
  return Promise.all(rows.map(async (invite) => ({
    id: invite.id,
    workspaceId: invite.workspace_id,
    workspaceName: invite.workspace_name,
    inviterName: invite.inviter_name,
    expiresAt: invite.expires_at,
    available: (await teamEntitlement(invite.workspace_id)).enabled,
  })));
}

async function completeTeamInvitation(invite: AcceptableInvitation, input: { userId: string; userEmail: string; emailVerified: boolean }) {
  await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`team-seats:${invite.workspace_id}`);
  if (!input.emailVerified) throw new TeamError("Confirm your email before accepting this team invitation", 403);
  if (normalizedEmail(input.userEmail) !== normalizedEmail(invite.invited_email)) throw new TeamError("Sign in with the email address that received this invitation", 403);
  const entitlement = await teamEntitlement(invite.workspace_id);
  if (!entitlement.enabled) throw new TeamError("This workspace no longer has team access", 409);
  const seats = await db.prepare("SELECT COUNT(*) + 1 AS count FROM team_memberships WHERE anchor_workspace_id = ?")
    .get(invite.workspace_id) as { count: number };
  if (seats.count >= entitlement.seatLimit) throw new TeamError("This workspace has no available team seats", 409);
  const grants = await db.prepare("SELECT workspace_id, project_id FROM workspace_invitation_grants WHERE invitation_id = ?")
    .all(invite.id) as Array<{ workspace_id: string; project_id: string }>;
  const normalized = await normalizeAccessSelection(invite.workspace_id, invite.invited_by_user_id, groupedAccess(grants));
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO team_memberships (anchor_workspace_id, owner_user_id, member_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(invite.workspace_id, invite.invited_by_user_id, input.userId, now, now);
  await replaceMemberGrants({ anchorWorkspaceId: invite.workspace_id, ownerUserId: invite.invited_by_user_id, memberUserId: input.userId, rows: normalized.flat });
  const accepted = await db.prepare(`UPDATE workspace_invitations SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'`).run(input.userId, now, now, invite.id);
  if (accepted.changes !== 1) throw new TeamError("This invitation is invalid or has expired", 410);
  await db.prepare(`INSERT INTO notifications (id, recipient_user_id, kind, title, body, action_type, action_id, created_at)
    VALUES (?, ?, 'announcement', ?, ?, NULL, NULL, ?)`).run(
      crypto.randomUUID(), invite.invited_by_user_id, "Team invitation accepted", `${input.userEmail} joined ${invite.workspace_name}.`, now,
    );
  return { workspaceId: normalized.grouped[0]?.workspaceId || invite.workspace_id, workspaceName: invite.workspace_name };
}

export async function acceptTeamInvitation(input: { token: string; userId: string; userEmail: string; emailVerified: boolean }) {
  return await db.transaction(async () => {
    const invite = await invitationSummary(input.token);
    if (!invite) throw new TeamError("This invitation is invalid or has expired", 410);
    return await completeTeamInvitation(invite, input);
  })();
}

export async function acceptPendingTeamInvitation(input: { invitationId: string; userId: string; userEmail: string; emailVerified: boolean }) {
  return await db.transaction(async () => {
    await expireInvitations();
    const invite = await db.prepare(`SELECT wi.id, wi.invited_email, wi.expires_at, wi.invited_by_user_id, w.id AS workspace_id, w.name AS workspace_name,
        COALESCE(NULLIF(split_part(u.email::text, '@', 1), ''), u.email::text) AS inviter_name
      FROM workspace_invitations wi JOIN workspaces w ON w.id = wi.workspace_id JOIN users u ON u.id = wi.invited_by_user_id
      WHERE wi.id = ? AND lower(wi.invited_email) = ? AND wi.status = 'pending' AND wi.expires_at > ?`).get(
        input.invitationId, normalizedEmail(input.userEmail), new Date().toISOString(),
      ) as AcceptableInvitation | undefined;
    if (!invite) throw new TeamError("This invitation is invalid or has expired", 410);
    return await completeTeamInvitation(invite, input);
  })();
}
