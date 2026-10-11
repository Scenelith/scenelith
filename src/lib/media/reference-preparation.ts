import { createMediaJob } from './repository';
import { verifiedMediaMetadata } from './metadata';
import { MediaPending } from './compatibility';
import { MediaError } from './contracts';
import { db } from '../postgres-db';
import { readStorageObject } from '../storage';

export async function prepareReferenceAnalyses(userId:string,projectId:string,references:Array<{path:string;mimeType:string}>,accepted=false) {
  if(!accepted && process.env.SCENELITH_MEDIA_QUEUE_ENABLED!=='true')return;
  const jobs=await Promise.all(references.filter(r=>/^(video|audio)\//.test(r.mimeType)).map(async reference=>{
    const {asset}=await verifiedMediaMetadata(reference.path);
    return createMediaJob(userId,{projectId,requestKey:`analyze:${asset.id}`,spec:{operation:'analyze',assetId:asset.id}});
  }));
  const failed=jobs.find(j=>['failed','cancelled'].includes(j.status));
  if(failed)throw new MediaError(failed.error_code||'INVALID_REFERENCE_MEDIA',422);
  const pending=jobs.find(j=>j.status!=='completed');
  if(pending)throw new MediaPending(pending);
}

export type PreparedStoryboard=Array<{timeSeconds:number;dataUrl:string}>;
/** Run before entering metered prompt composition: retries only prepare media, never repeat a paid call. */
export async function preparePromptStoryboards(userId:string,projectId:string,references:Array<{path:string;mimeType:string;storyboard?:PreparedStoryboard}>) {
  if(process.env.SCENELITH_MEDIA_QUEUE_ENABLED!=='true')return;
  const videos=references.filter(r=>r.mimeType.startsWith('video/'));
  await prepareReferenceAnalyses(userId,projectId,videos);
  let budget=12;
  const groups=await Promise.all(videos.map(async reference=>{
    const count=Math.min(5,budget);budget-=count;
    if(count<3){reference.storyboard=[];return null;}
    const {asset,metadata}=await verifiedMediaMetadata(reference.path);
    const duration=metadata!.duration;
    const times=Array.from({length:count},(_,i)=>Math.min(Math.max(0,duration-1/Math.max(1,metadata!.fps)),duration*(.06+.88*i/(count-1))));
    const jobs=await Promise.all(times.map(time=>createMediaJob(userId,{projectId,requestKey:`prompt-frame:${asset.id}:${time}`,
      spec:{operation:'frame',assetId:asset.id,time,maxWidth:640}})));
    return {reference,times,jobs};
  }));
  for(const group of groups){
    if(!group)continue;
    const failed=group.jobs.find(j=>['failed','cancelled'].includes(j.status));
    if(failed)throw new MediaError(failed.error_code||'STORYBOARD_UNAVAILABLE',422);
    const pending=group.jobs.find(j=>j.status!=='completed');if(pending)throw new MediaPending(pending);
  }
  for(const group of groups){
    if(!group)continue;
    group.reference.storyboard=await Promise.all(group.jobs.map(async(job,i)=>{
      const asset=await db.prepare('SELECT storage_path FROM assets WHERE id=?').get(job.result_asset_id) as {storage_path:string};
      const data=await readStorageObject(asset.storage_path);
      return {timeSeconds:group.times[i],dataUrl:`data:image/png;base64,${data.toString('base64')}`};
    }));
  }
}
