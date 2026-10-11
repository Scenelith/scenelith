import { db } from '../postgres-db';
import { createMediaJob } from './repository';
import { mediaResponse } from './http';
import type { MediaSpec } from './contracts';
/** Never decodes/transcodes inside an asset GET. A pending derivative is explicit. */
export async function queuedAssetVariant(userId:string,source:{id:string;workspace_id:string|null;project_id:string|null},spec:MediaSpec,statusOnly=false) {
  const job=await createMediaJob(userId,{...(source.project_id?{projectId:source.project_id}:{workspaceId:source.workspace_id}),requestKey:`variant:${JSON.stringify(spec)}`,spec});
  if(statusOnly || job.status!=='completed')return mediaResponse(job,true);
  const asset=await db.prepare('SELECT storage_path,size_bytes,content_hash,mime_type,filename FROM assets WHERE id=?').get(job.result_asset_id) as
    {storage_path:string;size_bytes:number;content_hash:string|null;mime_type:string;filename:string}|undefined;
  if(!asset)return Response.json({error:'RESULT_UNAVAILABLE'},{status:404});
  return {storagePath:asset.storage_path,size:asset.size_bytes,contentHash:asset.content_hash,mimeType:asset.mime_type,filename:asset.filename,cacheControl:'private, no-store'};
}
