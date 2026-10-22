import assert from 'node:assert/strict';
import {after,afterEach,beforeEach,mock,test} from 'node:test';
import {db,resetTestDatabase,closeRelationalPool} from './postgres-test-db';
import {saveBytes} from '../src/lib/storage';
import {getMcpCanvas,editMcpCanvasImage} from '../src/lib/mcp/service';
import {usageAuthority} from '../src/modules/usage';
import type {McpPrincipal} from '../src/lib/mcp/oauth';
const principal:McpPrincipal={connectionId:'edit-test',clientId:'edit-test',userId:'edit-user',workspaceId:'edit-space',projectIds:['edit-canvas'],libraryAccess:true,scopes:['mcp:read','canvas:write','generation:run'],resource:'https://scenelith.example/api/mcp',expiresAt:new Date(Date.now()+3600000).toISOString()};
const original='Original scene generation prompt';
beforeEach(async()=>{
 await resetTestDatabase();const now=new Date().toISOString();
 await db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES('edit-user','edit@example.test','Edit',?,?)").run(now,now);
 await db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('edit-space','Edits',?,?)").run(now,now);
 await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('edit-space','edit-user','owner',?)").run(now);
 const assetId=crypto.randomUUID(),stored=await saveBytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),'edit-test','source.png','image/png');
 const graph={nodes:[{id:'image',type:'frameNode',position:{x:0,y:0},data:{kind:'prompt',title:'Image',mediaType:'image',modelId:'nano-banana-2',assetId,outputUrl:`/api/assets/${assetId}`,prompt:original}}],edges:[]};
 await db.prepare("INSERT INTO projects(id,workspace_id,name,graph_json,created_at,updated_at) VALUES('edit-canvas','edit-space','Edits',?,?,?)").run(JSON.stringify(graph),now,now);
 await db.prepare("INSERT INTO assets(id,workspace_id,project_id,kind,role,filename,storage_path,mime_type,metadata_json,created_at) VALUES(?,'edit-space','edit-canvas','generated_image','generated','source.png',?,'image/png','{}',?)").run(assetId,stored.reference,now);
 const usage=await usageAuthority();mock.method(usage,'summary',async()=>({usageMode:'unmetered',profileId:'test',profileName:'Test',used:0,limit:0,remaining:0,assistantEnabled:true,generationConcurrency:8,version:1,updatedAt:now}));mock.method(usage,'reserveGeneration',async()=>true);
});
afterEach(()=>mock.restoreAll());after(closeRelationalPool);
test('MCP Edit queues a separate edit instruction and leaves the generation node prompt intact',async()=>{
 const canvas=await getMcpCanvas(principal,'edit-canvas');
 const result=await editMcpCanvasImage(principal,{projectId:canvas.id,expectedRevision:canvas.revision,readSet:canvas.readSet,nodeId:'image',prompt:'Change only the hair color'});
 assert.ok('generationId' in result);
 const updated=await getMcpCanvas(principal,canvas.id);assert.equal(updated.graph.nodes[0].data.prompt,original);
 const generation=await db.prepare('SELECT prompt,operation FROM generations WHERE id=?').get(result.generationId) as {prompt:string;operation:string};
 assert.equal(generation.operation,'edit');assert.match(generation.prompt,/Change only the hair color/);assert.match(generation.prompt,/@EditSource/);
});
