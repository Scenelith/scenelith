import { z } from 'zod';
import { requireApiUser, sameOriginRequest } from '@/lib/auth';
import { db, userCanAccessWorkspace, userCanAccessAsset } from '@/lib/postgres-db';
export const runtime = 'nodejs';
const schema = z.object({workspaceId:z.string().uuid(), id:z.string().uuid(), name:z.string().trim().min(1).max(80), profile:z.record(z.string(),z.unknown()), assetIds:z.array(z.string().uuid()).max(100)});
export async function GET(request: Request) {
  const auth = await requireApiUser(); if(auth.response) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') || '';
  if(!await userCanAccessWorkspace(auth.user.id,workspaceId)) return Response.json({error:'Workspace not found'},{status:404});
  const rows = await db.prepare('SELECT id,name,profile_json FROM personas WHERE workspace_id = ? ORDER BY updated_at DESC').all(workspaceId) as {id:string;name:string;profile_json:string}[];
  const characters = await Promise.all(rows.map(async row => ({...row, profile:JSON.parse(row.profile_json || '{}'), assets:await db.prepare('SELECT id,filename,role,metadata_json FROM assets WHERE persona_id = ? ORDER BY sort_order,created_at,id').all(row.id)})));
  return Response.json({characters});
}
export async function PUT(request: Request) {
  const auth = await requireApiUser(); if(auth.response) return auth.response;
  if(!sameOriginRequest(request)) return Response.json({error:'Invalid origin'},{status:403});
  const raw = await request.text(); if(raw.length > 300_000) return Response.json({error:'Character settings are too large'},{status:413});
  let body; try { body = schema.parse(JSON.parse(raw)); } catch { return Response.json({error:'Invalid character settings'},{status:400}); }
  if(!await userCanAccessWorkspace(auth.user.id,body.workspaceId)) return Response.json({error:'Workspace not found'},{status:404});
  const previous = await db.prepare('SELECT workspace_id FROM personas WHERE id = ?').get(body.id) as {workspace_id:string} | undefined;
  if(previous && previous.workspace_id !== body.workspaceId) return Response.json({error:'Character not found'},{status:404});
  for(const id of body.assetIds) {
    const asset = await db.prepare('SELECT workspace_id,persona_id,mime_type FROM assets WHERE id = ?').get(id) as {workspace_id:string;persona_id:string|null;mime_type:string}|undefined;
    if(!asset || asset.workspace_id !== body.workspaceId || !asset.mime_type.startsWith('image/') || (asset.persona_id && asset.persona_id !== body.id) || !await userCanAccessAsset(auth.user.id,id)) return Response.json({error:'Reference image is unavailable'},{status:409});
  }
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare("INSERT INTO personas(id,workspace_id,name,notes,profile_json,created_at,updated_at) VALUES(?,?,?,'',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,profile_json=excluded.profile_json,updated_at=excluded.updated_at WHERE personas.workspace_id=excluded.workspace_id").run(body.id,body.workspaceId,body.name,JSON.stringify(body.profile),now,now);
    for(const id of body.assetIds) await db.prepare('UPDATE assets SET persona_id = ? WHERE id = ? AND workspace_id = ? AND (persona_id IS NULL OR persona_id = ?)').run(body.id,id,body.workspaceId,body.id);
  })();
  return Response.json({id:body.id});
}
