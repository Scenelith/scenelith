import { mkdir, mkdtemp, rm, stat, statfs, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../postgres-db';
import { downloadStorageFile, putStorageFile, storageFileDestination, deleteStorageObject, type StoredObject } from '../storage';
import { assertWorkspaceStorageCapacity } from '../storage-lifecycle';
import { mediaConfig } from './config';
import { MediaError, type MediaJob, type MediaInput, type MediaSpec } from './contracts';
import { assertJobAccess, renewMediaLease, failMediaJob } from './repository';
import { displayGeometry, probeFile, frameBoundaries, quantizeRange, type MediaMetadata } from './probe';
import { planProcessing, type PlannedClip } from './planner';
import { mediaProcess } from './process';
import { importMedia } from './import';
import { extractSceneFiles } from './scenes';
import { renderPlan, type LocalMedia } from './render';
import { retainMediaStaging, claimMediaCleanup } from './staging';
import { mediaTransfer } from './transfer';

export type MediaFileOutcome={file:string;mime:string;metadata?:unknown;kind?:string;role?:string;filename?:string};
type Outcome={assetId?:string;file?:string;mime?:string;metadata?:unknown;plan?:unknown;files?:MediaFileOutcome[]};
const fileExtension=(mime?:string)=>mime==='image/png'?'png':mime==='image/jpeg'?'jpg':mime==='video/quicktime'?'mov':'mp4';
async function processJob(job:MediaJob,dir:string,signal:AbortSignal,timings:Record<string,number>):Promise<Outcome> {
  const spec=JSON.parse(job.spec_json) as MediaSpec,inputs=JSON.parse(job.inputs_json) as MediaInput[];
  const media=new Map<string,LocalMedia>();
  const config=mediaConfig();let totalBytes=0;
  if(spec.operation==='import')return importMedia(spec.url,dir,signal,timings);
  for(const input of inputs){
    signal.throwIfAborted();
    if(input.size_bytes>config.maxFileBytes)throw new MediaError('MEDIA_FILE_LIMIT');
    const space=await statfs(dir);
    if(Number(space.bavail)*Number(space.bsize)<Number(input.size_bytes)*2)throw new MediaError('MEDIA_DISK_FULL');
    const path=join(dir,`${media.size}.source`),start=performance.now();
    totalBytes+=await mediaTransfer(signal,config.transferTimeoutMs,transferSignal=>downloadStorageFile(input.storage_path,path,Math.min(config.maxFileBytes,config.maxTempBytes-totalBytes),transferSignal,{size:input.size_bytes,hash:input.content_hash}));
    timings.downloadMs=(timings.downloadMs||0)+performance.now()-start;
    const cached=await db.prepare('SELECT metadata_json FROM media_asset_analysis WHERE asset_id=? AND content_identity=? AND analyzer_version=1').get(input.id,input.identity) as {metadata_json:string}|undefined;
    const probeStart=performance.now();
    const metadata:MediaMetadata=cached?JSON.parse(cached.metadata_json):await probeFile(path,signal);
    timings.analysisMs=(timings.analysisMs||0)+performance.now()-probeStart;
    if(!cached)await db.prepare(`INSERT INTO media_asset_analysis(asset_id,content_identity,analyzer_version,metadata_json) VALUES(?,?,1,?) ON CONFLICT DO NOTHING`).run(input.id,input.identity,JSON.stringify(metadata));
    await renewMediaLease(job);
    await db.prepare(`UPDATE assets SET metadata_json=(metadata_json::jsonb || ?::jsonb) WHERE id=? AND storage_path=?`).run(
      JSON.stringify({durationSeconds:metadata.duration,...displayGeometry(metadata),analyzerVersion:1}),input.id,input.storage_path);
    media.set(input.id,{path,metadata});
  }
  await renewMediaLease(job,'processing');
  if(spec.operation==='analyze')return {assetId:spec.assetId,metadata:media.get(spec.assetId)!.metadata};
  const start=performance.now();
  if(spec.operation==='scenes'){
    const source=media.get(spec.assetId)!;
    const files=await extractSceneFiles(source,dir,signal);timings.processMs=performance.now()-start;
    return {assetId:spec.assetId,files,metadata:source.metadata};
  }
  if(spec.operation==='frame'){
    const source=media.get(spec.assetId)!;if(spec.time>=source.metadata.duration)throw new MediaError('RANGE_OUTSIDE_SOURCE');
    const file=join(dir,'frame.png');
    await mediaProcess('ffmpeg',['-i',source.path,'-ss',String(spec.time),'-frames:v','1',...(spec.maxWidth?['-vf',`scale=${spec.maxWidth}:-2:force_original_aspect_ratio=decrease`]:[]),file],signal);
    timings.processMs=performance.now()-start;return {file,mime:'image/png',metadata:{sourceAssetId:spec.assetId,time:spec.time}};
  }
  if(spec.operation==='preview'){
    const source=media.get(spec.assetId)!;
    if(source.metadata.directPlayback)return {assetId:spec.assetId,metadata:source.metadata};
    if(['smpte2084','arib-std-b67'].includes(source.metadata.video?.color_transfer||''))throw new MediaError('HDR_PREVIEW_UNSUPPORTED');
    const file=join(dir,'preview.mp4');
    const compatibleVideo=source.metadata.video?.codec_name==='h264' && source.metadata.video?.pix_fmt==='yuv420p';
    await mediaProcess('ffmpeg',['-i',source.path,'-map','0:v:0','-map','0:a?','-c:v',compatibleVideo?'copy':'libx264',
      ...(compatibleVideo?[]:['-threads',String(config.threads),'-pix_fmt','yuv420p','-preset','veryfast','-crf','20']),
      '-c:a','aac','-profile:a','aac_low','-ar','48000','-ac','2','-movflags','+faststart',file],signal);
    const output=await probeFile(file,signal);
    if(!output.directPlayback || Math.abs(output.duration-source.metadata.duration)>1/source.metadata.fps+.002)throw new MediaError('INVALID_PREVIEW_OUTPUT');
    timings.processMs=performance.now()-start;return {file,mime:'video/mp4',metadata:output};
  }
  const requested:Array<{id:string;start:number;end:number;outputDuration?:number;audio?:{id:string;start:number;end:number}}>=spec.operation==='export'?spec.assets:spec.operation==='segment'?[spec.range]:
    [{id:spec.assetId,start:0,end:media.get(spec.assetId)!.metadata.duration,audio:spec.audio}];
  const clips:PlannedClip[]=[];
  for(const request of requested){
    const source=media.get(request.id)!;let {start,end}=request;
    if(end>source.metadata.duration+1e-6)throw new MediaError('RANGE_OUTSIDE_SOURCE');
    if(start>0 || Math.abs(end-source.metadata.duration)>1e-6){
      ({start,end}=quantizeRange(start,end,await frameBoundaries(source.path,source.metadata,signal)));
    }
    clips.push({id:request.id,start,end,metadata:source.metadata,audio:request.audio,outputDuration:request.outputDuration});
  }
  const audio=spec.operation==='export'?spec.audioMode:spec.operation==='audio'?(spec.audio?'original':'none'):'selected';
  const modelId=spec.operation==='segment'?spec.modelId:undefined;
  const geometry=Boolean(modelId==='seedance-2-5' && clips[0].metadata.video!.width!*clips[0].metadata.video!.height!>921600);
  const plan=planProcessing(clips,audio,geometry);
  if(plan.video==='reuse')return {assetId:clips[0].id,plan,metadata:clips[0].metadata};
  let file=await renderPlan(plan,media,dir,signal,modelId);
  const mov=spec.operation==='audio' && spec.outputFormat==='mov';
  if(mov){const target=join(dir,'output.mov');await mediaProcess('ffmpeg',['-i',file,'-map','0','-c','copy','-movflags','+faststart',target],signal);file=target;}
  const output=await probeFile(file,signal);
  if(Math.abs(output.duration-plan.duration)>1/plan.fps+.002)throw new MediaError('OUTPUT_DURATION_MISMATCH');
  timings.processMs=performance.now()-start;
  return {file,mime:mov?'video/quicktime':'video/mp4',metadata:output,plan};
}

async function publish(job:MediaJob,outcome:Outcome,uploads:Array<{file:MediaFileOutcome;stored:StoredObject}>,timings:Record<string,number>) {
  return db.transaction(async()=>{
    const owned=await db.prepare(`SELECT id FROM media_jobs WHERE id=? AND worker_id=? AND fence=? AND status='running' AND lease_until>now() FOR UPDATE`).get(job.id,job.worker_id,job.fence);
    if(!owned)throw new MediaError('LEASE_LOST',409);
    await assertJobAccess(job);
    await retainMediaStaging(job.id,job.fence,uploads.length);
    await db.prepare('DELETE FROM media_storage_reservations WHERE job_id=? AND fence=?').run(job.id,job.fence);
    await assertWorkspaceStorageCapacity(job.workspace_id,uploads.reduce((total,item)=>total+item.stored.size,0));
    const assets:Array<{id:string;url:string;downloadUrl:string;metadata:unknown;kind:string;role:string;filename:string}>=[];
    for(const {file,stored} of uploads){
      const id=crypto.randomUUID(),ext=fileExtension(file.mime);
      const role=file.role || (job.operation==='export'?'generated':job.operation==='segment'?'reference_video':'internal');
      const kind=file.kind||(['export','audio'].includes(job.operation)?'generated_video':job.operation==='segment'?'video_segment':job.operation==='frame'?'video_frame':`media_${job.operation}`),filename=file.filename||`${job.id}.${ext}`;
      const spec=JSON.parse(job.spec_json) as MediaSpec;
      const ancestry=spec.operation==='segment'?{sourceAssetId:spec.range.id,start:spec.range.start,end:spec.range.end,modelId:spec.modelId}:spec.operation==='frame'?{sourceAssetId:spec.assetId,time:spec.time}:spec.operation==='preview'?{sourceAssetId:spec.assetId}:{};
      const metadata={...ancestry,mediaJobId:job.id,mediaVersion:1,mediaType:file.mime.startsWith('image/')?'image':'video',
        duration:(file.metadata as MediaMetadata|undefined)?.duration,durationSeconds:(file.metadata as MediaMetadata|undefined)?.duration,...((file.metadata as MediaMetadata|undefined)?.video?displayGeometry(file.metadata as MediaMetadata):{}),...(['scene','slide'].includes(file.kind||'')?file.metadata as object:{}),analysis:file.metadata,plan:outcome.plan};
      await db.prepare(`INSERT INTO assets(id,workspace_id,project_id,kind,role,filename,storage_path,storage_provider,storage_bucket,object_key,size_bytes,content_hash,mime_type,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,job.workspace_id,job.project_id,kind,role,filename,stored.reference,stored.provider,stored.bucket,stored.key,stored.size,stored.contentHash,file.mime,JSON.stringify(metadata),new Date().toISOString());
      const analysis=file.metadata as MediaMetadata|undefined;
      if(analysis?.version===1){
        const {fingerprint}=await import('./contracts');
        await db.prepare('INSERT INTO media_asset_analysis(asset_id,content_identity,analyzer_version,metadata_json) VALUES(?,?,1,?)').run(id,fingerprint([id,stored.contentHash,stored.reference,stored.size]),JSON.stringify(analysis));
      }
      assets.push({id,url:`/api/assets/${id}`,downloadUrl:`/api/assets/${id}?download=1`,metadata,kind,role,filename});
    }
    const assetId=outcome.assetId||assets[0]?.id;
    const result={asset:assetId?{id:assetId,url:`/api/assets/${assetId}`,downloadUrl:`/api/assets/${assetId}?download=1`}:null,
      ...(outcome.files?{assets}:{}),metadata:outcome.metadata,plan:outcome.plan};
    await db.prepare(`UPDATE media_jobs SET status='completed',stage='completed',result_asset_id=?,result_json=?,metrics_json=?,lease_until=NULL,worker_id=NULL,updated_at=now(),completed_at=now()
      WHERE id=? AND fence=?`).run(assetId??null,JSON.stringify(result),JSON.stringify(timings),job.id,job.fence);
  })();
}
export async function executeMediaJob(job:MediaJob,shutdownSignal?:AbortSignal) {
  const controller=new AbortController(),signal=controller.signal,config=mediaConfig();
  const onShutdown=()=>controller.abort();shutdownSignal?.addEventListener('abort',onShutdown,{once:true});
  let dir:string|undefined;
  let heartbeatBusy=false;
  const heartbeat=setInterval(()=>{
    if(heartbeatBusy)return;heartbeatBusy=true;
    renewMediaLease(job).catch(()=>controller.abort()).finally(()=>{heartbeatBusy=false;});
  },config.heartbeatMs);
  const executionStart=performance.now();
  const timings:Record<string,number>={queueMs:Math.max(0,Date.now()-Date.parse(job.created_at))};
  try {
    if(shutdownSignal?.aborted)controller.abort();signal.throwIfAborted();
    await renewMediaLease(job,'preparing');
    await assertJobAccess(job);
    await mkdir(config.tempRoot,{recursive:true});dir=await mkdtemp(join(config.tempRoot,`${job.id}-${job.fence}-`));
    const outcome=await processJob(job,dir,signal,timings);
    const uploads:Array<{file:MediaFileOutcome;stored:StoredObject}>=[];
    const files=outcome.files || (outcome.file?[{file:outcome.file,mime:outcome.mime!,metadata:outcome.metadata}]:[]);
    const totalOutputBytes=(await Promise.all(files.map(async file=>(await stat(file.file)).size))).reduce((a,b)=>a+b,0);
    if(totalOutputBytes>config.maxTempBytes)throw new MediaError('MEDIA_FILE_LIMIT');
    if(totalOutputBytes)await db.transaction(async()=>{
      await renewMediaLease(job,'uploading');
      await assertWorkspaceStorageCapacity(job.workspace_id,totalOutputBytes);
      await db.prepare('INSERT INTO media_storage_reservations(job_id,workspace_id,fence,bytes) VALUES(?,?,?,?)').run(job.id,job.workspace_id,job.fence,totalOutputBytes);
    })();
    let outputBytes=0;
    for(const [ordinal,file] of files.entries()){
      const bytes=(await stat(file.file)).size;outputBytes+=bytes;
      if(bytes>config.maxFileBytes || outputBytes>config.maxTempBytes)throw new MediaError('MEDIA_FILE_LIMIT');
      await renewMediaLease(job,'uploading');
      const key=`workspaces/${job.workspace_id}/media-jobs/${job.id}/${job.fence}-${ordinal}.${fileExtension(file.mime)}`;
      const destination=storageFileDestination(key);
      await db.prepare('INSERT INTO media_job_objects(job_id,fence,ordinal,storage_reference) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(job.id,job.fence,ordinal,destination.reference);
      const started=performance.now();
      const stored=await mediaTransfer(signal,config.transferTimeoutMs,transferSignal=>putStorageFile(file.file,key,{contentType:file.mime},transferSignal));
      timings.uploadMs=(timings.uploadMs||0)+performance.now()-started;uploads.push({file,stored});
    }
    timings.executionMs=performance.now()-executionStart;
    signal.throwIfAborted();await publish(job,outcome,uploads,timings);
  }catch(error){
    const cause=error instanceof Error?error.cause:undefined;
    const code=error instanceof Error && 'code' in error?String(error.code):cause && typeof cause==='object' && 'code' in cause?String(cause.code):'';
    const temporary=(error instanceof Error && error.name==='TimeoutError') || ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','ENETUNREACH'].includes(code) ||
      Boolean(error && typeof error==='object' && '$metadata' in error && Number((error.$metadata as {httpStatusCode?:number}).httpStatusCode)>=500);
    await failMediaJob(job,shutdownSignal?.aborted?new MediaError('WORKER_STOPPED',503,true):error instanceof MediaError?error:new MediaError(code==='ENOSPC'?'MEDIA_DISK_FULL':code==='SOURCE_CONTENT_CHANGED'?code:'MEDIA_EXECUTION_FAILED',500,temporary));
  }finally{
    clearInterval(heartbeat);shutdownSignal?.removeEventListener('abort',onShutdown);
    if(dir)await rm(dir,{recursive:true,force:true});
  }
}
export async function cleanupMediaObjects() {
  const rows=await claimMediaCleanup();
  const signal=AbortSignal.timeout(mediaConfig().cleanupTimeoutMs);
  for(const row of rows){
    if(signal.aborted)break;
    try {
      await deleteStorageObject(row.storage_reference,signal);
      if(!/^[a-z0-9]+:\/\//i.test(row.storage_reference))await rm(`${row.storage_reference}.partial`,{force:true});
      await db.prepare('DELETE FROM media_job_objects WHERE job_id=? AND fence=? AND ordinal=? AND NOT retained AND cleanup_claimed_at IS NOT NULL').run(row.job_id,row.fence,row.ordinal);
    }catch{console.error('Media staging cleanup deferred',{jobId:row.job_id,fence:row.fence});}
  }
}

export async function mediaTempUsage() {
  async function size(path:string):Promise<number>{
    const item=await lstat(path);if(item.isSymbolicLink())return 0;
    if(!item.isDirectory())return item.size;
    return (await Promise.all((await readdir(path)).map(name=>size(join(path,name)).catch(()=>0)))).reduce((a,b)=>a+b,0);
  }
  return size(mediaConfig().tempRoot).catch(()=>0);
}
export async function cleanupMediaTemp() {
  const root=mediaConfig().tempRoot;
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){
    const match=entry.name.match(/^([0-9a-f-]{36})-(\d+)-/);if(!entry.isDirectory() || !match)continue;
    const path=join(root,entry.name),info=await stat(path);
    if(Date.now()-info.mtimeMs<600_000)continue;
    const active=await db.prepare("SELECT id FROM media_jobs WHERE id=? AND fence=? AND status='running' AND lease_until>now()").get(match[1],Number(match[2]));
    if(!active)await rm(path,{recursive:true,force:true});
  }
}
