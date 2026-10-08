import { requireApiUser } from '@/lib/auth';
import { db, userCanAccessWorkspace } from '@/lib/postgres-db';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get('workspaceId') || '';
  const kind = params.get('kind');
  if (!['image', 'video', 'audio'].includes(kind || '')) return Response.json({error:'Choose a media type'}, {status:400});
  if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({error:'Workspace not found'}, {status:404});
  const rows = await db.prepare(`SELECT id,filename,mime_type,size_bytes,metadata_json FROM assets WHERE workspace_id=? AND mime_type LIKE ? ORDER BY created_at DESC,id LIMIT 200`).all(workspaceId, `${kind}/%`) as {id:string;filename:string;mime_type:string;size_bytes:number;metadata_json:string}[];
  return Response.json({assets:rows.map(row=>({...row,url:`/api/assets/${row.id}`,metadata:JSON.parse(row.metadata_json||'{}')}))});
}
