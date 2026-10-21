import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createScenelithMcpServer } from "../src/lib/mcp/server";
import { db, resetTestDatabase, closeRelationalPool } from "./postgres-test-db";
import { getMcpCanvas, getMcpCanvasNodes, patchMcpCanvas, configureMcpCanvasNode, duplicateMcpCanvasNode, connectMcpCanvasNodes } from "../src/lib/mcp/service";
import { issueCanvasReadReceipt, resolveCanvasReadReceipt } from "../src/lib/mcp/canvas-read-receipts";
import { canvasReadSet, canvasNodeSemanticRevision } from "../src/lib/mcp/canvas-concurrency";
import type { McpPrincipal } from "../src/lib/mcp/oauth";
import type { ProjectGraph } from "../src/lib/types";

const principal: McpPrincipal = { connectionId:"collaborator",clientId:"client",userId:"user",workspaceId:"space",projectIds:["canvas"],libraryAccess:true,scopes:["mcp:read","canvas:write","generation:run"],resource:"https://scenelith.example/api/mcp",expiresAt:new Date(Date.now()+3600000).toISOString() };
let graph: ProjectGraph;
beforeEach(async()=>{
  await resetTestDatabase();
  const now=new Date().toISOString();
  await db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES ('user','collab@example.test','Collab',?,?)").run(now,now);
  await db.prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('space','Collab',?,?)").run(now,now);
  await db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES ('space','user','owner',?)").run(now);
  graph={nodes:[
    {id:"agent",type:"frameNode",position:{x:0,y:0},data:{kind:"note",title:"Agent",noteText:"Original"}},
    {id:"human",type:"frameNode",position:{x:400,y:0},data:{kind:"note",title:"Human",noteText:"Independent"}},
    {id:"generator",type:"frameNode",position:{x:800,y:0},data:{kind:"prompt",mediaType:"image",title:"Image",modelId:"nano-banana-2",prompt:"Original portrait"}},
    {id:"source",type:"frameNode",position:{x:1200,y:0},data:{kind:"scene",mediaType:"image",title:"Source",assetId:"original-image",imageUrl:"/api/assets/original-image"}},
  ],edges:[{id:"input",source:"source",target:"generator",targetHandle:"reference-image-input",data:{portType:"image",inputRole:"reference-image"}}]};
  await db.prepare("INSERT INTO projects (id,workspace_id,name,graph_json,created_at,updated_at) VALUES ('canvas','space','Collab',?,?,?)").run(JSON.stringify(graph),now,now);
});
after(closeRelationalPool);
const read=()=>getMcpCanvas(principal,"canvas");
async function human(operations: Parameters<typeof patchMcpCanvas>[1]["operations"]) { const canvas=await read();return patchMcpCanvas(principal,{projectId:"canvas",expectedRevision:canvas.revision,operations}); }
function conflict(nodeId:string,field?:string) { return (error:unknown)=>{const value=error as {code:string;refreshNodeIds:string[];conflicts:{fields:string[]}[]};assert.equal(value.code,"CANVAS_REVISION_CONFLICT");assert.ok(value.refreshNodeIds.includes(nodeId));if(field)assert.ok(value.conflicts.some(c=>c.fields.includes(field)));return true;}; }

test("one read supports independent nodes and different fields on the same node, including layout",async()=>{
  const base=await read();
  await human([{type:"update_node",nodeId:"human",data:{noteText:"Human edited"}},{type:"update_node",nodeId:"agent",position:{x:25,y:55},data:{title:"Human title"}}]);
  const updated=await configureMcpCanvasNode(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,nodeId:"agent",configuration:{noteText:"Agent edited"}});
  assert.equal(updated.graph.nodes.find(n=>n.id==="human")!.data.noteText,"Human edited");
  assert.deepEqual(updated.graph.nodes.find(n=>n.id==="agent")!.position,{x:25,y:55});
  assert.equal(updated.graph.nodes.find(n=>n.id==="agent")!.data.title,"Human title");
  assert.equal(updated.graph.nodes.find(n=>n.id==="agent")!.data.noteText,"Agent edited");
  // The same original proof can still be used for another untouched node.
  const moved=await patchMcpCanvas(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,operations:[{type:"update_node",nodeId:"source",position:{x:1400,y:100}}]});
  assert.equal(moved.graph.nodes.find(n=>n.id==="agent")!.data.noteText,"Agent edited");
});

test("the same changed field is rejected with a focused refresh, including deletion and cross-canvas proofs",async()=>{
  const base=await read();
  await human([{type:"update_node",nodeId:"agent",data:{noteText:"Human owns this edit"}}]);
  await assert.rejects(configureMcpCanvasNode(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,nodeId:"agent",configuration:{noteText:"Stale agent edit"}}),conflict("agent","data.noteText"));
  const focus=await getMcpCanvasNodes(principal,"canvas",["agent","deleted"]);
  assert.deepEqual(focus.nodes.map(n=>n.id),["agent"]);assert.deepEqual(focus.missingNodeIds,["deleted"]);assert.equal(focus.readSet.nodes.human,undefined);
  await human([{type:"remove_node",nodeId:"agent"}]);
  await assert.rejects(patchMcpCanvas(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,operations:[{type:"update_node",nodeId:"agent",data:{noteText:"Resurrect"}}]}),conflict("agent","node"));
  await assert.rejects(patchMcpCanvas(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:{...base.readSet,canvasId:"other"},operations:[]}),{code:"INVALID_CANVAS_READ_SET"});
});

test("focused semantic reads track incoming media, model and edges but ignore positions",async()=>{
  const base=await read();
  await human([{type:"update_node",nodeId:"source",position:{x:1300,y:500}},{type:"update_node",nodeId:"generator",position:{x:850,y:800}}]);
  const copy=await duplicateMcpCanvasNode(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,nodeId:"generator"});
  assert.equal(copy.node.data.prompt,"Original portrait");
  const focused=await getMcpCanvasNodes(principal,"canvas",["generator"]);
  assert.deepEqual(focused.inputNodes.map(n=>n.id),["source"]);assert.equal(focused.nodes.length,1);
  assert.equal(focused.readSet.nodes.source.inputsRead,false);
  await assert.rejects(duplicateMcpCanvasNode(principal,{projectId:"canvas",expectedRevision:focused.revision,readSet:focused.readSet,nodeId:"source"}),conflict("source","inputs"));
  await human([{type:"update_node",nodeId:"source",data:{assetId:"replacement",imageUrl:"/api/assets/replacement"}}]);
  await assert.rejects(duplicateMcpCanvasNode(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,nodeId:"generator"}),conflict("generator","inputs"));
  await assert.rejects(configureMcpCanvasNode(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,nodeId:"generator",configuration:{prompt:"New portrait"}}),conflict("generator","inputs"));
});

test("new connections on a target cannot be silently replaced by an outdated semantic request",async()=>{
  const base=await read();
  await human([{type:"remove_edge",edgeId:"input"}]);
  await assert.rejects(connectMcpCanvasNodes(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,sourceNodeId:"source",targetNodeId:"generator",inputRole:"reference-image"}),conflict("generator","inputs"));
  const latest=await read();
  await human([{type:"update_node",nodeId:"human",position:{x:70,y:70}}]);
  await assert.rejects(patchMcpCanvas(principal,{projectId:"canvas",expectedRevision:latest.revision,operations:[]}),{code:"CANVAS_REVISION_CONFLICT"});
});

for(const sameField of [false,true]) test(`live state-vector CAS retries ${sameField?"reject a conflicting field":"merge unrelated changes at the same persisted revision"}`,async()=>{
  const base=await read();
  let live={graph:base.graph,revision:base.revision,stateVector:"v1",updatedAt:new Date().toISOString()};let writes=0;
  const server=createServer(async(req,res)=>{
    if(req.method==="PUT"){
      let body="";for await(const chunk of req)body+=chunk;const command=JSON.parse(body);writes++;
      assert.equal(command.expectedStateVector,live.stateVector);
      if(writes===1){live=structuredClone(live);live.graph.nodes.find(n=>n.id===(sameField?"agent":"human"))!.data.noteText="Concurrent browser edit";live.stateVector="v2";res.statusCode=409;}
      else {live={...live,graph:command.graph,revision:live.revision+1,stateVector:"v3"};}
    }
    res.setHeader("content-type","application/json");res.end(JSON.stringify(live));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const previous={url:process.env.COLLABORATION_INTERNAL_URL,secret:process.env.COLLABORATION_INTERNAL_SECRET};
  process.env.COLLABORATION_INTERNAL_URL=`http://127.0.0.1:${(server.address() as {port:number}).port}`;process.env.COLLABORATION_INTERNAL_SECRET="test";
  try{
    const action=patchMcpCanvas(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,operations:[{type:"update_node",nodeId:"agent",data:{noteText:"Agent edit"}}]});
    if(sameField){await assert.rejects(action,conflict("agent","data.noteText"));assert.equal(writes,1);}
    else {const result=await action;assert.equal(writes,2);assert.equal(result.graph.nodes.find(n=>n.id==="human")!.data.noteText,"Concurrent browser edit");assert.equal(result.graph.nodes.find(n=>n.id==="agent")!.data.noteText,"Agent edit");}
  }finally{if(previous.url===undefined)delete process.env.COLLABORATION_INTERNAL_URL;else process.env.COLLABORATION_INTERNAL_URL=previous.url;if(previous.secret===undefined)delete process.env.COLLABORATION_INTERNAL_SECRET;else process.env.COLLABORATION_INTERNAL_SECRET=previous.secret;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("semantic input hashes are stable under key ordering and playback progress",async()=>{
  const before=canvasNodeSemanticRevision(graph,"generator");
  const moved=structuredClone(graph);moved.nodes[2].position={x:100,y:800};moved.nodes[2].selected=true;moved.nodes[2].data.status="queued";moved.nodes[3].position={x:1400,y:500};
  assert.equal(canvasNodeSemanticRevision(moved,"generator"),before);
  moved.nodes[2].data.prompt="Different";assert.notEqual(canvasNodeSemanticRevision(moved,"generator"),before);
  assert.ok(canvasReadSet("canvas",1,graph).nodes.generator.fields.prompt);
});


test("MCP transports accept and return scoped proofs, focused refresh and actionable conflict fields",async()=>{
  const server=createScenelithMcpServer(principal,"https://scenelith.example");
  const client=new Client({name:"concurrent-agent",version:"1"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  try {
    const initial=await client.callTool({name:"get_canvas",arguments:{canvas_id:"canvas"}});
    const base=(initial.structuredContent as {canvas:{revision:number;readSet:string}}).canvas;
    await human([{type:"update_node",nodeId:"human",data:{noteText:"Browser change"}}]);
    const action=await client.callTool({name:"configure_canvas_node",arguments:{canvas_id:"canvas",expected_revision:base.revision,read_set:base.readSet,node_id:"agent",note_text:"MCP edit"}});
    assert.equal(action.isError,undefined);
    const applied=(action.structuredContent as {canvas:{partial:boolean;graph:ProjectGraph;readSet:string}}).canvas;
    assert.equal(applied.partial,true);assert.deepEqual(applied.graph.nodes.map(node=>node.id),["agent"]);
    assert.equal((await resolveCanvasReadReceipt(principal,applied.readSet))?.nodes.human,undefined);
    const stale=await client.callTool({name:"configure_canvas_node",arguments:{canvas_id:"canvas",expected_revision:base.revision,read_set:base.readSet,node_id:"agent",note_text:"Stale edit"}});
    assert.equal(stale.isError,true);const failure=stale.structuredContent as {refreshNodeIds:string[];conflicts:unknown};assert.deepEqual(failure.refreshNodeIds,["agent"]);assert.match(JSON.stringify(failure.conflicts),/data.noteText/);
    const focus=await client.callTool({name:"get_canvas_nodes",arguments:{canvas_id:"canvas",node_ids:["agent"]}});
    assert.equal(focus.isError,undefined);const focused=focus.structuredContent as {nodes:unknown[];graph?:unknown;readSet:string};assert.equal(focused.nodes.length,1);assert.equal(focused.graph,undefined);assert.match(focused.readSet,/^cr1_/);assert.ok(focused.readSet.length<50);
    const denied=await client.callTool({name:"get_canvas_nodes",arguments:{canvas_id:"not-approved",node_ids:["agent"]}});
    assert.equal(denied.isError,true);
  } finally {await client.close();await server.close();}
});


test("short read receipts survive server instances, enforce connection ownership, expire and stay bounded",async()=>{
  const base=await read();const token=await issueCanvasReadReceipt(principal,base.readSet);
  assert.equal(await issueCanvasReadReceipt(principal,base.readSet),token);
  assert.deepEqual((await resolveCanvasReadReceipt({...principal},token))?.nodes,base.readSet.nodes);
  await assert.rejects(resolveCanvasReadReceipt({...principal,connectionId:"other"},token),{code:"CANVAS_READ_SET_EXPIRED"});
  await db.prepare("UPDATE mcp_canvas_reads SET expires_at=now()-interval '1 second' WHERE id=?").run(token.slice(4));
  await assert.rejects(resolveCanvasReadReceipt(principal,token),{code:"CANVAS_READ_SET_EXPIRED"});
  for(let revision=1;revision<=130;revision++)await issueCanvasReadReceipt(principal,{...base.readSet,revision});
  const count=await db.prepare("SELECT count(*) AS count FROM mcp_canvas_reads WHERE connection_id=?").get(principal.connectionId) as {count:number};assert.equal(count.count,128);
});


test("renaming a generator does not normalize or change its independent model settings",async()=>{
  const base=await read();await human([{type:"update_node",nodeId:"generator",data:{modelId:"legacy-model",resolution:"historic-resolution",prompt:"Human prompt"}}]);
  const result=await configureMcpCanvasNode(principal,{projectId:"canvas",expectedRevision:base.revision,readSet:base.readSet,nodeId:"generator",configuration:{title:"Agent title"}});
  const node=result.graph.nodes.find(node=>node.id==="generator")!;assert.equal(node.data.title,"Agent title");assert.equal(node.data.modelId,"legacy-model");assert.equal(node.data.resolution,"historic-resolution");assert.equal(node.data.prompt,"Human prompt");
});
