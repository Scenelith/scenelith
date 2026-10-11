import { createMediaJob } from './repository';
import { fingerprint } from './contracts';
import { waitForMediaJob,MediaPending } from './compatibility';
import type { ImportedAsset } from '../tiktok';
import type { postDetails } from '../tiktok-resolver';

export async function queuedTikTokImport(userId:string,projectId:string,url:string) {
  let job=await createMediaJob(userId,{projectId,requestKey:`tiktok:${fingerprint(url)}`,spec:{operation:'import',url}});
  job=await waitForMediaJob(userId,job);
  if(job.status!=='completed')throw new MediaPending(job);
  const result=JSON.parse(job.result_json!) as {assets:ImportedAsset[];metadata:{post:ReturnType<typeof postDetails>&{mediaType:string;totalBytes:number}}};
  return {assets:result.assets,post:result.metadata.post};
}
