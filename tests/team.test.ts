import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureTeamEntitlement } from "./distribution/team-entitlement-fixture";

let db: typeof import("./postgres-test-db")["db"];
let closeRelationalPool: typeof import("./postgres-test-db")["closeRelationalPool"];
let team: typeof import("../src/lib/team");
let userCanAccessWorkspace: typeof import("../src/lib/postgres-db")["userCanAccessWorkspace"];
let userCanManageWorkspace: typeof import("../src/lib/postgres-db")["userCanManageWorkspace"];
let userCanAccessProject: typeof import("../src/lib/postgres-db")["userCanAccessProject"];
let usageWorkspaceForUserProject: typeof import("../src/lib/postgres-db")["usageWorkspaceForUserProject"];
let usageWorkspaceForUserWorkspace: typeof import("../src/lib/postgres-db")["usageWorkspaceForUserWorkspace"];
let ensureDefaultWorkspace: typeof import("../src/lib/postgres-db")["ensureDefaultWorkspace"];
let listAccessibleProjectRows: typeof import("../src/lib/postgres-db")["listAccessibleProjectRows"];
let listAccessibleWorkspaceRows: typeof import("../src/lib/postgres-db")["listAccessibleWorkspaceRows"];
let rowToProjectListItem: typeof import("../src/lib/postgres-db")["rowToProjectListItem"];
let userCanAccessAsset: typeof import("../src/lib/postgres-db")["userCanAccessAsset"];

before(async () => {
  const testDb = await import("./postgres-test-db");
  ({ db, closeRelationalPool } = testDb);
  await testDb.resetTestDatabase();
  const database = await import("../src/lib/postgres-db");
  userCanAccessWorkspace = database.userCanAccessWorkspace;
  userCanManageWorkspace = database.userCanManageWorkspace;
  userCanAccessProject = database.userCanAccessProject;
  usageWorkspaceForUserProject = database.usageWorkspaceForUserProject;
  usageWorkspaceForUserWorkspace = database.usageWorkspaceForUserWorkspace;
  ensureDefaultWorkspace = database.ensureDefaultWorkspace;
  listAccessibleProjectRows = database.listAccessibleProjectRows;
  listAccessibleWorkspaceRows = database.listAccessibleWorkspaceRows;
  rowToProjectListItem = database.rowToProjectListItem;
  userCanAccessAsset = database.userCanAccessAsset;
  team = await import("../src/lib/team");
});

after(async () => {
  await closeRelationalPool();
});

async function seedUser(label: string, teamManaged = false) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const email = `${label}@example.test`;
  await db.prepare("INSERT INTO users (id, email, name, team_managed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, email, label, teamManaged ? 1 : 0, now, now);
  return { id, email };
}

async function seedWorkspace(label: string) {
  const owner = await seedUser(`${label}-owner`);
  const workspaceId = crypto.randomUUID();
  const now = new Date();
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(workspaceId, label, now.toISOString(), now.toISOString());
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(workspaceId, owner.id, now.toISOString());
  const entitlement = await configureTeamEntitlement(db, { ownerUserId: owner.id, workspaceId });
  const projectIds = [crypto.randomUUID(), crypto.randomUUID()];
  const insertProject = db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, ?, '{\"nodes\":[],\"edges\":[]}', ?, ?)");
  await insertProject.run(projectIds[0], workspaceId, `${label} Canvas A`, now.toISOString(), now.toISOString());
  await insertProject.run(projectIds[1], workspaceId, `${label} Canvas B`, now.toISOString(), now.toISOString());
  return { owner, workspaceId, projectIds, seatLimit: entitlement.seatLimit };
}

async function addMember(workspaceId: string, label: string) {
  const member = await seedUser(label, true);
  const now = new Date().toISOString();
  const owner = await db.prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'owner'").get(workspaceId) as { user_id: string };
  const project = await db.prepare("SELECT id FROM projects WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(workspaceId) as { id: string };
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(workspaceId, member.id, now);
  await db.prepare("INSERT INTO team_memberships (anchor_workspace_id, owner_user_id, member_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(workspaceId, owner.user_id, member.id, now, now);
  await db.prepare(`INSERT INTO team_canvas_grants
    (anchor_workspace_id, member_user_id, workspace_id, project_id, granted_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, member.id, workspaceId, project.id, owner.user_id, now, now);
  return member;
}

test("workspace owners can invite and raw invite tokens are never stored", async () => {
  const workspace = await seedWorkspace("invite-team");
  const invitation = await team.createTeamInvitation({ workspaceId: workspace.workspaceId, ownerUserId: workspace.owner.id, email: "Person@Example.test" });
  const stored = await db.prepare("SELECT invited_email, token_hash FROM workspace_invitations WHERE id = ?").get(invitation.id) as { invited_email: string; token_hash: string };
  assert.equal(stored.invited_email, "person@example.test");
  assert.notEqual(stored.token_hash, invitation.token);
  assert.equal(stored.token_hash.length, 64);

  const existing = await seedUser("existing-account");
  await assert.rejects(() => team.createTeamInvitation({ workspaceId: workspace.workspaceId, ownerUserId: workspace.owner.id, email: existing.email }), (error: unknown) => error instanceof team.TeamError && error.status === 409);
});

test("the distribution seat policy counts the owner, members and pending invitations", async () => {
  const workspace = await seedWorkspace("full-team");
  await addMember(workspace.workspaceId, "full-member-1");
  await addMember(workspace.workspaceId, "full-member-2");
  await addMember(workspace.workspaceId, "full-member-3");
  const pendingSeats = Math.max(0, workspace.seatLimit - 4);
  for (let index = 0; index < pendingSeats; index += 1) {
    await team.createTeamInvitation({ workspaceId: workspace.workspaceId, ownerUserId: workspace.owner.id, email: `seat-${index}@example.test` });
  }
  await assert.rejects(
    () => team.createTeamInvitation({ workspaceId: workspace.workspaceId, ownerUserId: workspace.owner.id, email: "overflow@example.test" }),
    (error: unknown) => error instanceof team.TeamError && error.status === 409,
  );
  const snapshot = await team.teamSnapshot(workspace.workspaceId, workspace.owner.id);
  assert.equal(snapshot.seatCount, 4);
  assert.equal(snapshot.pendingCount, pendingSeats);
  assert.equal(snapshot.entitlement.seatLimit, workspace.seatLimit);
});

test("an invitation creates one password account bound directly to the team", async () => {
  const workspace = await seedWorkspace("accept-team");
  const invitation = await team.createTeamInvitation({ workspaceId: workspace.workspaceId, ownerUserId: workspace.owner.id, email: "accept-member@example.test" });
  const account = await team.createInvitedTeamUser({ token: invitation.token, passwordHash: "stored-password-hash" });

  assert.equal(account.email, "accept-member@example.test");
  assert.equal(await userCanAccessWorkspace(account.userId, workspace.workspaceId), true);
  assert.equal(await userCanManageWorkspace(account.userId, workspace.workspaceId), false);
  assert.deepEqual(await db.prepare("SELECT name, password_hash, email_verified_at IS NOT NULL AS verified, team_managed FROM users WHERE id = ?").get(account.userId), {
    name: "accept-member",
    password_hash: "stored-password-hash",
    verified: 1,
    team_managed: 1,
  });
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE user_id = ? AND role = 'owner'").get(account.userId) as { count: number }).count, 0);
  await assert.rejects(() => team.createInvitedTeamUser({ token: invitation.token, passwordHash: "another-hash" }), (error: unknown) => error instanceof team.TeamError && error.status === 410);
});

test("one unregistered email cannot receive competing active invitations", async () => {
  const first = await seedWorkspace("first-invite-team");
  const second = await seedWorkspace("second-invite-team");
  await team.createTeamInvitation({ workspaceId: first.workspaceId, ownerUserId: first.owner.id, email: "new-member@example.test" });
  await assert.rejects(() => team.createTeamInvitation({ workspaceId: second.workspaceId, ownerUserId: second.owner.id, email: "new-member@example.test" }), (error: unknown) => error instanceof team.TeamError && error.status === 409);
});

test("members see only themselves and the owner without team counts", async () => {
  const workspace = await seedWorkspace("private-team");
  const first = await addMember(workspace.workspaceId, "private-member-1");
  await addMember(workspace.workspaceId, "private-member-2");
  await assert.rejects(() => team.createTeamInvitation({ workspaceId: workspace.workspaceId, ownerUserId: first.id, email: "blocked@example.test" }), (error: unknown) => error instanceof team.TeamError && error.status === 404);
  await assert.rejects(() => team.removeTeamMember({ workspaceId: workspace.workspaceId, ownerUserId: first.id, memberUserId: workspace.owner.id }), (error: unknown) => error instanceof team.TeamError && error.status === 404);
  const snapshot = await team.teamSnapshot(workspace.workspaceId, first.id);
  assert.equal(snapshot.invitations.length, 0);
  assert.equal(snapshot.members.length, 2);
  assert.equal(snapshot.seatCount, null);
  assert.equal(snapshot.pendingCount, null);
  assert.equal(snapshot.members.find((member) => member.userId === workspace.owner.id)?.email, workspace.owner.email);
  assert.equal(snapshot.members.find((member) => member.userId === first.id)?.email, first.email);
});

test("an owner grants several projects while every unselected canvas remains inaccessible", async () => {
  const primary = await seedWorkspace("scoped-primary");
  const secondaryId = crypto.randomUUID();
  const secondaryProjects = [crypto.randomUUID(), crypto.randomUUID()];
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Secondary project', ?, ?)").run(secondaryId, now, now);
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(secondaryId, primary.owner.id, now);
  const insertProject = db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, ?, '{\"nodes\":[],\"edges\":[]}', ?, ?)");
  await insertProject.run(secondaryProjects[0], secondaryId, "Secondary A", now, now);
  await insertProject.run(secondaryProjects[1], secondaryId, "Secondary B", now, now);

  const invitation = await team.createTeamInvitation({
    workspaceId: primary.workspaceId,
    ownerUserId: primary.owner.id,
    email: "scoped-member@example.test",
    access: [
      { workspaceId: primary.workspaceId, projectIds: [primary.projectIds[0]] },
      { workspaceId: secondaryId, projectIds: [secondaryProjects[1]] },
    ],
  });
  const account = await team.createInvitedTeamUser({ token: invitation.token, passwordHash: "stored-password-hash" });
  assert.equal(await userCanAccessWorkspace(account.userId, primary.workspaceId), true);
  assert.equal(await userCanAccessWorkspace(account.userId, secondaryId), true);
  assert.equal(await userCanAccessProject(account.userId, primary.projectIds[0]), true);
  assert.equal(await userCanAccessProject(account.userId, primary.projectIds[1]), false);
  assert.equal(await userCanAccessProject(account.userId, secondaryProjects[0]), false);
  assert.equal(await userCanAccessProject(account.userId, secondaryProjects[1]), true);
  assert.equal(await usageWorkspaceForUserProject(account.userId, secondaryProjects[1]), primary.workspaceId);
  assert.equal(await usageWorkspaceForUserWorkspace(account.userId, secondaryId), primary.workspaceId);
  assert.equal(await usageWorkspaceForUserProject(primary.owner.id, secondaryProjects[1]), secondaryId);

  const grantedAssetId = crypto.randomUUID();
  const blockedAssetId = crypto.randomUUID();
  const sharedAssetId = crypto.randomUUID();
  const mismatchedAssetId = crypto.randomUUID();
  const insertAsset = db.prepare(`INSERT INTO assets
    (id, workspace_id, project_id, kind, filename, storage_path, mime_type, created_at)
    VALUES (?, ?, ?, 'image', ?, ?, 'image/png', ?)`);
  await insertAsset.run(grantedAssetId, primary.workspaceId, primary.projectIds[0], "granted.png", "granted.png", now);
  await insertAsset.run(blockedAssetId, primary.workspaceId, primary.projectIds[1], "blocked.png", "blocked.png", now);
  await insertAsset.run(sharedAssetId, primary.workspaceId, null, "shared.png", "shared.png", now);
  await insertAsset.run(mismatchedAssetId, primary.workspaceId, secondaryProjects[1], "mismatched.png", "mismatched.png", now);
  assert.equal(await userCanAccessAsset(account.userId, grantedAssetId), true);
  assert.equal(await userCanAccessAsset(account.userId, blockedAssetId), false);
  assert.equal(await userCanAccessAsset(account.userId, sharedAssetId), true);
  assert.equal(await userCanAccessAsset(primary.owner.id, mismatchedAssetId), false);
  assert.deepEqual((await listAccessibleProjectRows(account.userId)).map((row) => String(row.id)).sort(), [primary.projectIds[0], secondaryProjects[1]].sort());
  assert.deepEqual((await listAccessibleWorkspaceRows(account.userId)).map((row) => String(row.id)).sort(), [primary.workspaceId, secondaryId].sort());
  const compactProject = rowToProjectListItem((await listAccessibleProjectRows(account.userId))[0]);
  assert.deepEqual(compactProject.graph, { nodes: [], edges: [] });
  assert.ok(compactProject.summary);
  const ownerSnapshotFromSecondary = await team.teamSnapshot(secondaryId, primary.owner.id);
  assert.equal(ownerSnapshotFromSecondary.anchorWorkspaceId, primary.workspaceId);
  assert.equal(ownerSnapshotFromSecondary.members.some((member) => member.userId === account.userId), true);
  const memberSnapshotFromSecondary = await team.teamSnapshot(secondaryId, account.userId);
  assert.equal(memberSnapshotFromSecondary.members.length, 2);
  assert.equal(memberSnapshotFromSecondary.seatCount, null);

  await team.updateTeamMemberAccess({
    workspaceId: primary.workspaceId,
    ownerUserId: primary.owner.id,
    memberUserId: account.userId,
    access: [{ workspaceId: primary.workspaceId, projectIds: [primary.projectIds[1]] }],
  });
  assert.equal(await userCanAccessProject(account.userId, primary.projectIds[0]), false);
  assert.equal(await userCanAccessProject(account.userId, primary.projectIds[1]), true);
  assert.equal(await userCanAccessWorkspace(account.userId, secondaryId), false);
  assert.equal(await usageWorkspaceForUserProject(account.userId, secondaryProjects[1]), null);
  assert.deepEqual((await listAccessibleProjectRows(account.userId)).map((row) => String(row.id)), [primary.projectIds[1]]);
  assert.deepEqual((await listAccessibleWorkspaceRows(account.userId)).map((row) => String(row.id)), [primary.workspaceId]);
});

test("team access remains active under the distribution policy", async () => {
  const workspace = await seedWorkspace("active-team");
  const member = await addMember(workspace.workspaceId, "active-member");
  assert.equal(await userCanAccessWorkspace(member.id, workspace.workspaceId), true);
  assert.equal(await usageWorkspaceForUserWorkspace(member.id, workspace.workspaceId), workspace.workspaceId);
  assert.equal(await usageWorkspaceForUserProject(member.id, workspace.projectIds[0]), workspace.workspaceId);
  assert.equal((await ensureDefaultWorkspace(member.id))?.id, workspace.workspaceId);
});

test("a malformed cross-workspace grant cannot authorize a canvas or usage", async () => {
  const anchor = await seedWorkspace("integrity-anchor");
  const foreign = await seedWorkspace("integrity-foreign");
  const member = await seedUser("integrity-member", true);
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(anchor.workspaceId, member.id, now);
  await db.prepare("INSERT INTO team_memberships (anchor_workspace_id, owner_user_id, member_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(anchor.workspaceId, anchor.owner.id, member.id, now, now);
  await db.prepare(`INSERT INTO team_canvas_grants
    (anchor_workspace_id, member_user_id, workspace_id, project_id, granted_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      anchor.workspaceId, member.id, anchor.workspaceId, foreign.projectIds[0], anchor.owner.id, now, now,
    );
  assert.equal(await userCanAccessWorkspace(member.id, anchor.workspaceId), false);
  assert.equal(await userCanAccessProject(member.id, foreign.projectIds[0]), false);
  assert.equal(await usageWorkspaceForUserWorkspace(member.id, anchor.workspaceId), null);
  assert.equal(await usageWorkspaceForUserProject(member.id, foreign.projectIds[0]), null);
});

test("removing a managed team member deletes the entire login account", async () => {
  const workspace = await seedWorkspace("remove-team");
  const member = await addMember(workspace.workspaceId, "removed-member");
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    crypto.randomUUID(), member.id, `session-${member.id}`, new Date(Date.now() + 86_400_000).toISOString(), now, now,
  );
  const invitation = await team.createTeamInvitation({ workspaceId: workspace.workspaceId, ownerUserId: workspace.owner.id, email: "revoked@example.test" });
  await team.revokeTeamInvitation({ workspaceId: workspace.workspaceId, ownerUserId: workspace.owner.id, invitationId: invitation.id });
  assert.equal(await team.invitationSummary(invitation.token), undefined);
  await team.removeTeamMember({ workspaceId: workspace.workspaceId, ownerUserId: workspace.owner.id, memberUserId: member.id });
  assert.equal(await userCanAccessWorkspace(member.id, workspace.workspaceId), false);
  assert.equal(await db.prepare("SELECT 1 FROM users WHERE id = ?").get(member.id), undefined);
  assert.equal(await db.prepare("SELECT 1 FROM sessions WHERE user_id = ?").get(member.id), undefined);
});

test("Resend invitation requests carry the stable idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.RESEND_API_KEY;
  const originalPublicUrl = process.env.PUBLIC_URL;
  process.env.RESEND_API_KEY = "test-key";
  process.env.PUBLIC_URL = "https://scenelith.test";
  let request: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const { sendTeamInvitationEmail } = await import("../src/lib/email");
    const result = await sendTeamInvitationEmail({ email: "invitee@example.test", inviterEmail: "owner@example.test", workspaceName: "Studio", token: "secret-token", invitationId: "invite-1", attempt: 2 });
    assert.deepEqual(result, { ok: true, id: "email_123" });
    assert.equal(request?.url, "https://api.resend.com/emails");
    assert.equal(new Headers(request?.init?.headers).get("Idempotency-Key"), "team-invite-invite-1-2");
    assert.match(String(request?.init?.body), /https:\/\/scenelith\.test\/invite\/secret-token/);
    assert.match(String(request?.init?.body), /CONNECTED WORKSPACE/);
    assert.match(String(request?.init?.body), /secure link creates your team login/);
    assert.match(String(request?.init?.body), /owner invited you to join Studio/);
    assert.match(String(request?.init?.body), /scenelith-mark-email\.png/);
    assert.match(String(request?.init?.body), /#151516/);
    assert.doesNotMatch(String(request?.init?.body), /#121513|#17201c|#090b0a/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalKey;
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = originalPublicUrl;
  }
});
