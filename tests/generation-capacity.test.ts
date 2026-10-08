import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { db, resetTestDatabase, closeRelationalPool } from "./postgres-test-db";
import { activeGenerationCount, generationCapacity } from "../src/lib/generation-capacity";
import { admitGeneration, type GenerationAdmissionInput } from "../src/lib/generation-admission";
import { usageAuthority } from "../src/modules/usage";

const now = new Date().toISOString();
const request: GenerationAdmissionInput = {
  userId: "owner", projectId: "canvas", nodeId: "new", prompt: "Portrait",
  model: { id: "nano-banana-2", mediaType: "image", providerPath: "nano-banana-2" },
  references: [], operation: "generation", aspectRatio: "1:1", resolution: "1K", duration: "5",
  generateAudio: false, hasVideoInput: false, inputVideoDurationSeconds: 0,
};
beforeEach(async () => {
  await resetTestDatabase();
  await db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES ('owner','owner@example.test','Owner',?,?)").run(now, now);
  for (const space of ["space", "other"]) {
    await db.prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(space, space, now, now);
  }
  await db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES ('space','owner','owner',?)").run(now);
  for (const [id, workspace] of [["canvas", "space"], ["second-canvas", "space"], ["foreign-canvas", "other"]]) {
    await db.prepare("INSERT INTO projects (id,workspace_id,name,graph_json,created_at,updated_at) VALUES (?,?,?,'{}',?,?)").run(id, workspace, id, now, now);
  }
  const authority = await usageAuthority();
  mock.method(authority, "summary", async () => ({ usageMode: "unmetered", profileId: "test", profileName: "Test", used: 0, limit: 0, remaining: 0, assistantEnabled: true, generationConcurrency: 2, version: 1, updatedAt: now }));
});
afterEach(() => mock.restoreAll());
after(closeRelationalPool);

async function generation(id: string, status: string, project = "canvas", workspace = "space", outputUrl: string | null = null) {
  await db.prepare("INSERT INTO generations (id,project_id,usage_workspace_id,node_id,prompt,status,output_url,created_at,updated_at) VALUES (?,?,?,?,'Portrait',?,?,?,?)").run(id, project, workspace, id, status, outputUrl, now, now);
}

test("capacity includes other canvases in the workspace but excludes terminal outputs and other workspaces", async () => {
  await generation("running", "running");
  await generation("queued", "queued", "second-canvas");
  await generation("foreign", "running", "foreign-canvas", "other");
  for (const status of ["failed", "fail", "error", "cancelled", "canceled", "completed", "complete", "succeeded", "success"]) await generation(status, status.toUpperCase());
  await generation("has-output", "running", "canvas", "space", "/finished.png");
  assert.equal(await activeGenerationCount("space"), 2);
  assert.deepEqual(await generationCapacity("owner", "canvas"), { concurrency: 2, available: 0, retryAfterMs: 3000 });
  await db.prepare("UPDATE generations SET status='completed' WHERE id='running'").run();
  assert.equal((await generationCapacity("owner", "canvas"))?.available, 1);
  assert.equal(await generationCapacity("owner", "foreign-canvas"), null);
  assert.equal(await generationCapacity("owner", "missing"), null);
});

test("capacity and locked admission agree without reserving credits for a full workspace", async () => {
  const authority = await usageAuthority();
  const reserve = mock.method(authority, "reserveGeneration", async () => true);
  await generation("one", "running");
  await generation("two", "dispatching", "second-canvas");
  for (let i = 0; i < 3; i += 1) assert.equal((await generationCapacity("owner", "canvas"))?.available, 0);
  const rejected = await admitGeneration(request);
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.code, "GENERATION_CONCURRENCY_LIMIT");
  assert.equal(reserve.mock.calls.length, 0);
  assert.equal(await activeGenerationCount("space"), 2);
});

test('Studio concurrent retries reserve and enqueue exactly once, including after completion', async () => {
  const authority = await usageAuthority();
  const reserve = mock.method(authority, 'reserveGeneration', async () => true);
  const input = {...request,requestKey:crypto.randomUUID()};
  const replies = await Promise.all([admitGeneration(input),admitGeneration(input)]);
  assert.ok(replies[0].ok && replies[1].ok);
  assert.equal(replies[0].generationId,replies[1].generationId);
  assert.equal(reserve.mock.callCount(),1);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM generation_dispatch_jobs').get() as {count:number}).count,1);
  await db.prepare("UPDATE generations SET status='completed' WHERE id=?").run(replies[0].generationId);
  const replay=await admitGeneration(input);
  assert.ok(replay.ok);assert.equal(replay.generationId,replies[0].generationId);
  assert.equal(reserve.mock.callCount(),1);
  const conflicting=await admitGeneration({...input,prompt:'Different portrait'});
  assert.equal(!conflicting.ok&&conflicting.code,'REQUEST_KEY_CONFLICT');
});

test('a changed quote cannot reserve credits or create a task', async () => {
 const reserve=mock.method(await usageAuthority(),'reserveGeneration',async()=>true);
 const reply=await admitGeneration({...request,expectedCredits:1});
 assert.equal(!reply.ok&&reply.code,'QUOTE_CHANGED');assert.equal(reserve.mock.callCount(),0);
 assert.equal((await db.prepare('SELECT count(*) AS count FROM generations').get() as {count:number}).count,0);
});

test('insufficient credits never dispatch a provider task',async()=>{
 const reserve=mock.method(await usageAuthority(),'reserveGeneration',async()=>false);
 const reply=await admitGeneration({...request,requestKey:crypto.randomUUID()});
 assert.equal(!reply.ok&&reply.status,402);assert.equal(reserve.mock.callCount(),1);
 assert.equal((await db.prepare('SELECT count(*) AS count FROM generation_dispatch_jobs').get() as {count:number}).count,0);
});

test('Studio service projects are isolated per workspace and creation is repeatable',async()=>{
 const {studioWorkspace}=await import('../src/lib/studio-workspace');
 const [a,b]=await Promise.all([studioWorkspace('owner','space'),studioWorkspace('owner','space')]);
 assert.equal(a.projectId,b.projectId);
 assert.equal((await db.prepare('SELECT purpose FROM projects WHERE id=?').get(a.projectId) as {purpose:string}).purpose,'studio');
 await assert.rejects(studioWorkspace('owner','other'),/Workspace not found/);
 assert.equal((await db.prepare("SELECT purpose FROM projects WHERE id='canvas'").get() as {purpose:string}).purpose,'canvas');
});

test('reference uploads are idempotent after a lost response and reject reuse for another file',async()=>{
 const {persistStudioUpload}=await import('../src/lib/studio-upload');
 const file={id:crypto.randomUUID(),workspaceId:'space',projectId:'canvas',bytes:Buffer.from('file'),mimeType:'audio/wav',name:'reference.wav',metadata:{}};
 const [a,b]=await Promise.all([persistStudioUpload(file),persistStudioUpload(file)]);
 assert.equal(a,b);
 assert.equal((await db.prepare('SELECT count(*) AS count FROM assets WHERE id=?').get(a) as {count:number}).count,1);
 await assert.rejects(persistStudioUpload({...file,bytes:Buffer.from('different')}),/another file/);
 await assert.rejects(persistStudioUpload({...file,workspaceId:'other'}),/another file/);
});
