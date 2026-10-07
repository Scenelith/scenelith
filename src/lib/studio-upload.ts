import {createHash} from 'node:crypto';
import {db} from './postgres-db';
import {putStorageObject,deleteStorageObject,safeExtension} from './storage';
import {assertWorkspaceStorageCapacity} from './storage-lifecycle';
export async function persistStudioUpload(input:{id:string;workspaceId:string;projectId:string;bytes:Buffer;mimeType:string;name:string;metadata:Record<string,unknown>}){
 let written:string|undefined;
 try{return await db.transaction(async()=>{
  await db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').get(`studio-upload:${input.id}`);
  const hash=createHash('sha256').update(input.bytes).digest('hex');
  const prior=await db.prepare('SELECT workspace_id,content_hash FROM assets WHERE id=?').get(input.id) as {workspace_id:string;content_hash:string}|undefined;
  if(prior){if(prior.workspace_id!==input.workspaceId||prior.content_hash!==hash)throw new Error('Upload key belongs to another file');return input.id;}
  await assertWorkspaceStorageCapacity(input.workspaceId,input.bytes.length);
  const filename=`${input.id}${safeExtension(input.name,input.mimeType)}`;
  const stored=await putStorageObject(input.bytes,`workspaces/${input.workspaceId}/projects/${input.projectId}/references/${filename}`,{contentType:input.mimeType});written=stored.reference;
  const kind=input.mimeType.split('/')[0];
  await db.prepare(`INSERT INTO assets(id,workspace_id,project_id,kind,role,filename,storage_path,storage_provider,storage_bucket,object_key,size_bytes,content_hash,mime_type,metadata_json,created_at) VALUES(?,?,?,?,'library',?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.workspaceId,input.projectId,`library_${kind}`,filename,stored.reference,stored.provider,stored.bucket,stored.key,stored.size,stored.contentHash,input.mimeType,JSON.stringify({...input.metadata,originalName:input.name}),new Date().toISOString());
  return input.id;
 })();}catch(error){if(written)await deleteStorageObject(written).catch(()=>undefined);throw error;}
}
