import { createMediaJob } from './repository';
/** Invoke inside the asset publication transaction so admission survives request loss. */
export async function enqueueMediaAnalysis(userId:string,asset:{id:string;projectId?:string|null;workspaceId:string;mimeType:string},accepted=false){
  if((!accepted && process.env.SCENELITH_MEDIA_QUEUE_ENABLED!=='true') || !/^(video|audio)\//.test(asset.mimeType))return;
  return createMediaJob(userId,{...(asset.projectId?{projectId:asset.projectId}:{workspaceId:asset.workspaceId}),requestKey:`analyze:${asset.id}`,spec:{operation:'analyze',assetId:asset.id}});
}
