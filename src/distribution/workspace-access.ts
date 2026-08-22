import { relationalDb as db } from "@/lib/relational-db";

export async function listAccessibleWorkspaceRows(userId: string) {
  return await db.prepare(`SELECT w.*, wm.role AS member_role, 0 AS role_sort
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ? AND wm.role = 'owner'
    ORDER BY w.updated_at DESC`).all(userId) as Record<string, unknown>[];
}

export async function listAccessibleProjectRows(userId: string) {
  return await db.prepare(`SELECT
      p.id, p.workspace_id, p.name, p.source_url, p.status, p.created_at, p.updated_at,
      COALESCE(ps.revision, 1) AS graph_revision,
      COALESCE(ps.summary_json, '{"scenes":0,"prompts":0,"outputs":0,"previews":[]}'::jsonb) AS summary_json
    FROM projects p
    LEFT JOIN project_snapshots ps ON ps.project_id = p.id
    JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = ? AND wm.role = 'owner'
    ORDER BY p.updated_at DESC`).all(userId) as Record<string, unknown>[];
}

export async function canUserCreateWorkspace(_userId: string) {
  return true;
}

export async function workspaceRoleForUser(userId: string, workspaceId: string) {
  const row = await db.prepare(`SELECT role FROM workspace_members
    WHERE user_id = ? AND workspace_id = ?`).get(userId, workspaceId) as { role: string } | undefined;
  return row?.role === "owner" ? "owner" as const : null;
}

export async function userCanManageWorkspace(userId: string, workspaceId: string) {
  return await workspaceRoleForUser(userId, workspaceId) === "owner";
}

export async function userCanAccessWorkspace(userId: string, workspaceId: string) {
  return await workspaceRoleForUser(userId, workspaceId) === "owner";
}

export async function userCanAccessProject(userId: string, projectId: string) {
  const row = await db.prepare(`SELECT 1 AS allowed
    FROM projects p
    JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE p.id = ? AND wm.user_id = ? AND wm.role = 'owner'`).get(projectId, userId) as { allowed: number } | undefined;
  return Boolean(row);
}

export async function usageWorkspaceForUserProject(userId: string, projectId: string) {
  const row = await db.prepare(`SELECT p.workspace_id
    FROM projects p
    JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE p.id = ? AND wm.user_id = ? AND wm.role = 'owner'`).get(projectId, userId) as { workspace_id: string } | undefined;
  return row?.workspace_id || null;
}

export async function usageWorkspaceForUserWorkspace(userId: string, workspaceId: string) {
  return await userCanAccessWorkspace(userId, workspaceId) ? workspaceId : null;
}
