import type { HookRecord, ProjectGraph, ProjectRecord, UserRecord, WorkspaceRecord } from "./types";
import { normalizeProjectGraph } from "./canvas-graph";
import { relationalDb } from "./relational-db";
import { teamUsageEntitlement } from "@/modules/usage";

export const db = relationalDb;

const emptyGraph: ProjectGraph = { nodes: [], edges: [] };
type ProjectSummary = NonNullable<ProjectRecord["summary"]>;

export type ProjectGraphSnapshot = {
  graph: ProjectGraph;
  revision: number;
  summary: ProjectSummary;
  updatedAt: string;
};

export type ProjectGraphWriteResult =
  | { ok: true; snapshot: ProjectGraphSnapshot }
  | { ok: false; snapshot: ProjectGraphSnapshot };

const configuredAdminEmails = String(process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLocaleLowerCase("en-US"))
  .filter(Boolean);

export function isConfiguredAdminEmail(email: string) {
  return configuredAdminEmails.includes(email.trim().toLocaleLowerCase("en-US"));
}

export function summarizeProjectGraph(graph: ProjectGraph): ProjectSummary {
  const nodes = graph.nodes || [];
  return {
    scenes: nodes.filter((node) => node.data.kind === "scene").length,
    prompts: nodes.filter((node) => node.data.kind === "prompt").length,
    outputs: nodes.filter((node) => node.data.kind === "generation" || Boolean(node.data.outputUrl)).length,
    previews: [],
  };
}

function parseProjectGraph(value: unknown) {
  try { return normalizeProjectGraph(JSON.parse(String(value || "{}")) as ProjectGraph); }
  catch { return emptyGraph; }
}

function parseProjectSummary(value: unknown, graph: ProjectGraph) {
  try {
    const parsed = JSON.parse(String(value || "{}")) as Partial<ProjectSummary>;
    if (Number.isFinite(parsed.scenes) && Number.isFinite(parsed.prompts) && Number.isFinite(parsed.outputs)) {
      return {
        scenes: Number(parsed.scenes),
        prompts: Number(parsed.prompts),
        outputs: Number(parsed.outputs),
        previews: Array.isArray(parsed.previews) ? parsed.previews : [],
      };
    }
  } catch {}
  return summarizeProjectGraph(graph);
}

async function recordProjectSnapshotVersion(projectId: string, revision: number, graphJson: string, summaryJson: string, createdAt: string) {
  const recentCutoff = new Date(new Date(createdAt).getTime() - 5 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM project_snapshot_versions WHERE project_id = ? AND created_at >= ?")
    .run(projectId, recentCutoff);
  await db.prepare(`INSERT INTO project_snapshot_versions
    (project_id, revision, graph_json, summary_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (project_id, revision) DO NOTHING`)
    .run(projectId, revision, graphJson, summaryJson, createdAt);
}

async function insertMissingProjectSnapshot(projectId: string) {
  const legacy = await db.prepare("SELECT graph_json, created_at, updated_at FROM projects WHERE id = ?").get(projectId) as
    | { graph_json: string; created_at: string; updated_at: string }
    | undefined;
  if (!legacy) return;
  const graph = parseProjectGraph(legacy.graph_json);
  await db.prepare(`INSERT INTO project_snapshots
    (project_id, revision, graph_json, summary_json, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?, ?)
    ON CONFLICT (project_id) DO NOTHING`)
    .run(projectId, JSON.stringify(graph), JSON.stringify(summarizeProjectGraph(graph)), legacy.created_at, legacy.updated_at);
  const snapshot = await db.prepare("SELECT revision, graph_json, summary_json, updated_at FROM project_snapshots WHERE project_id = ?").get(projectId) as
    | { revision: number; graph_json: string; summary_json: string; updated_at: string }
    | undefined;
  if (snapshot) await recordProjectSnapshotVersion(projectId, snapshot.revision, snapshot.graph_json, snapshot.summary_json, snapshot.updated_at);
}

export async function readProjectGraphSnapshot(projectId: string): Promise<ProjectGraphSnapshot> {
  let row = await db.prepare("SELECT revision, graph_json, summary_json, updated_at FROM project_snapshots WHERE project_id = ?").get(projectId) as
    | { revision: number; graph_json: string; summary_json: string; updated_at: string }
    | undefined;
  if (!row) {
    await insertMissingProjectSnapshot(projectId);
    row = await db.prepare("SELECT revision, graph_json, summary_json, updated_at FROM project_snapshots WHERE project_id = ?").get(projectId) as
      | { revision: number; graph_json: string; summary_json: string; updated_at: string }
      | undefined;
  }
  const graph = row ? parseProjectGraph(row.graph_json) : emptyGraph;
  return {
    graph,
    revision: Math.max(1, Number(row?.revision || 1)),
    summary: parseProjectSummary(row?.summary_json, graph),
    updatedAt: String(row?.updated_at || ""),
  };
}

export async function writeProjectGraphSnapshot(projectId: string, graphInput: ProjectGraph, options: { expectedRevision?: number; sourceRevision?: number; updatedAt?: string } = {}): Promise<ProjectGraphWriteResult> {
  const graph = normalizeProjectGraph(graphInput);
  const summary = summarizeProjectGraph(graph);
  const graphJson = JSON.stringify(graph);
  const summaryJson = JSON.stringify(summary);
  const updatedAt = options.updatedAt || new Date().toISOString();
  return await db.transaction(async () => {
    await insertMissingProjectSnapshot(projectId);
    const current = await db.prepare("SELECT revision, source_revision, graph_json, summary_json, updated_at FROM project_snapshots WHERE project_id = ? FOR UPDATE").get(projectId) as
      | { revision: number; source_revision: number; graph_json: string; summary_json: string; updated_at: string }
      | undefined;
    const currentRevision = Math.max(1, Number(current?.revision || 1));
    if (current && options.sourceRevision !== undefined && Number(current.source_revision || 0) >= options.sourceRevision) {
      return {
        ok: true as const,
        snapshot: {
          graph: parseProjectGraph(current.graph_json),
          revision: currentRevision,
          summary: parseProjectSummary(current.summary_json, parseProjectGraph(current.graph_json)),
          updatedAt: current.updated_at,
        },
      };
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
      return { ok: false as const, snapshot: await readProjectGraphSnapshot(projectId) };
    }
    const nextRevision = current ? currentRevision + 1 : 1;
    if (current) await recordProjectSnapshotVersion(projectId, currentRevision, current.graph_json, current.summary_json, current.updated_at);
    await db.prepare(`INSERT INTO project_snapshots
      (project_id, revision, source_revision, graph_json, summary_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        revision = excluded.revision,
        source_revision = excluded.source_revision,
        graph_json = excluded.graph_json,
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at`)
      .run(projectId, nextRevision, Math.max(Number(current?.source_revision || 0), Number(options.sourceRevision || 0)), graphJson, summaryJson, updatedAt, updatedAt);
    await recordProjectSnapshotVersion(projectId, nextRevision, graphJson, summaryJson, updatedAt);
    await db.prepare("UPDATE projects SET graph_json = ?, updated_at = ? WHERE id = ?").run(graphJson, updatedAt, projectId);
    return { ok: true as const, snapshot: { graph, revision: nextRevision, summary, updatedAt } };
  })();
}

export async function mutateProjectGraphSnapshot(projectId: string, mutator: (graph: ProjectGraph) => ProjectGraph, updatedAt = new Date().toISOString()) {
  return await db.transaction(async () => {
    const current = await readProjectGraphSnapshot(projectId);
    return await writeProjectGraphSnapshot(projectId, mutator(current.graph), { expectedRevision: current.revision, updatedAt });
  })();
}

export function rowToUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id), email: String(row.email), name: String(row.name || ""),
    isAdmin: Boolean(row.is_admin), emailVerified: Boolean(row.email_verified_at), createdAt: String(row.created_at),
  };
}

export function rowToWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: String(row.id), name: String(row.name), rolePrompt: String(row.role_prompt || ""),
    memberRole: row.member_role === "member" ? "member" : "owner",
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function rowToHook(row: Record<string, unknown>): HookRecord {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), projectId: row.project_id ? String(row.project_id) : null,
    parentHookId: row.parent_hook_id ? String(row.parent_hook_id) : null, sourceAssetId: row.source_asset_id ? String(row.source_asset_id) : null,
    sourceUrl: row.source_url ? String(row.source_url) : null, kind: String(row.kind) as HookRecord["kind"], text: String(row.text),
    angle: String(row.angle || ""), language: String(row.language || ""), views: Number(row.views_count || 0), createdAt: String(row.created_at),
  };
}

async function enabledTeamAnchorIds(userId: string) {
  const anchors = await db.prepare(`SELECT DISTINCT tm.anchor_workspace_id
    FROM team_memberships tm
    JOIN workspace_members anchor_owner_membership
      ON anchor_owner_membership.workspace_id = tm.anchor_workspace_id
      AND anchor_owner_membership.user_id = tm.owner_user_id
      AND anchor_owner_membership.role = 'owner'
    WHERE tm.member_user_id = ?`).all(userId) as Array<{ anchor_workspace_id: string }>;
  const decisions = await Promise.all(anchors.map(async ({ anchor_workspace_id }) => ({
    anchorWorkspaceId: anchor_workspace_id,
    enabled: (await teamUsageEntitlement(anchor_workspace_id)).enabled,
  })));
  return decisions.filter((decision) => decision.enabled).map((decision) => decision.anchorWorkspaceId);
}

export async function listAccessibleWorkspaceRows(userId: string) {
  const enabledAnchors = JSON.stringify(await enabledTeamAnchorIds(userId));
  return await db.prepare(`SELECT DISTINCT w.*, wm.role AS member_role,
      CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END AS role_sort
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    JOIN users account ON account.id = wm.user_id
    WHERE wm.user_id = ? AND (
      (wm.role = 'owner' AND account.team_managed = false)
      OR (wm.role = 'member' AND EXISTS (
        SELECT 1 FROM team_canvas_grants grant_row
        JOIN team_memberships tm ON tm.anchor_workspace_id = grant_row.anchor_workspace_id AND tm.member_user_id = grant_row.member_user_id
        JOIN projects granted_project ON granted_project.id = grant_row.project_id AND granted_project.workspace_id = grant_row.workspace_id
        JOIN workspace_members owner_membership ON owner_membership.workspace_id = grant_row.workspace_id AND owner_membership.user_id = tm.owner_user_id AND owner_membership.role = 'owner'
        JOIN workspace_members anchor_owner_membership ON anchor_owner_membership.workspace_id = tm.anchor_workspace_id AND anchor_owner_membership.user_id = tm.owner_user_id AND anchor_owner_membership.role = 'owner'
        WHERE grant_row.member_user_id = wm.user_id AND grant_row.workspace_id = w.id
          AND tm.anchor_workspace_id IN (SELECT jsonb_array_elements_text(?::jsonb))
      ))
    )
    ORDER BY role_sort, w.updated_at DESC`).all(userId, enabledAnchors) as Record<string, unknown>[];
}

export async function listAccessibleProjectRows(userId: string) {
  const enabledAnchors = JSON.stringify(await enabledTeamAnchorIds(userId));
  return await db.prepare(`SELECT DISTINCT
      p.id, p.workspace_id, p.name, p.source_url, p.status, p.created_at, p.updated_at,
      COALESCE(ps.revision, 1) AS graph_revision,
      COALESCE(ps.summary_json, '{"scenes":0,"prompts":0,"outputs":0,"previews":[]}'::jsonb) AS summary_json
    FROM projects p
    LEFT JOIN project_snapshots ps ON ps.project_id = p.id
    JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
    JOIN users account ON account.id = wm.user_id
    WHERE wm.user_id = ? AND (
      (wm.role = 'owner' AND account.team_managed = false)
      OR (wm.role = 'member' AND EXISTS (
        SELECT 1 FROM team_canvas_grants grant_row
        JOIN team_memberships tm ON tm.anchor_workspace_id = grant_row.anchor_workspace_id AND tm.member_user_id = grant_row.member_user_id
        JOIN projects granted_project ON granted_project.id = grant_row.project_id AND granted_project.workspace_id = grant_row.workspace_id
        JOIN workspace_members owner_membership ON owner_membership.workspace_id = grant_row.workspace_id AND owner_membership.user_id = tm.owner_user_id AND owner_membership.role = 'owner'
        JOIN workspace_members anchor_owner_membership ON anchor_owner_membership.workspace_id = tm.anchor_workspace_id AND anchor_owner_membership.user_id = tm.owner_user_id AND anchor_owner_membership.role = 'owner'
        WHERE grant_row.member_user_id = wm.user_id AND grant_row.project_id = p.id
          AND tm.anchor_workspace_id IN (SELECT jsonb_array_elements_text(?::jsonb))
      ))
    )
    ORDER BY p.updated_at DESC`).all(userId, enabledAnchors) as Record<string, unknown>[];
}

export async function ensureDefaultWorkspace(userId: string): Promise<WorkspaceRecord | null> {
  return await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`default-workspace:${userId}`);
    const account = await db.prepare("SELECT team_managed FROM users WHERE id = ?").get(userId) as { team_managed: number } | undefined;
    const existing = (await listAccessibleWorkspaceRows(userId))[0];
    if (existing) return rowToWorkspace(existing);
    if (account?.team_managed) return null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO workspaces (id, name, role_prompt, created_at, updated_at) VALUES (?, 'My App', '', ?, ?)").run(id, now, now);
    await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, userId, now);
    const row = await db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, unknown>;
    return rowToWorkspace(row);
  })();
}

export async function claimUnownedWorkspaces(userId: string) {
  const now = new Date().toISOString();
  const result = await db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
    SELECT w.id, ?, 'owner', ? FROM workspaces w
    WHERE NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id)
    ON CONFLICT (workspace_id, user_id) DO NOTHING`).run(userId, now);
  return result.changes;
}

export async function workspaceRoleForUser(userId: string, workspaceId: string) {
  const row = await db.prepare(`SELECT wm.role, u.team_managed
    FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.user_id = ? AND wm.workspace_id = ?`).get(userId, workspaceId) as { role: string; team_managed: number } | undefined;
  if (row?.role === "owner") return row.team_managed ? null : "owner" as const;
  return row?.role === "member" ? "member" as const : null;
}

export async function userCanManageWorkspace(userId: string, workspaceId: string) {
  return await workspaceRoleForUser(userId, workspaceId) === "owner";
}

const activeGrantForProjectSql = `SELECT grant_row.anchor_workspace_id
  FROM team_canvas_grants grant_row
  JOIN team_memberships tm ON tm.anchor_workspace_id = grant_row.anchor_workspace_id AND tm.member_user_id = grant_row.member_user_id
  JOIN projects granted_project ON granted_project.id = grant_row.project_id AND granted_project.workspace_id = grant_row.workspace_id
  JOIN workspace_members owner_membership ON owner_membership.workspace_id = grant_row.workspace_id AND owner_membership.user_id = tm.owner_user_id AND owner_membership.role = 'owner'
  JOIN workspace_members anchor_owner_membership ON anchor_owner_membership.workspace_id = tm.anchor_workspace_id AND anchor_owner_membership.user_id = tm.owner_user_id AND anchor_owner_membership.role = 'owner'
  WHERE grant_row.member_user_id = ? AND grant_row.project_id = ?
  ORDER BY tm.created_at ASC LIMIT 1`;

const activeGrantForWorkspaceSql = activeGrantForProjectSql
  .replace("grant_row.project_id = ?", "grant_row.workspace_id = ?");

async function entitledGrant(sql: string, userId: string, targetId: string) {
  const grant = await db.prepare(sql).get(userId, targetId) as { anchor_workspace_id: string } | undefined;
  if (!grant || !(await teamUsageEntitlement(grant.anchor_workspace_id)).enabled) return undefined;
  return grant;
}

export async function userCanAccessWorkspace(userId: string, workspaceId: string) {
  const role = await workspaceRoleForUser(userId, workspaceId);
  if (role === "owner") return true;
  if (role !== "member") return false;
  return Boolean(await entitledGrant(activeGrantForWorkspaceSql, userId, workspaceId));
}

export async function userCanAccessProject(userId: string, projectId: string) {
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project) return false;
  const role = await workspaceRoleForUser(userId, project.workspace_id);
  if (role === "owner") return true;
  if (role !== "member") return false;
  return Boolean(await entitledGrant(activeGrantForProjectSql, userId, projectId));
}

export async function workspaceIdForProject(projectId: string) {
  const row = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  return row?.workspace_id || null;
}

export async function usageWorkspaceForUserProject(userId: string, projectId: string) {
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project) return null;
  const role = await workspaceRoleForUser(userId, project.workspace_id);
  if (role === "owner") return project.workspace_id;
  if (role !== "member") return null;
  const grant = await entitledGrant(activeGrantForProjectSql, userId, projectId);
  return grant?.anchor_workspace_id || null;
}

export async function usageWorkspaceForUserWorkspace(userId: string, workspaceId: string) {
  const role = await workspaceRoleForUser(userId, workspaceId);
  if (role === "owner") return workspaceId;
  if (role !== "member") return null;
  const grant = await entitledGrant(activeGrantForWorkspaceSql, userId, workspaceId);
  return grant?.anchor_workspace_id || null;
}

export async function userCanAccessAsset(userId: string, assetId: string) {
  const asset = await db.prepare("SELECT workspace_id, project_id FROM assets WHERE id = ?").get(assetId) as { workspace_id: string | null; project_id: string | null } | undefined;
  if (!asset?.workspace_id) return false;
  if (!asset.project_id) return await userCanAccessWorkspace(userId, asset.workspace_id);
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(asset.project_id) as { workspace_id: string } | undefined;
  return project?.workspace_id === asset.workspace_id && await userCanAccessProject(userId, asset.project_id);
}

export async function userCanAccessGeneration(userId: string, generationId: string) {
  const generation = await db.prepare("SELECT project_id FROM generations WHERE id = ?").get(generationId) as { project_id: string } | undefined;
  return Boolean(generation && await userCanAccessProject(userId, generation.project_id));
}

export async function userCanAccessHook(userId: string, hookId: string) {
  const hook = await db.prepare("SELECT workspace_id, project_id FROM hooks WHERE id = ?").get(hookId) as { workspace_id: string; project_id: string | null } | undefined;
  if (!hook) return false;
  if (!hook.project_id) return await userCanAccessWorkspace(userId, hook.workspace_id);
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(hook.project_id) as { workspace_id: string } | undefined;
  return project?.workspace_id === hook.workspace_id && await userCanAccessProject(userId, hook.project_id);
}

export async function rowToProject(row: Record<string, unknown>, suppliedSnapshot?: ProjectGraphSnapshot): Promise<ProjectRecord> {
  const projectId = String(row.id);
  const snapshot = suppliedSnapshot || await readProjectGraphSnapshot(projectId);
  return {
    id: projectId, revision: snapshot.revision, name: String(row.name), sourceUrl: row.source_url ? String(row.source_url) : null,
    status: String(row.status), workspaceId: String(row.workspace_id || ""), graph: snapshot.graph, summary: snapshot.summary,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function rowToProjectListItem(row: Record<string, unknown>): ProjectRecord {
  const summary = parseProjectSummary(row.summary_json, emptyGraph);
  return {
    id: String(row.id), revision: Math.max(1, Number(row.graph_revision || 1)), name: String(row.name),
    sourceUrl: row.source_url ? String(row.source_url) : null, status: String(row.status), workspaceId: String(row.workspace_id || ""),
    graph: emptyGraph, summary, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export async function ensureStarterProject(workspaceId: string) {
  const welcomeNoteText = `Welcome to Scenelith\n\nPaste a TikTok video or slideshow link into the import field in the top bar, then click Import.\n\nUse the + button on the left to add an Assistant, Image Generator, Video Generator, or another note.\n\nConnect nodes by dragging from an output port to a compatible input. Then run the generator.\n\nDelete this note whenever you are ready.`;
  return await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`starter-project:${workspaceId}`);
    const existing = await db.prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1").get(workspaceId) as Record<string, unknown> | undefined;
    if (existing) return await rowToProject(existing);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const graph: ProjectGraph = { nodes: [{
      id: "welcome-note", type: "frameNode", position: { x: 260, y: 100 },
      data: { kind: "note", title: "Welcome to Scenelith", noteText: welcomeNoteText, noteColor: "yellow", nodeWidth: 330, nodeHeight: 410 },
    }], edges: [] };
    await db.prepare("INSERT INTO projects (id, workspace_id, name, status, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, workspaceId, "Canvas 01", "draft", JSON.stringify(graph), now, now);
    await insertMissingProjectSnapshot(id);
    const row = await db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown>;
    return await rowToProject(row);
  })();
}
