import { db, ensureDefaultWorkspace, userCanAccessWorkspace } from './postgres-db';

export async function studioWorkspace(userId: string, requested?: string | null) {
  const workspaceId = requested || (await ensureDefaultWorkspace(userId))?.id;
  if (!workspaceId || !await userCanAccessWorkspace(userId, workspaceId)) throw new Error('Workspace not found');
  return db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))').get(`studio:${workspaceId}`);
    const existing = await db.prepare("SELECT id FROM projects WHERE workspace_id = ? AND purpose = 'studio'").get(workspaceId) as {id:string} | undefined;
    const id = existing?.id || crypto.randomUUID();
    if (!existing) {
      const now = new Date().toISOString();
      await db.prepare("INSERT INTO projects (id,workspace_id,name,purpose,status,graph_json,created_at,updated_at) VALUES (?,?,'Studio','studio','draft',?,?,?)").run(id, workspaceId, JSON.stringify({nodes:[],edges:[]}), now, now);
    }
    return {workspaceId, projectId:id, userId};
  })();
}
