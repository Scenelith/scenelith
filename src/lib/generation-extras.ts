import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { db } from './postgres-db';
import { readStorageObject, putStorageObject, deleteStorageObject } from './storage';
import { assertWorkspaceStorageCapacity } from './storage-lifecycle';

export function soundtrackArguments(video: string, soundtrack: string, output: string) {
  return ['-hide_banner','-loglevel','error','-i',video,'-i',soundtrack,'-map','0:v:0','-map','1:a:0?','-c:v','copy','-c:a','aac','-af','apad','-shortest','-movflags','+faststart',output];
}
async function ffmpeg(args:string[]) {
  await new Promise<void>((resolve,reject)=>{
    const child=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']}); let error='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    child.stderr.on('data',chunk=>{error=(error+String(chunk)).slice(-2000);});
    child.once('error',reject); child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(error||'Could not attach soundtrack'));});
  });
}
export async function processGenerationExtras(id:string) {
  const written:string[]=[];
  await db.transaction(async()=>{
    const locked=await db.prepare('SELECT pg_try_advisory_xact_lock(hashtextextended(?,0)) AS locked').get(`generation-extras:${id}`) as {locked:boolean};
    if(!locked.locked)return;
    const row=await db.prepare(`SELECT e.*,g.project_id,g.output_asset_id,p.workspace_id FROM generation_output_extras e JOIN generations g ON g.id=e.generation_id JOIN projects p ON p.id=g.project_id WHERE e.generation_id=?`).get(id) as {last_frame_url:string|null;last_frame_asset_id:string|null;soundtrack_asset_id:string|null;processed_asset_id:string|null;output_asset_id:string|null;project_id:string;workspace_id:string}|undefined;
    if(!row?.output_asset_id)return;
    const save=async(bytes:Buffer,mime:string,role:string)=>{
      const assetId=crypto.randomUUID(), filename=`${id}-${role}.${mime.startsWith('image/')?'jpg':mime==='video/quicktime'?'mov':'mp4'}`;
      await assertWorkspaceStorageCapacity(row.workspace_id,bytes.length);
      const stored=await putStorageObject(bytes,`workspaces/${row.workspace_id}/projects/${row.project_id}/generations/${filename}`,{contentType:mime});
      written.push(stored.reference);
      await db.prepare(`INSERT INTO assets(id,workspace_id,project_id,kind,role,filename,storage_path,storage_provider,storage_bucket,object_key,size_bytes,content_hash,mime_type,metadata_json,created_at) VALUES(?,?,?,?,'generated',?,?,?,?,?,?,?,?,?,?)`).run(assetId,row.workspace_id,row.project_id,mime.startsWith('image/')?'generated_image':'generated_video',filename,stored.reference,stored.provider,stored.bucket,stored.key,stored.size,stored.contentHash,mime,JSON.stringify({generationId:id,outputRole:role}),new Date().toISOString());
      return assetId;
    };
    if(row.last_frame_url&&!row.last_frame_asset_id){
      const response=await fetch(row.last_frame_url,{signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error('Could not save the last frame');
      const bytes=await sharp(Buffer.from(await response.arrayBuffer())).jpeg().toBuffer();
      const asset=await save(bytes,'image/jpeg','last-frame');
      await db.prepare('UPDATE generation_output_extras SET last_frame_asset_id=? WHERE generation_id=?').run(asset,id);
    }
    if(row.soundtrack_asset_id&&!row.processed_asset_id){
      const media=await db.prepare('SELECT id,storage_path FROM assets WHERE id IN (?,?) AND workspace_id=?').all(row.output_asset_id,row.soundtrack_asset_id,row.workspace_id) as {id:string;storage_path:string}[];
      const video=media.find(a=>a.id===row.output_asset_id),source=media.find(a=>a.id===row.soundtrack_asset_id);
      if(!video||!source)throw new Error('The original soundtrack is no longer available');
      const dir=await mkdtemp(join(tmpdir(),'scenelith-soundtrack-'));
      try{
        const job=await db.prepare('SELECT payload_json FROM generation_dispatch_jobs WHERE generation_id=?').get(id) as {payload_json:string}|undefined;
        const mov=JSON.parse(job?.payload_json||'{}').outputFormat==='mov';
        const videoPath=join(dir,'video.mp4'),sourcePath=join(dir,'source.mp4'),out=join(dir,mov?'output.mov':'output.mp4');
        await writeFile(videoPath,await readStorageObject(video.storage_path));await writeFile(sourcePath,await readStorageObject(source.storage_path));
        await ffmpeg(soundtrackArguments(videoPath,sourcePath,out));
        const asset=await save(await readFile(out),mov?'video/quicktime':'video/mp4','original-soundtrack');
        await db.prepare('UPDATE generation_output_extras SET processed_asset_id=? WHERE generation_id=?').run(asset,id);
      }finally{await rm(dir,{recursive:true,force:true});}
    }
    await db.prepare('UPDATE generation_output_extras SET processing_error=NULL WHERE generation_id=?').run(id);
  })().catch(async()=>{await Promise.allSettled(written.map(deleteStorageObject));await db.prepare("UPDATE generation_output_extras SET processing_error='Video is saved. Soundtrack or last-frame processing needs a retry.' WHERE generation_id=?").run(id);});
}
