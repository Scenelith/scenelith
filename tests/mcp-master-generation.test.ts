import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, resetTestDatabase, closeRelationalPool } from "./postgres-test-db";
import { saveBytes, readStorageObject } from "../src/lib/storage";
import { getMcpCanvas, patchMcpCanvas, runMcpCanvasGeneration } from "../src/lib/mcp/service";
import { videoMasterSceneRevision } from "../src/lib/mcp/video-master-scenes";
import { videoMasterClipPlaybackMedia } from "../src/lib/video-master";
import { usageAuthority } from "../src/modules/usage";
import type { McpPrincipal } from "../src/lib/mcp/oauth";
import type { ProjectGraph } from "../src/lib/types";

const principal: McpPrincipal = { connectionId: "scene-test", clientId: "scene-test", userId: "scene-user", workspaceId: "scene-space", projectIds: ["scene-canvas"], libraryAccess: true,
  scopes: ["mcp:read", "canvas:write", "generation:run"], resource: "https://scenelith.example/api/mcp", expiresAt: new Date(Date.now() + 3600000).toISOString() };
let graph: ProjectGraph;
let reserve: ReturnType<typeof mock.fn>;
let directory: string;

beforeEach(async () => {
  await resetTestDatabase();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES ('scene-user','scene@example.test','Scene',?,?)").run(now,now);
  await db.prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('scene-space','Scenes',?,?)").run(now,now);
  await db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES ('scene-space','scene-user','owner',?)").run(now);
  await db.prepare("INSERT INTO projects (id,workspace_id,name,graph_json,created_at,updated_at) VALUES ('scene-canvas','scene-space','Scenes','{}',?,?)").run(now,now);
  directory = await mkdtemp(join(tmpdir(), "master-generation-test-"));
  const filename = join(directory, "source.mp4");
  execFileSync("ffmpeg", ["-hide_banner","-loglevel","error","-f","lavfi","-i","color=red:s=64x64:r=10:d=5.3","-f","lavfi","-i","color=blue:s=64x64:r=10:d=4.7","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-c:v","libx264","-pix_fmt","yuv420p",filename]);
  const assetId = crypto.randomUUID();
  const stored = await saveBytes(await readFile(filename), "scene-test", "source.mp4", "video/mp4");
  await db.prepare("INSERT INTO assets (id,workspace_id,project_id,kind,role,filename,storage_path,mime_type,metadata_json,created_at) VALUES (?,'scene-space','scene-canvas','library_video','library','source.mp4',?,'video/mp4','{}',?)").run(assetId,stored.reference,now);
  graph = { nodes: [
    { id: "source", type: "frameNode", position: {x:0,y:0}, data: {kind:"source",title:"Source",mediaType:"video",assetId,outputUrl:`/api/assets/${assetId}`,videoSegments:[
      {id:"segment-a",index:0,label:"Scene 01",role:"scene",start:0,end:5.3,confidence:1},
      {id:"segment-b",index:1,label:"Scene 02",role:"scene",start:5.3,end:10,confidence:1},
    ]} },
    {id:"master",type:"frameNode",position:{x:400,y:0},data:{kind:"videoMaster",title:"Video Master",mediaType:"video",videoMasterSelectedClipId:"clip-b",videoMasterClips:[
      {id:"clip-a",title:"First scene",role:"scene",origin:"source",duration:5.3,prompt:"Gentle turn",modelId:"seedance-2-5",resolution:"720P",aspectRatio:"9:16",generationDuration:6,sourceNodeId:"source",sourceSegmentId:"segment-a",sourceAssetId:assetId,sourceUrl:`/api/assets/${assetId}`,sourceStart:0,sourceEnd:5.3},
      {id:"clip-b",title:"Second scene",role:"scene",origin:"source",duration:4.7,prompt:"Leave unchanged",modelId:"seedance-2-5",sourceNodeId:"source",sourceSegmentId:"segment-b",sourceAssetId:assetId,sourceUrl:`/api/assets/${assetId}`,sourceStart:5.3,sourceEnd:10},
    ]}},
    {id:"unrelated",type:"frameNode",position:{x:0,y:500},data:{kind:"note",title:"Note",noteText:"Original"}},
  ],edges:[{id:"scene-reference",source:"source",target:"master",targetHandle:"master:clip-a:reference-video-input",data:{portType:"video",inputRole:"reference-video",masterClipId:"clip-a",sourceSegmentId:"segment-a"}}] };
  await db.prepare("UPDATE projects SET graph_json=? WHERE id='scene-canvas'").run(JSON.stringify(graph));
  const usage = await usageAuthority();
  mock.method(usage,"summary",async()=>({usageMode:"unmetered",profileId:"test",profileName:"Test",used:0,limit:0,remaining:0,assistantEnabled:true,generationConcurrency:8,version:1,updatedAt:now}));
  reserve = mock.fn(async()=>true);
  mock.method(usage,"reserveGeneration",reserve);
});
afterEach(async()=>{mock.restoreAll();await rm(directory,{recursive:true,force:true});});
after(closeRelationalPool);

async function request() {
  const canvas = await getMcpCanvas(principal,"scene-canvas");
  return { projectId:canvas.id,expectedRevision:canvas.revision,nodeId:"master",clipId:"clip-a",expectedSceneRevision:canvas.videoMasterScenes.find(s=>s.clipId==="clip-a")!.generationRevision };
}
async function dispatch(generationId: string) {
  const row = await db.prepare("SELECT payload_json FROM generation_dispatch_jobs WHERE generation_id=?").get(generationId) as {payload_json:string};
  return JSON.parse(row.payload_json);
}

test("MCP generates one unprepared scene despite unrelated canvas revisions, preserving playback and other scenes",async()=>{
  const input = await request();
  await patchMcpCanvas(principal,{projectId:input.projectId,expectedRevision:input.expectedRevision,operations:[{type:"update_node",nodeId:"unrelated",data:{noteText:"Changed while agent was thinking"}}]});
  const result = await runMcpCanvasGeneration(principal,input);
  assert.ok("generationId" in result);
  const payload = await dispatch(result.generationId);
  assert.equal(payload.targetClipId,"clip-a");
  assert.equal(payload.duration,"6");
  assert.equal(payload.references.length,1);
  assert.equal(payload.references[0].durationSeconds,5.3);
  const asset = await db.prepare("SELECT metadata_json FROM assets WHERE id=?").get(payload.targetSourceAssetId) as {metadata_json:string};
  assert.deepEqual({start:JSON.parse(asset.metadata_json).start,end:JSON.parse(asset.metadata_json).end},{start:0,end:5.3});
  const bytes=await readStorageObject(payload.references[0].path);
  const derivative=join(directory,"derivative.mp4");await (await import("node:fs/promises")).writeFile(derivative,bytes);
  const duration=Number(execFileSync("ffprobe",["-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",derivative],{encoding:"utf8"}).trim());
  assert.ok(Math.abs(duration-5.3)<.11);
  const pixel=execFileSync("ffmpeg",["-v","error","-ss","5.2","-i",derivative,"-vf","scale=1:1","-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
  assert.ok(pixel[0]>200 && pixel[2]<50,"the end of Scene 01 is red, not Scene 02's blue");
  const current=await getMcpCanvas(principal,"scene-canvas");const master=current.graph.nodes.find(n=>n.id==="master")!;
  assert.deepEqual(master.data.videoMasterClips![1],graph.nodes[1].data.videoMasterClips![1]);
  assert.equal(master.data.videoMasterSelectedClipId,"clip-b");
  assert.equal(current.graph.nodes[0].data.videoSegments![1].clipAssetId,undefined);
  assert.equal(videoMasterClipPlaybackMedia(master.data.videoMasterClips![0],"original").url,graph.nodes[1].data.videoMasterClips![0].sourceUrl);
  assert.equal(videoMasterSceneRevision(current.graph,"master","clip-a"),input.expectedSceneRevision);
  assert.equal(reserve.mock.callCount(),1);
});

test("a shorter Master generation trims only its reference, and simultaneous retries enqueue once",async()=>{
  graph.nodes[1].data.videoMasterClips![0].generationDuration=4;
  await db.prepare("UPDATE projects SET graph_json=? WHERE id='scene-canvas'").run(JSON.stringify(graph));
  const input=await request();
  const results=await Promise.allSettled([runMcpCanvasGeneration(principal,input),runMcpCanvasGeneration(principal,input)]);
  const success=results.find(r=>r.status==="fulfilled");assert.ok(success?.status==="fulfilled" && "generationId" in success.value);
  const failure=results.find(r=>r.status==="rejected");assert.ok(failure?.status==="rejected");
  assert.equal(failure.reason.code,"GENERATION_ALREADY_RUNNING");assert.equal(failure.reason.generationId,success.value.generationId);
  const payload=await dispatch(success.value.generationId);
  assert.equal(payload.duration,"4");assert.equal(payload.references[0].durationSeconds,4);
  const canvas=await getMcpCanvas(principal,"scene-canvas");
  const segment=canvas.graph.nodes[0].data.videoSegments![0];
  assert.equal(segment.end,5.3);assert.notEqual(segment.clipAssetId,payload.targetSourceAssetId);
  assert.equal(reserve.mock.callCount(),1);
});

test("changed scene inputs reject old tokens and are rechecked before reserving generation",async()=>{
  const input=await request();
  const original=structuredClone(graph);
  for(const mutate of [
    (g:ProjectGraph)=>{g.nodes[1].data.videoMasterClips![0].prompt="Different instruction";},
    (g:ProjectGraph)=>{g.nodes[0].data.videoSegments![0].end=5;},
    (g:ProjectGraph)=>{g.nodes[0].data.assetId="different-source";},
    (g:ProjectGraph)=>{g.nodes[1].data.videoMasterClips![0].attachedReferences=[{assetId:"different-ref",url:"/api/assets/different-ref",title:"Ref",role:"reference-image"}];},
  ]){ const changed=structuredClone(original);mutate(changed);assert.notEqual(videoMasterSceneRevision(changed,"master","clip-a"),input.expectedSceneRevision); }
  const usage=await usageAuthority();
  const summary=await usage.summary("scene-space");
  mock.method(usage,"summary",async()=>{
    const current=await getMcpCanvas(principal,"scene-canvas");const master=current.graph.nodes.find(n=>n.id==="master")!;
    await patchMcpCanvas(principal,{projectId:current.id,expectedRevision:current.revision,operations:[{type:"update_node",nodeId:"master",data:{videoMasterClips:master.data.videoMasterClips!.map(c=>c.id==="clip-a"?{...c,prompt:"Changed during preparation"}:c)}}]});
    return summary;
  });
  await assert.rejects(runMcpCanvasGeneration(principal,input),(error:any)=>error.code==="SCENE_REVISION_CONFLICT");
  assert.equal(reserve.mock.callCount(),0);
  assert.equal((await db.prepare("SELECT count(*) AS count FROM generations").get() as {count:number}).count,0);
});

for (const changeTarget of [false,true]) test(`live collaboration retries metadata conflicts ${changeTarget ? "but rejects edits to the selected scene" : "without losing other scene edits"}`,async()=>{
  const {createServer}=await import("node:http");
  const initial=await getMcpCanvas(principal,"scene-canvas");
  let live={graph:initial.graph,revision:initial.revision,stateVector:"start",updatedAt:new Date().toISOString()};
  let firstWrite=true;
  const server=createServer(async(req,res)=>{
    if(req.method==="PUT"){
      let body="";for await(const chunk of req)body+=chunk;
      const input=JSON.parse(body);
      if(firstWrite){
        firstWrite=false;
        live.graph=structuredClone(live.graph);
        live.graph.nodes.find(n=>n.id==="master")!.data.videoMasterClips![changeTarget?0:1].prompt="Concurrent scene edit";
        live={...live,revision:live.revision+1,stateVector:"concurrent"};res.statusCode=409;
      }else if(input.expectedRevision!==live.revision){res.statusCode=409;}
      else live={...live,graph:input.graph,revision:live.revision+1,stateVector:`v${live.revision+1}`};
    }
    res.setHeader("content-type","application/json");res.end(JSON.stringify(live));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const oldUrl=process.env.COLLABORATION_INTERNAL_URL,oldSecret=process.env.COLLABORATION_INTERNAL_SECRET;
  process.env.COLLABORATION_INTERNAL_URL=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  process.env.COLLABORATION_INTERNAL_SECRET="local-scene-test";
  try{
    const input=await request();
    if(changeTarget){
      await assert.rejects(runMcpCanvasGeneration(principal,input),(error:any)=>error.code==="SCENE_REVISION_CONFLICT");
      assert.equal(reserve.mock.callCount(),0);
    }else{
      const result=await runMcpCanvasGeneration(principal,input);assert.ok("generationId" in result);
      assert.equal(live.graph.nodes.find(n=>n.id==="master")!.data.videoMasterClips![1].prompt,"Concurrent scene edit");
      assert.equal(live.graph.nodes.find(n=>n.id==="master")!.data.videoMasterSelectedClipId,"clip-b");
      assert.equal(reserve.mock.callCount(),1);
    }
  }finally{
    if(oldUrl===undefined)delete process.env.COLLABORATION_INTERNAL_URL;else process.env.COLLABORATION_INTERNAL_URL=oldUrl;
    if(oldSecret===undefined)delete process.env.COLLABORATION_INTERNAL_SECRET;else process.env.COLLABORATION_INTERNAL_SECRET=oldSecret;
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});

test("a stale derivative from an old scene with identical cuts is rebuilt with current lineage",async()=>{
  const original=await db.prepare("SELECT storage_path FROM assets WHERE id=?").get(graph.nodes[0].data.assetId!) as {storage_path:string};
  const staleId=crypto.randomUUID();
  await db.prepare("INSERT INTO assets (id,workspace_id,project_id,kind,role,filename,storage_path,mime_type,metadata_json,created_at) VALUES (?,'scene-space','scene-canvas','video_segment','reference_video','old-scene.mp4',?,'video/mp4',?,?)")
    .run(staleId,original.storage_path,JSON.stringify({sourceAssetId:graph.nodes[0].data.assetId,segmentId:"deleted-segment",start:0,end:5.3}),new Date().toISOString());
  graph.nodes[0].data.videoSegments![0].clipAssetId=staleId;
  graph.nodes[0].data.videoSegments![0].clipUrl=`/api/assets/${staleId}`;
  await db.prepare("UPDATE projects SET graph_json=? WHERE id='scene-canvas'").run(JSON.stringify(graph));
  const result=await runMcpCanvasGeneration(principal,await request());assert.ok("generationId" in result);
  const payload=await dispatch(result.generationId);assert.notEqual(payload.targetSourceAssetId,staleId);
  const row=await db.prepare("SELECT metadata_json FROM assets WHERE id=?").get(payload.targetSourceAssetId) as {metadata_json:string};
  assert.equal(JSON.parse(row.metadata_json).segmentId,"segment-a");
});
