import { z } from 'zod';
import { requireApiUser, sameOriginRequest } from '@/lib/auth';
import { db, userCanAccessWorkspace } from '@/lib/postgres-db';
export const runtime = 'nodejs';
const schema=z.object({workspaceId:z.string().uuid(),kind:z.enum(['character','video']),settings:z.record(z.string(),z.unknown())});
export async function GET(request:Request) {
 const auth=await requireApiUser();if(auth.response)return auth.response;
 const params=new URL(request.url).searchParams,workspaceId=params.get('workspaceId')||'';
 if(!await userCanAccessWorkspace(auth.user.id,workspaceId))return Response.json({error:'Workspace not found'},{status:404});
 const row=await db.prepare('SELECT settings_json FROM studio_drafts WHERE workspace_id=? AND user_id=? AND kind=?').get(workspaceId,auth.user.id,params.get('kind')) as {settings_json:string}|undefined;
 return Response.json({settings:row?JSON.parse(row.settings_json):null});
}
export async function PUT(request:Request) {
 const auth=await requireApiUser();if(auth.response)return auth.response;
 if(!sameOriginRequest(request))return Response.json({error:'Invalid origin'},{status:403});
 const text=await request.text();if(text.length>300_000)return Response.json({error:'Draft is too large'},{status:413});
 let body;try{body=schema.parse(JSON.parse(text));}catch{return Response.json({error:'Invalid draft'},{status:400});}
 if(!await userCanAccessWorkspace(auth.user.id,body.workspaceId))return Response.json({error:'Workspace not found'},{status:404});
 await db.prepare(`INSERT INTO studio_drafts(workspace_id,user_id,kind,settings_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,user_id,kind) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at`).run(body.workspaceId,auth.user.id,body.kind,JSON.stringify(body.settings),new Date().toISOString());
 return Response.json({saved:true});
}
