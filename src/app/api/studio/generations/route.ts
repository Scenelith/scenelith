import { requireApiUser } from '@/lib/auth';
import { db, userCanAccessWorkspace } from '@/lib/postgres-db';
import { generationClientState, type GenerationStateRow } from '@/lib/generation-state';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const auth = await requireApiUser(); if (auth.response) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') || '';
  if (!await userCanAccessWorkspace(auth.user.id,workspaceId)) return Response.json({error:'Workspace not found'},{status:404});
  const rows = await db.prepare(`SELECT g.* FROM generations g JOIN projects p ON p.id=g.project_id WHERE p.workspace_id=? AND p.purpose='studio' ORDER BY g.created_at DESC LIMIT 50`).all(workspaceId) as GenerationStateRow[];
  return Response.json({generations:await Promise.all(rows.map(generationClientState))});
}
