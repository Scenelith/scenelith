import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { db, resetTestDatabase, closeRelationalPool } from './postgres-test-db';
import { readProjectGraphSnapshot } from '../src/lib/postgres-db';
import { detachAssetReferences } from '../src/lib/detach-asset-references';
import { detachWorkspaceAssetReferences } from '../src/lib/identity-reference-deletion';
import { loadGenerationReferenceAssets } from '../src/lib/generation-reference-assets';
import { removeMcpIdentityReference } from '../src/lib/mcp/service';
import type { ProjectGraph } from '../src/lib/types';
import type { McpPrincipal } from '../src/lib/mcp/oauth';

const principal: McpPrincipal = { userId: 'owner', workspaceId: 'space', projectIds: null, libraryAccess: true,
  connectionId: 'connection', clientId: 'client', scopes: ['mcp:read','library:write'], resource: 'https://example.test/api/mcp', expiresAt: new Date(Date.now()+3600000).toISOString() };
const ref = (assetId: string) => ({ assetId, url: `/api/assets/${assetId}`, title: assetId, role: 'reference-image' as const });
function graph(): ProjectGraph {
  return { nodes: [
    { id:'image',type:'frameNode',position:{x:100,y:200},data:{kind:'prompt',title:'Keep title',prompt:'Keep prompt',assetId:'output',outputUrl:'/api/assets/output',
      attachedReferences:[ref('deleted'),ref('kept')], generatedOutputs:[{assetId:'output',url:'/api/assets/output',mediaType:'image'}],
      editReferencesByAssetId:{output:[{...ref('deleted'),origin:'identity',detail:'Before'},{...ref('kept'),origin:'identity',detail:'After'}]}} },
    { id:'video',type:'frameNode',position:{x:200,y:200},data:{kind:'videoMaster',title:'Video',videoMasterClips:[{id:'clip',title:'Clip',role:'scene',origin:'generated',duration:5,prompt:'Keep clip',attachedReferences:[ref('deleted'),ref('kept')]}]} },
    { id:'identity',type:'frameNode',position:{x:0,y:0},data:{kind:'persona',title:'Deleted reference',assetId:'deleted'} },
    { id:'group',type:'frameNode',position:{x:0,y:100},data:{kind:'persona',title:'Identity group',referenceAssetIds:['deleted','kept']} },
  ],edges:[{id:'edge',source:'identity',target:'image'}],viewport:{x:13,y:17,zoom:0.8} };
}
beforeEach(async()=>{
  await resetTestDatabase(); const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES ('owner','owner@example.test','Owner',?,?)").run(now,now);
  for(const id of ['space','other']) await db.prepare('INSERT INTO workspaces (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id,id,now,now);
  await db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES ('space','owner','owner',?)").run(now);
  for(const [id,space] of [['canvas-a','space'],['canvas-b','space'],['foreign','other']])
    await db.prepare('INSERT INTO projects (id,workspace_id,name,graph_json,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,space,id,JSON.stringify(graph()),now,now);
  await db.prepare("INSERT INTO personas (id,workspace_id,name,created_at,updated_at) VALUES ('identity','space','Person',?,?)").run(now,now);
  for(const id of ['deleted','kept']) await db.prepare("INSERT INTO assets (id,workspace_id,persona_id,kind,role,filename,storage_path,mime_type,created_at) VALUES (?,'space','identity','persona_ref','before',?,?,'image/png',?)").run(id,id,`test/${id}.png`,now);
});
after(closeRelationalPool);

test('detaching deletes only reference inputs, including clip/edit inputs and identity wires',()=>{
  const original=graph(); const before=structuredClone(original); const result=detachAssetReferences(original,new Set(['deleted']));
  assert.deepEqual(original,before);
  assert.deepEqual(result.nodes.map(n=>n.id),['image','video','group']);
  assert.deepEqual(result.nodes[0].data.attachedReferences,[ref('kept')]);
  assert.equal(result.nodes[0].data.editReferencesByAssetId?.output.length,1);
  assert.deepEqual(result.nodes[1].data.videoMasterClips?.[0].attachedReferences,[ref('kept')]);
  assert.deepEqual(result.nodes[2].data.referenceAssetIds,['kept']);
  assert.equal(result.nodes[2].data.imageUrl,'/api/assets/kept');
  const emptyGroup = detachAssetReferences(result,new Set(['kept']));
  assert.equal(emptyGroup.nodes.some(n=>n.id==='group'),false);
  assert.deepEqual(result.edges,[]); assert.deepEqual(result.viewport,original.viewport);
  assert.deepEqual(result.nodes[0].data.generatedOutputs,original.nodes[0].data.generatedOutputs);
  assert.equal(result.nodes[0].data.prompt,'Keep prompt'); assert.equal(result.nodes[0].data.assetId,'output');
  assert.equal(detachAssetReferences(result,new Set(['deleted'])),result);
});
test('MCP identity deletion detaches every canvas in its workspace before removing the asset',async()=>{
  await removeMcpIdentityReference(principal,{workspaceId:'space',identityId:'identity',assetId:'deleted'},'https://example.test');
  for(const id of ['canvas-a','canvas-b']){
    const snapshot=await readProjectGraphSnapshot(id);
    assert.deepEqual(snapshot.graph.nodes.find(n=>n.id==='image')?.data.attachedReferences,[ref('kept')]);
    assert.equal(snapshot.graph.nodes.some(n=>n.id==='identity'),false);
  }
  assert.deepEqual((await readProjectGraphSnapshot('foreign')).graph.nodes[0].data.attachedReferences,[ref('deleted'),ref('kept')]);
  assert.equal(await db.prepare("SELECT id FROM assets WHERE id='deleted'").get(),undefined);
  assert.ok(await db.prepare("SELECT id FROM assets WHERE id='kept'").get());
  await assert.rejects(removeMcpIdentityReference(principal,{workspaceId:'space',identityId:'identity',assetId:'kept'},'https://example.test'),/at least one/);
});
test('live collaboration cleanup retries against fresh state and preserves concurrent edits',async()=>{
  const originalFetch=globalThis.fetch; const secret=process.env.COLLABORATION_INTERNAL_SECRET;
  process.env.COLLABORATION_INTERNAL_SECRET='test'; let writes=0; const live=graph(); const documents=new Map<string,ProjectGraph>();
  globalThis.fetch=async(input,init)=>{
    const id=new URL(String(input)).pathname.split('/').at(-1)!;
    if(init?.method==='PUT'){
      writes++; const body=JSON.parse(String(init.body));
      if(writes===1){live.nodes[0].data.title='Concurrent user title';return Response.json({graph:live,revision:2,stateVector:'v2'},{status:409});}
      assert.equal(body.graph.nodes[0].data.title,'Concurrent user title'); documents.set(id,body.graph);
      return Response.json({graph:body.graph,revision:3,stateVector:'v3'});
    }
    return Response.json({graph:documents.get(id)||live,revision:writes?2:1,stateVector:writes?'v2':'v1'});
  };
  try { await detachWorkspaceAssetReferences('space',['deleted']); assert.equal(documents.size,2); assert.equal(writes,3); }
  finally { globalThis.fetch=originalFetch; process.env.COLLABORATION_INTERNAL_SECRET=secret||''; }
});
test('collaboration outage prevents destructive deletion and unavailable references return a validation result',async()=>{
  const originalFetch=globalThis.fetch; const secret=process.env.COLLABORATION_INTERNAL_SECRET; process.env.COLLABORATION_INTERNAL_SECRET='test';
  globalThis.fetch=async()=>new Response('',{status:503});
  try { await assert.rejects(removeMcpIdentityReference(principal,{workspaceId:'space',identityId:'identity',assetId:'deleted'},'https://example.test'),/Collaboration read failed/); }
  finally { globalThis.fetch=originalFetch; process.env.COLLABORATION_INTERNAL_SECRET=secret||''; }
  assert.ok(await db.prepare("SELECT id FROM assets WHERE id='deleted'").get());
  const valid=await loadGenerationReferenceAssets('owner',['kept','deleted']); assert.equal(valid.ok,true);
  if(valid.ok) assert.deepEqual(valid.assets.map(a=>a.storage_path),['test/kept.png','test/deleted.png']);
  assert.deepEqual(await loadGenerationReferenceAssets('owner',['missing','kept']),{ok:false,unavailableAssetIds:['missing']});
  assert.deepEqual(await loadGenerationReferenceAssets('stranger',['kept']),{ok:false,unavailableAssetIds:['kept']});
});
