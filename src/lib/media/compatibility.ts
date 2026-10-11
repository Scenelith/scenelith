import { db } from '../postgres-db';
import { streamStorageObject } from '../storage';
import { createMediaJob,getMediaJob } from './repository';
import { fingerprint,MediaError,jobView,type MediaJob } from './contracts';
import { mediaErrorResponse } from './http';
import { videoMasterExportRequestSchema } from '../video-export';

export async function waitForMediaJob(userId:string,job:MediaJob,milliseconds=25_000) {
  const deadline=Date.now()+Math.min(milliseconds,25_000);
  while(['queued','running','retry_wait'].includes(job.status) && Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,Math.min(250,deadline-Date.now())));
    job=await getMediaJob(userId,job.id);
  }
  if(job.status==='failed' || job.status==='cancelled')throw new MediaError(job.error_code||'MEDIA_CANCELLED',422);
  return job;
}
function pending(job:MediaJob){return Response.json({...jobView(job),retry:true,message:'Media is preparing. Retry with the same settings or read statusUrl.'},
  {status:202,headers:{'retry-after':'2','cache-control':'private, no-store'}});}
export async function queuedSegment(userId:string,input:unknown){
  const raw=input as {projectId?:string;assetId?:string;start?:number;end?:number;modelId?:string;segmentId?:string}|null;
  try{
    const spec={operation:'segment',range:{id:raw?.assetId,start:raw?.start,end:raw?.end},modelId:raw?.modelId};
    let job=await createMediaJob(userId,{projectId:raw?.projectId,requestKey:`segment:${fingerprint(spec)}`,spec});
    job=await waitForMediaJob(userId,job);
    if(job.status!=='completed')return pending(job);
    const result=JSON.parse(job.result_json!);
    return Response.json({asset:{...result.asset,durationSeconds:result.plan?.duration ?? result.metadata?.duration}});
  }catch(error){return mediaErrorResponse(error);}
}
export async function queuedExport(userId:string,input:unknown){
  try{
    const parsed=videoMasterExportRequestSchema.safeParse(input);if(!parsed.success)throw new MediaError('INVALID_MEDIA_REQUEST');
    const spec={operation:'export',assets:parsed.data.assets,audioMode:parsed.data.audioMode};
    let job=await createMediaJob(userId,{projectId:parsed.data.projectId,requestKey:`export:${fingerprint(spec)}`,spec});
    job=await waitForMediaJob(userId,job);if(job.status!=='completed')return pending(job);
    const asset=await db.prepare('SELECT storage_path,size_bytes FROM assets WHERE id=?').get(job.result_asset_id) as {storage_path:string;size_bytes:number}|undefined;
    if(!asset)throw new MediaError('RESULT_UNAVAILABLE',404);
    return new Response(await streamStorageObject(asset.storage_path),{headers:{'content-type':'video/mp4','content-length':String(asset.size_bytes),
      'content-disposition':`attachment; filename="video-export.mp4"; filename*=UTF-8''${encodeURIComponent(parsed.data.filename)}`,'cache-control':'private, no-store'}});
  }catch(error){return mediaErrorResponse(error);}
}
export async function queuedFrame(userId:string,input:unknown){
  const raw=input as {projectId?:string;assetId?:string;time?:number}|null;
  try{
    const spec={operation:'frame',assetId:raw?.assetId,time:raw?.time};
    let job=await createMediaJob(userId,{projectId:raw?.projectId,requestKey:`frame:${fingerprint(spec)}`,spec});
    job=await waitForMediaJob(userId,job);if(job.status!=='completed')return pending(job);
    return Response.json({asset:{...JSON.parse(job.result_json!).asset,time:raw?.time,mimeType:'image/png'}});
  }catch(error){return mediaErrorResponse(error);}
}
export class MediaPending extends Error {
  constructor(public job:MediaJob){super('Media is preparing. Read get_media_job, then repeat the original action with the current canvas revision.');}
}
export async function preparedDerivative(userId:string,projectId:string,spec:unknown){
  let job=await createMediaJob(userId,{projectId,requestKey:`derivative:${fingerprint(spec)}`,spec});
  job=await waitForMediaJob(userId,job);if(job.status!=='completed')throw new MediaPending(job);
  return JSON.parse(job.result_json!) as {asset:{id:string;url:string};metadata?:{duration:number};plan?:{duration:number}};
}
