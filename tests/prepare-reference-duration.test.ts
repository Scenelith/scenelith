import assert from "node:assert/strict";
import {after,test} from "node:test";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {db,resetTestDatabase,closeRelationalPool} from "./postgres-test-db";
import {saveBytes,readStorageObject} from "../src/lib/storage";
import {prepareReferenceDuration} from "../src/lib/prepare-reference-duration";
import {probeVideoMetadata} from "../src/lib/media-probe";
import {executeGenerationRequest} from "../src/lib/generation-http";
after(closeRelationalPool);

test("Wan prepares and quotes the first 15s through the cached media pipeline without editing the original",async()=>{
  await resetTestDatabase();const now=new Date().toISOString(),assetId=crypto.randomUUID();
  await db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES('duration-user','duration@example.test','Duration',?,?)").run(now,now);
  await db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('duration-space','Duration',?,?)").run(now,now);
  await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('duration-space','duration-user','owner',?)").run(now);
  await db.prepare("INSERT INTO projects(id,workspace_id,name,graph_json,created_at,updated_at) VALUES('duration-canvas','duration-space','Duration','{\"nodes\":[],\"edges\":[]}',?,?)").run(now,now);
  const dir=await mkdtemp(join(tmpdir(),"wan-reference-"));
  try{
    const file=join(dir,"source.mp4");
    execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=blue:s=240x320:r=25:d=17","-c:v","libx264","-pix_fmt","yuv420p",file]);
    const stored=await saveBytes(await readFile(file),"duration-test","source.mp4","video/mp4");
    await db.prepare("INSERT INTO assets(id,workspace_id,project_id,kind,filename,storage_path,mime_type,size_bytes,metadata_json,created_at) VALUES(?,'duration-space','duration-canvas','upload','source.mp4',?,'video/mp4',?,'{\"durationSeconds\":17}',?)").run(assetId,stored.reference,stored.size,now);
    const request={userId:"duration-user",projectId:"duration-canvas",modelId:"wan-3",duration:"5",durationMode:"reference" as const,references:[{path:stored.reference,mimeType:"video/mp4",label:"@Source",role:"reference-video",durationSeconds:17}]};
    const prepared=await prepareReferenceDuration(request);
    assert.equal(prepared.duration,"15");assert.notEqual(prepared.references[0].path,stored.reference);
    const measured=await probeVideoMetadata(await readStorageObject(prepared.references[0].path),".mp4");
    assert.ok(Math.abs(Number(measured.durationSeconds)-15)<.05);
    assert.equal((await prepareReferenceDuration(request)).references[0].path,prepared.references[0].path,"retries reuse the same derivative");
    const quote=await executeGenerationRequest("duration-user",{projectId:"duration-canvas",nodeId:"generator",modelId:"wan-3",prompt:"Follow the source motion",referenceAssetIds:[assetId],referenceRoles:["reference-video"],aspectRatio:"9:16",resolution:"480P",duration:"5",durationMode:"reference",generateAudio:false},true);
    assert.equal(quote.status,200);const body=await quote.json();assert.equal(body.inputVideoDurationSeconds,15);assert.equal(body.creditCost,240,"quote includes 15 input + 15 output seconds");
    const source=await db.prepare("SELECT metadata_json FROM assets WHERE id=?").get(assetId) as {metadata_json:string};
    assert.equal(JSON.parse(source.metadata_json).durationSeconds,17);
    assert.equal((await prepareReferenceDuration({...request,durationMode:"fixed"})).references[0].path,stored.reference);
  }finally{await rm(dir,{recursive:true,force:true});}
});
