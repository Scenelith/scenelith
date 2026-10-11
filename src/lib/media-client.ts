'use client';
type MediaAsset={id:string;url:string;downloadUrl:string};
export type MediaJobResult={asset:MediaAsset;metadata?:{duration?:number};plan?:{duration:number}};
export type MediaJobStatus={id:string;status:string;stage:string;error?:string;result?:MediaJobResult};
/** Only replay an explicit preparation response, which is issued before paid admission. */
export async function fetchAfterMediaPreparation(url:string,init:RequestInit):Promise<Response>{
  for(;;){
    const response=await fetch(url,init);
    if(response.status!==202)return response;
    const body=await response.clone().json().catch(()=>null) as MediaJobStatus|null;
    if(!body?.id || !body.stage)return response;
    await waitForMediaResult(body,undefined,init.signal||undefined);
  }
}
// Repeating admission with the same spec finds the durable job after navigation/reload.
export async function runMediaOperation(projectId:string,spec:unknown,onProgress?:(stage:string)=>void,signal?:AbortSignal):Promise<MediaJobResult>{
  const response=await fetch('/api/media/jobs',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({projectId,requestKey:crypto.randomUUID(),spec}),signal});
  const job=await response.json() as MediaJobStatus;
  // Only an explicit rollout switch selects the legacy API. Worker/network failure never does.
  if(response.status===503 && job.error==='MEDIA_QUEUE_DISABLED')return legacyMediaOperation(projectId,spec,signal);
  if(!response.ok)throw new Error(job.error||'Could not prepare media');
  return waitForMediaResult(job,onProgress,signal);
}
export async function waitForMediaResult(job:MediaJobStatus,onProgress?:(stage:string)=>void,signal?:AbortSignal):Promise<MediaJobResult>{
  const id=job.id;let failures=0;
  while(!['completed','failed','cancelled'].includes(job.status)){
    onProgress?.(job.stage);
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},1500);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
    try{
      const status=await fetch(`/api/media/jobs/${id}`,{cache:'no-store',signal});
      if(status.status===404 || status.status===403)throw new Error('Media is no longer available');
      if(!status.ok){if(++failures>=3)throw new Error('Cannot read media status. Retry to resume the saved job.');continue;}
      job=await status.json();failures=0;
    }catch(error){if(signal?.aborted || ++failures>=3)throw error;}
  }
  if(job.status!=='completed' || !job.result?.asset)throw new Error(job.error||'Media preparation failed');
  return job.result;
}

async function legacyMediaOperation(projectId:string,input:unknown,signal?:AbortSignal):Promise<MediaJobResult>{
  const spec=input as {operation:string;range?:{id:string;start:number;end:number};assetId?:string;time?:number;assets?:unknown[];audioMode?:string};
  const payload=spec.operation==='segment'?{projectId,assetId:spec.range?.id,start:spec.range?.start,end:spec.range?.end,segmentId:crypto.randomUUID()}:
    spec.operation==='frame'?{projectId,assetId:spec.assetId,time:spec.time}:
    spec.operation==='export'?{projectId,filename:'video-export.mp4',assets:spec.assets,audioMode:spec.audioMode}:null;
  if(!payload)throw new Error('Media preparation is not enabled yet');
  const response=await fetchAfterMediaPreparation(`/api/assets/${spec.operation}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal});
  if(!response.ok){const error=await response.json().catch(()=>null);throw new Error(error?.error||'Could not prepare media');}
  if(spec.operation==='export'){
    const url=URL.createObjectURL(await response.blob());setTimeout(()=>URL.revokeObjectURL(url),300_000);
    return {asset:{id:'',url,downloadUrl:url}};
  }
  const body=await response.json();
  return {asset:{...body.asset,downloadUrl:`${body.asset.url}?download=1`},metadata:{duration:body.asset.durationSeconds}};
}
