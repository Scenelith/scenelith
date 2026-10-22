import assert from "node:assert/strict";
import {after,test} from "node:test";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import sharp from "sharp";
import {db,resetTestDatabase,closeRelationalPool} from "./postgres-test-db";
import {saveBytes} from "../src/lib/storage";
import {executeGenerationRequest} from "../src/lib/generation-http";
after(closeRelationalPool);

test("Kling HTTP quotes sum measured videos and accept last-frame-only requests without dispatch or reservations",async()=>{
  await resetTestDatabase();const now=new Date().toISOString();
  await db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES('kling-user','kling@example.test','Kling',?,?)").run(now,now);
  await db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('kling-space','Kling',?,?)").run(now,now);
  await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('kling-space','kling-user','owner',?)").run(now);
  await db.prepare("INSERT INTO projects(id,workspace_id,name,graph_json,created_at,updated_at) VALUES('kling-canvas','kling-space','Kling','{\"nodes\":[],\"edges\":[]}',?,?)").run(now,now);
  const dir=await mkdtemp(join(tmpdir(),"kling-http-"));
  try{
    const file=join(dir,"clip.mp4");
    execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=blue:s=320x480:r=25:d=7","-c:v","libx264","-pix_fmt","yuv420p",file]);
    const video=await saveBytes(await readFile(file),"kling-test","clip.mp4","video/mp4");
    const image=await saveBytes(await sharp({create:{width:320,height:480,channels:3,background:"red"}}).png().toBuffer(),"kling-test","frame.png","image/png");
    const videoIds=[crypto.randomUUID(),crypto.randomUUID()],imageId=crypto.randomUUID();
    for(const id of videoIds)await db.prepare("INSERT INTO assets(id,workspace_id,project_id,kind,filename,storage_path,mime_type,size_bytes,metadata_json,created_at) VALUES(?,'kling-space','kling-canvas','upload','clip.mp4',?,'video/mp4',?,'{\"durationSeconds\":1}',?)").run(id,video.reference,video.size,now);
    await db.prepare("INSERT INTO assets(id,workspace_id,project_id,kind,filename,storage_path,mime_type,size_bytes,metadata_json,created_at) VALUES(?,'kling-space','kling-canvas','upload','frame.png',?,'image/png',?,'{}',?)").run(imageId,image.reference,image.size,now);
    const request={projectId:"kling-canvas",nodeId:"generator",modelId:"kling-4-reference",prompt:"Follow @ClipA and @ClipB",referenceAssetIds:videoIds,referenceLabels:["@ClipA","@ClipB"],referenceRoles:["reference-video","reference-video"],aspectRatio:"9:16",resolution:"720P",duration:"10"};
    const quote=await executeGenerationRequest("kling-user",request,true);
    assert.equal(quote.status,200);const body=await quote.json();
    assert.equal(body.inputVideoDurationSeconds,14,"each stored clip is measured despite stale duration metadata");
    assert.equal(body.creditCost,408,"(14s input + 10s output) * 17, above the 20s minimum");
    const minimum=await executeGenerationRequest("kling-user",{...request,prompt:"Follow @ClipA",referenceAssetIds:[videoIds[0]],referenceLabels:["@ClipA"],referenceRoles:["reference-video"]},true);
    assert.equal((await minimum.json()).creditCost,340);
    const lastFrame=await executeGenerationRequest("kling-user",{...request,modelId:"kling-4-keyframe",prompt:"Arrive at @Finish",referenceAssetIds:[imageId],referenceLabels:["@Finish"],referenceRoles:["end-frame"]},true);
    assert.equal(lastFrame.status,200);assert.equal((await lastFrame.json()).creditCost,285);
    const invalid=await executeGenerationRequest("kling-user",{...request,prompt:"Follow @Missing"},true);
    assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/does not match/);
    const tasks=await db.prepare("SELECT count(*) AS count FROM generations WHERE project_id='kling-canvas'").get() as {count:string};
    assert.equal(Number(tasks.count),0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
