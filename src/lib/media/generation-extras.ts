import sharp from 'sharp';
import { Readable } from 'node:stream';
import { db } from '../postgres-db';
import { putStorageObject,deleteStorageObject } from '../storage';
import { assertWorkspaceStorageCapacity } from '../storage-lifecycle';
import { createMediaJob,getMediaJob } from './repository';
import { MediaError } from './contracts';

type Extras={generation_id:string;project_id:string;workspace_id:string;requested_by_user_id:string;
  output_asset_id:string|null;soundtrack_asset_id:string|null;processed_asset_id:string|null;
  last_frame_url:string|null;last_frame_asset_id:string|null;media_job_id:string|null};

/** Reconciliation only. Waiting for analysis/audio never occupies a DB transaction or an AI slot. */
export async function reconcileMediaExtras(id:string) {
  const row=await db.prepare(`SELECT e.*,g.project_id,g.output_asset_id,g.requested_by_user_id,p.workspace_id
    FROM generation_output_extras e JOIN generations g ON g.id=e.generation_id
    JOIN projects p ON p.id=g.project_id WHERE e.generation_id=?`).get(id) as Extras|undefined;
  if(!row?.output_asset_id)return;
  try {
    if(row.last_frame_url && !row.last_frame_asset_id)await saveLastFrame(row);
    if(!row.soundtrack_asset_id || row.processed_asset_id)return;
    let job=row.media_job_id?await getMediaJob(row.requested_by_user_id,row.media_job_id):null;
    if(!job){
      const analyses=await Promise.all([row.output_asset_id,row.soundtrack_asset_id].map(assetId=>createMediaJob(row.requested_by_user_id,{
        projectId:row.project_id,requestKey:`analyze:${assetId}`,spec:{operation:'analyze',assetId},
      })));
      if(analyses.some(j=>j.status==='failed' || j.status==='cancelled'))throw new MediaError('SOUNDTRACK_SOURCE_UNAVAILABLE');
      if(analyses.some(j=>j.status!=='completed'))return;
      const duration=Number(JSON.parse(analyses[1].result_json!).metadata.duration);
      const dispatch=await db.prepare('SELECT payload_json FROM generation_dispatch_jobs WHERE generation_id=?').get(id) as {payload_json:string}|undefined;
      job=await createMediaJob(row.requested_by_user_id,{projectId:row.project_id,requestKey:`generation-soundtrack:${id}`,
        spec:{operation:'audio',assetId:row.output_asset_id,audio:{id:row.soundtrack_asset_id,start:0,end:duration},
          outputFormat:JSON.parse(dispatch?.payload_json||'{}').outputFormat==='mov'?'mov':'mp4'},
        dependencies:analyses.map(j=>j.id)});
      await db.prepare('UPDATE generation_output_extras SET media_job_id=COALESCE(media_job_id,?) WHERE generation_id=?').run(job.id,id);
    }
    if(job.status==='failed' || job.status==='cancelled')throw new MediaError(job.error_code||'SOUNDTRACK_PROCESSING_FAILED');
    if(job.status!=='completed')return;
    await db.transaction(async()=>{
      await db.prepare('UPDATE generation_output_extras SET processed_asset_id=?,processing_error=NULL WHERE generation_id=? AND processed_asset_id IS NULL').run(job.result_asset_id,id);
      await db.prepare("UPDATE assets SET role=(SELECT role FROM assets WHERE id=?),metadata_json=(metadata_json::jsonb || ?::jsonb) WHERE id=?").run(row.output_asset_id,JSON.stringify({generationId:id,outputRole:'original-soundtrack'}),job.result_asset_id);
    })();
  }catch(error){
    // Failed assembly does not change the successful generation or release/start any AI request.
    await db.prepare('UPDATE generation_output_extras SET processing_error=? WHERE generation_id=?').run(
      error instanceof MediaError?`Video is saved. Audio preparation failed (${error.code}).`:'Video is saved. Additional media is temporarily unavailable.',id);
  }
}

async function saveLastFrame(row:Extras) {
  const response=await fetch(row.last_frame_url!,{signal:AbortSignal.timeout(60_000)});
  if(!response.ok || !response.body)throw new MediaError('LAST_FRAME_UNAVAILABLE');
  const chunks:Uint8Array[]=[];let size=0;
  for await(const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)){size+=chunk.length;if(size>25*1024*1024){throw new MediaError('LAST_FRAME_TOO_LARGE');}chunks.push(chunk);}
  const bytes=await sharp(Buffer.concat(chunks)).jpeg().toBuffer();
  const measured=await sharp(bytes).metadata(),assetId=crypto.randomUUID();
  const stored=await putStorageObject(bytes,`workspaces/${row.workspace_id}/projects/${row.project_id}/generations/${row.generation_id}-last-frame-${assetId}.jpg`,{contentType:'image/jpeg'});
  let retained=false;
  try {
    retained=await db.transaction(async()=>{
      const current=await db.prepare('SELECT last_frame_asset_id FROM generation_output_extras WHERE generation_id=? FOR UPDATE').get(row.generation_id) as {last_frame_asset_id:string|null};
      if(current.last_frame_asset_id)return false;
      await assertWorkspaceStorageCapacity(row.workspace_id,stored.size);
      await db.prepare(`INSERT INTO assets(id,workspace_id,project_id,kind,role,filename,storage_path,storage_provider,storage_bucket,object_key,size_bytes,content_hash,mime_type,metadata_json,created_at)
        VALUES(?,?,?,'generated_image','generated',?,?,?,?,?,?,?,'image/jpeg',?,now())`).run(assetId,row.workspace_id,row.project_id,`${row.generation_id}-last-frame.jpg`,stored.reference,stored.provider,stored.bucket,stored.key,stored.size,stored.contentHash,JSON.stringify({generationId:row.generation_id,outputRole:'last-frame',width:measured.width,height:measured.height}));
      await db.prepare('UPDATE generation_output_extras SET last_frame_asset_id=? WHERE generation_id=?').run(assetId,row.generation_id);return true;
    })();
  }finally{if(!retained)await deleteStorageObject(stored.reference);}
}
