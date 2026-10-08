import { z } from 'zod';
import { db, userCanAccessWorkspace } from '@/lib/postgres-db';
const schema=z.object({workspaceId:z.string().uuid(),kind:z.enum(['character','video']),settings:z.record(z.string(),z.unknown())});
export async function readStudioDraft(userId:string,workspaceId:string,kind:string) {
 if(!await userCanAccessWorkspace(userId,workspaceId))return Response.json({error:'Workspace not found'},{status:404});
 const row=await db.prepare('SELECT settings_json FROM studio_drafts WHERE workspace_id=? AND user_id=? AND kind=?').get(workspaceId,userId,kind) as {settings_json:string}|undefined;
 return Response.json({settings:row?JSON.parse(row.settings_json):null});
}
export async function saveStudioDraft(userId:string,input:unknown) {
 let body;try{body=schema.parse(input);}catch{return Response.json({error:'Invalid draft'},{status:400});}
 if(!await userCanAccessWorkspace(userId,body.workspaceId))return Response.json({error:'Workspace not found'},{status:404});
 await db.prepare(`INSERT INTO studio_drafts(workspace_id,user_id,kind,settings_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,user_id,kind) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at`).run(body.workspaceId,userId,body.kind,JSON.stringify(body.settings),new Date().toISOString());
 return Response.json({saved:true});
}
