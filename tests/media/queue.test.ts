import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createMediaJob,claimMediaJob,renewMediaLease,recoverMediaJobs,getMediaJob,cancelMediaJob,failMediaJob,retryMediaJob} from '../../src/lib/media/repository';
import {MediaError} from '../../src/lib/media/contracts';
import {executeMediaJob} from '../../src/lib/media/executor';
import {saveBytes,readStorageObject} from '../../src/lib/storage';
import {spawnSync} from 'node:child_process';
import {db,closeRelationalPool,resetTestDatabase} from '../postgres-test-db';
let user:string,workspace:string,project:string,asset:string;
before(async()=>{
 await resetTestDatabase();user=crypto.randomUUID();workspace=crypto.randomUUID();project=crypto.randomUUID();asset=crypto.randomUUID();const now=new Date().toISOString();
 await db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,'Test',?,?)").run(user,user+'@example.test',now,now);
 await db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,'Media',?,?)").run(workspace,now,now);
 await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,?,'owner',?)").run(workspace,user,now);
 await db.prepare("INSERT INTO projects(id,workspace_id,name,status,graph_json,created_at,updated_at) VALUES(?,?,'Media','draft','{}',?,?)").run(project,workspace,now,now);
 const bytes=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=96x64:r=25:d=2','-c:v','libx264','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);assert.equal(bytes.status,0,bytes.stderr.toString());
 const stored=await saveBytes(bytes.stdout,`workspaces/${workspace}`,'fixture.mp4','video/mp4');
 await db.prepare("INSERT INTO assets(id,workspace_id,project_id,kind,role,filename,storage_path,content_hash,size_bytes,mime_type,created_at) VALUES(?,?,?,'upload','reference_video','fixture.mp4',?,?,?,'video/mp4',?)")
 .run(asset,workspace,project,stored.reference,stored.contentHash,stored.size,now);
});
after(closeRelationalPool);
const request=(key:string,start=0,end=1)=>({projectId:project,requestKey:key,spec:{operation:'segment',range:{id:asset,start,end}}});
test('concurrent request delivery deduplicates; changed settings with same key conflict',async()=>{
 const jobs=await Promise.all(Array.from({length:12},()=>createMediaJob(user,request('double-click'))));
 assert.equal(new Set(jobs.map(j=>j.id)).size,1);
 await assert.rejects(createMediaJob(user,request('double-click',.2,1)),(e:unknown)=>e instanceof MediaError&&e.status===409);
 const alias=await createMediaJob(user,request('other-key'));assert.equal(alias.id,jobs[0].id);
 await assert.rejects(getMediaJob(crypto.randomUUID(),jobs[0].id));
});
test('expired owner cannot renew or publish; reclaimed job completes once',async()=>{
 const first=await claimMediaJob('old-worker','transcode');assert.ok(first);
 await db.prepare("UPDATE media_jobs SET lease_until=now()-interval '1 second' WHERE id=?").run(first.id);
 await recoverMediaJobs();
 await assert.rejects(renewMediaLease(first));
 await db.prepare('UPDATE media_jobs SET available_at=now() WHERE id=?').run(first.id);
 const second=await claimMediaJob('new-worker','transcode');assert.ok(second);assert.ok(second.fence>first.fence);
 await executeMediaJob(first);assert.equal((await getMediaJob(user,first.id)).status,'running');
 await executeMediaJob(second);
 const result=await getMediaJob(user,first.id);assert.equal(result.status,'completed');assert.ok(result.result_asset_id);
 const row=await db.prepare('SELECT storage_path FROM assets WHERE id=?').get(result.result_asset_id) as {storage_path:string};
 assert.ok((await readStorageObject(row.storage_path)).length>0);
 const again=await createMediaJob(user,request('double-click'));assert.equal(again.result_asset_id,result.result_asset_id);
});
test('cancelled work cannot be completed and revoked access is checked at execution',async()=>{
 const cancel=await createMediaJob(user,request('cancel',.2,1.2));const claimed=await claimMediaJob('worker','transcode');assert.equal(claimed?.id,cancel.id);
 await cancelMediaJob(user,cancel.id);await executeMediaJob(claimed!);assert.equal((await getMediaJob(user,cancel.id)).status,'cancelled');
 const revoke=await createMediaJob(user,request('revoke',.4,1.4));const next=await claimMediaJob('worker','transcode');assert.equal(next?.id,revoke.id);
 await db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(workspace,user);
 await executeMediaJob(next!);const row=await db.prepare('SELECT status,error_code FROM media_jobs WHERE id=?').get(revoke.id);
 assert.deepEqual(row,{status:'failed',error_code:'JOB_UNAVAILABLE'});
 await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,?,'owner',?)").run(workspace,user,new Date().toISOString());
});
test('temporary errors retry with same id; corrupt media is terminal; light work can be claimed independently',async()=>{
 const heavy=await createMediaJob(user,request('retry',.6,1.6));const active=await claimMediaJob('worker','transcode');assert.equal(active?.id,heavy.id);
 const probe=await createMediaJob(user,{projectId:project,requestKey:'probe',spec:{operation:'frame',assetId:asset,time:.12}});
 assert.equal((await claimMediaJob('worker','light'))?.id,probe.id);
 await failMediaJob(active!,new MediaError('STORAGE_TIMEOUT',503,true));assert.equal((await getMediaJob(user,heavy.id)).status,'retry_wait');
 await db.prepare('UPDATE media_jobs SET available_at=now() WHERE id=?').run(heavy.id);
 const retry=await claimMediaJob('worker','transcode');assert.equal(retry?.id,heavy.id);
 await failMediaJob(retry!,new MediaError('INVALID_MEDIA'));assert.equal((await getMediaJob(user,heavy.id)).status,'failed');
});
test('dependencies wait without occupying a worker and terminate on dependency cancellation',async()=>{
 const parent=await createMediaJob(user,request('parent',.1,1.3));
 const child=await createMediaJob(user,{...request('child',.3,1.3),dependencies:[parent.id]});
 assert.equal(child.stage,'waiting_dependencies');
 const claim=await claimMediaJob('deps','transcode');assert.equal(claim?.id,parent.id);
 assert.equal(await claimMediaJob('deps','transcode'),null);
 await cancelMediaJob(user,parent.id);await recoverMediaJobs();
 assert.equal((await getMediaJob(user,child.id)).error_code,'DEPENDENCY_FAILED');
});
test('scene extraction publishes every derivative atomically and repeat returns the same files',async()=>{
 const job=await createMediaJob(user,{projectId:project,requestKey:'scene-proof',spec:{operation:'scenes',assetId:asset}});
 const claimed=await claimMediaJob('scene-worker','transcode');assert.equal(claimed?.id,job.id);
 await executeMediaJob(claimed!);
 const complete=await getMediaJob(user,job.id);assert.equal(complete.status,'completed',complete.error_code||'');
 const result=JSON.parse(complete.result_json!);assert.equal(result.asset.id,asset);
 assert.ok(result.assets.some((a:{role:string})=>a.role==='timeline'));
 assert.ok(result.assets.some((a:{role:string})=>a.role==='hook'));
 const objects=await db.prepare('SELECT retained FROM media_job_objects WHERE job_id=?').all(job.id) as {retained:boolean}[];
 assert.equal(objects.length,result.assets.length);assert.ok(objects.every(o=>o.retained));
 assert.equal((await createMediaJob(user,{projectId:project,requestKey:'scene-repeat',spec:{operation:'scenes',assetId:asset}})).result_json,complete.result_json);
});
test('an uncertain paid submission is reconciled, never blindly requeued, and a callback restores its task',async()=>{
 const receipts=await import('../../src/lib/generation-receipts');
 const id=crypto.randomUUID(),now=new Date().toISOString();
 await db.prepare("INSERT INTO generations(id,project_id,usage_workspace_id,requested_by_user_id,node_id,prompt,status,operation,model_id,media_type,credit_cost,created_at,updated_at,media_execution_version) VALUES(?,?,?,?,?,'test','queued','generation','wan-3','video',1,?,?,1)").run(id,project,workspace,user,crypto.randomUUID(),now,now);
 await db.prepare("INSERT INTO generation_dispatch_jobs(generation_id,payload_json,status,attempts,available_at,created_at,updated_at,locked_at,locked_by) VALUES(?,'{}','dispatching',1,?,?,?,?, 'receipt-test')").run(id,now,now,now,now);
 const receipt=await receipts.prepareProviderReceipt(id);
 await receipts.markProviderSubmission(id,'receipt-test',1);
 await assert.rejects(receipts.markProviderSubmission(id,'receipt-test',1));
 await db.prepare("UPDATE generation_dispatch_jobs SET locked_at=now()-interval '10 minutes' WHERE generation_id=?").run(id);
 await receipts.recoverProviderReceipts(new Date(Date.now()-300000).toISOString());
 assert.deepEqual(await db.prepare('SELECT status FROM generation_dispatch_jobs WHERE generation_id=?').get(id),{status:'reconciling'});
 assert.deepEqual(await db.prepare('SELECT status FROM generations WHERE id=?').get(id),{status:'reconciling'});
 assert.equal(await receipts.bindProviderReceipt('wrong-token','provider-test'),null);
 assert.deepEqual(await receipts.bindProviderReceipt(receipt.callback_token,'provider-test'),{id});
 assert.equal(await receipts.bindProviderReceipt(receipt.callback_token,'another-task'),null);
 assert.deepEqual(await db.prepare('SELECT status FROM generation_dispatch_jobs WHERE generation_id=?').get(id),{status:'dispatched'});
 assert.deepEqual(await db.prepare('SELECT provider_task_id FROM generations WHERE id=?').get(id),{provider_task_id:'provider-test'});
});

test('only an explicit authorized retry restarts a failed media operation and retains its identity',async()=>{
 const job=await createMediaJob(user,request('manual-retry',.76,1.76));
 await db.prepare("UPDATE media_jobs SET status='failed',attempts=3,error_code='STORAGE_TIMEOUT' WHERE id=?").run(job.id);
 assert.equal((await createMediaJob(user,request('manual-retry-again',.76,1.76))).status,'failed');
 await assert.rejects(retryMediaJob(crypto.randomUUID(),job.id));
 const retry=await retryMediaJob(user,job.id);
 assert.equal(retry.id,job.id);assert.equal(retry.status,'queued');assert.equal(retry.attempts,0);assert.ok(retry.fence>job.fence);
 await cancelMediaJob(user,job.id);
});

test('dedicated media role can process and publish but cannot read provider receipts or mutate generation billing',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {relationalPool}=await import('../../src/lib/relational-db');
 await relationalPool().query(await readFile('database/provision-media-worker.sql','utf8'));
 const job=await createMediaJob(user,{projectId:project,requestKey:'restricted-worker',spec:{operation:'frame',assetId:asset,time:.444}});
 await db.transaction(async()=>{
  // A local role is confined to this test connection; production execution never holds a processing transaction.
  await db.prepare('SET LOCAL ROLE scenelith_media_worker').run();
  const claimed=await claimMediaJob('restricted','light');assert.equal(claimed?.id,job.id);
  await executeMediaJob(claimed!);
  assert.equal((await getMediaJob(user,job.id)).status,'completed');
  const rights=await db.prepare("SELECT has_table_privilege(current_user,'generation_provider_receipts','SELECT') AS receipts,has_table_privilege(current_user,'generations','UPDATE') AS generations,has_table_privilege(current_user,'users','SELECT') AS users").get();
  assert.deepEqual(rights,{receipts:0,generations:0,users:0});
 })();
});

test('operational metrics include stage timing, processing paths and expired ownership',async()=>{
 const {mediaMetrics}=await import('../../src/lib/media/metrics');
 const text=await mediaMetrics();
 assert.match(text,/scenelith_media_stage_seconds_24h/);
 assert.match(text,/scenelith_media_processing_path_24h/);
 assert.match(text,/scenelith_media_expired_leases/);
});

test('storage cleanup keeps files referenced by saved assets or active media jobs',async()=>{
 const {enqueueStorageDeletion,drainStorageLifecycle}=await import('../../src/lib/storage-lifecycle');
 const row=await db.prepare('SELECT storage_path FROM assets WHERE id=?').get(asset) as {storage_path:string};
 await enqueueStorageDeletion(row.storage_path,workspace,'test-retention');
 await drainStorageLifecycle();
 assert.ok((await readStorageObject(row.storage_path)).length>0);
 const temporary=await saveBytes(Buffer.from('temporary dependent input'),`workspaces/${workspace}`,'retained-test.bin','application/octet-stream');
 const job=await createMediaJob(user,request('retention-test',.8,1.8));
 // Simulate the immutable input snapshot remaining after source metadata removal.
 await db.prepare('UPDATE media_jobs SET inputs_json=? WHERE id=?').run(JSON.stringify([{storage_path:temporary.reference}]),job.id);
 await enqueueStorageDeletion(temporary.reference,workspace,'test-retention');await drainStorageLifecycle();
 assert.equal((await readStorageObject(temporary.reference)).toString(),'temporary dependent input');
 await db.prepare("UPDATE media_jobs SET status='failed' WHERE id=?").run(job.id);await drainStorageLifecycle();
 await assert.rejects(readStorageObject(temporary.reference));
});
