import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { db, resetTestDatabase, closeRelationalPool } from "./postgres-test-db";
import { putStorageObject, readStorageObject } from "../src/lib/storage";
import { textOverlay } from "../src/lib/automation-workflows/text-overlay";
import { coreAutomationNodeHandlers } from "../src/lib/automation-workflows/node-handlers";
import { automationNodeDefinition } from "../src/lib/automation-workflows/registry";
import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, automationNodeSchema } from "../src/lib/automation-workflows/types";
import type { AutomationNodeExecution } from "../src/lib/automation-workflows/runtime";
import { parseCurrentAutomationGeneratedAssets } from "../src/lib/automation-workflows/port-contracts";

before(async () => {
  await resetTestDatabase();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES ('overlay-owner','overlay@example.test','Owner',?,?)").run(now, now);
  await db.prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('overlay-space','Space',?,?)").run(now, now);
  await db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES ('overlay-space','overlay-owner','owner',?)").run(now);
  await db.prepare("INSERT INTO projects (id,workspace_id,name,graph_json,created_at,updated_at) VALUES ('overlay-project','overlay-space','Canvas','{}',?,?)").run(now, now);
  await db.prepare("INSERT INTO automation_workflows (id,workspace_id,name,status,created_at,updated_at) VALUES ('overlay-workflow','overlay-space','Overlay','draft',?,?)").run(now, now);
  await db.prepare("INSERT INTO automation_workflow_versions (id,workflow_id,version,status,graph_json,validation_json,created_at) VALUES ('overlay-version','overlay-workflow',1,'draft','{}','{}',?)").run(now);
  await db.prepare("INSERT INTO automation_runs (id,workflow_id,workflow_version_id,workspace_id,project_id,user_id,status,admission_key,available_at,created_at,updated_at) VALUES ('overlay-run','overlay-workflow','overlay-version','overlay-space','overlay-project','overlay-owner','running','test',?,?,?)").run(now, now, now);
  const bytes = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#a09080' } }).png().toBuffer();
  const stored = await putStorageObject(bytes, 'overlay-test/source.png', { contentType: 'image/png' });
  await db.prepare("INSERT INTO assets (id,workspace_id,project_id,kind,filename,storage_path,size_bytes,mime_type,created_at) VALUES ('overlay-source','overlay-space','overlay-project','image','source.png',?,?,'image/png',?)").run(stored.reference, stored.size, now);
});
after(closeRelationalPool);
function batch() {
  return { items: [1, 2].map((index) => ({ requestKey: String(index), prompt: 'Create image', referenceAssetIds: [], referenceRoles: [], referenceLabels: [], presentation: { index, role: 'scene', overlayText: `Slide ${index}`, sourceAssetId: 'overlay-source' }, metadata: {}, nodeId: `generated-${index}`, generationId: `generation-${index}`, modelId: 'image-model', aspectRatio: '2:3', resolution: '1K', outputUrl: '/api/assets/overlay-source', assetId: 'overlay-source', creditCost: 10 })), failures: [], model: { id: 'image-model', label: 'Model' }, effectiveSettings: { aspectRatio: '2:3', resolution: '1K', concurrency: 1, attempts: 1 } };
}
function execution(): AutomationNodeExecution {
  return { node: automationNodeSchema.parse({ id: 'overlay', type: 'media.text-overlay', version: 1, name: 'Text overlay', position: {x:0,y:0} }), config: {fontSize:28, transparent:true}, inputs: { assets: batch() }, attempt: 1, outputsByNode: new Map(), context: {runId:'overlay-run',workflowId:'overlay-workflow',workspaceId:'overlay-space',projectId:'overlay-project',userId:'overlay-owner',runtimeInputs:{},policy:DEFAULT_AUTOMATION_WORKFLOW_SETTINGS} };
}

test('overlay matches captions by index, preserves source and billing, and reuses persisted results', async () => {
  const input = execution();
  input.inputs.captions = {slides:[{index:2,overlayText:'Second text'},{index:1,overlayText:'First text'}]};
  const result = await textOverlay(input);
  const output = parseCurrentAutomationGeneratedAssets(result.assets);
  assert.deepEqual(output.items.map(item=>item.presentation.overlayText), ['First text','Second text']);
  assert.deepEqual(output.items.map(item=>item.creditCost), [10,10]);
  assert.ok(output.items.every(item=>item.assetId !== 'overlay-source'));
  assert.equal(result.layers.items.length, 2);
  const original = await db.prepare("SELECT storage_path FROM assets WHERE id='overlay-source'").get() as {storage_path:string};
  assert.equal((await sharp(await readStorageObject(original.storage_path)).metadata()).width, 400);
  const count = await db.prepare("SELECT COUNT(*) AS count FROM assets").get();
  assert.deepEqual(await textOverlay(input), result);
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS count FROM assets").get(), count);
});
test('overlay rejects missing or duplicate captions and foreign assets before writing', async () => {
  const input = execution();
  const before = await db.prepare('SELECT COUNT(*) AS count FROM assets').get();
  input.inputs.captions = {slides:[{index:1,overlayText:'one'}]};
  await assert.rejects(textOverlay(input), /No text supplied/);
  input.inputs.captions = {slides:[{index:1,overlayText:'one'},{index:1,overlayText:'duplicate'}]};
  await assert.rejects(textOverlay(input), /duplicate/);
  delete input.inputs.captions;
  input.context.userId = 'foreign';
  await assert.rejects(textOverlay(input), /not accessible/);
  assert.deepEqual(await db.prepare('SELECT COUNT(*) AS count FROM assets').get(), before);
});
test('disabled overlay and explicitly empty captions pass through original images', async () => {
  const input = execution(); input.config.enabled = false;
  assert.deepEqual((await textOverlay(input)).assets, batch());
  input.config.enabled = true; input.inputs.captions = '';
  assert.deepEqual((await textOverlay(input)).assets, batch());
});
test('overlay is a typed connectable processing node and has a matching handler', () => {
  const definition = automationNodeDefinition('media.text-overlay', 1)!;
  assert.equal(definition.inputs[0].type, 'generated-assets');
  assert.equal(definition.outputs[0].type, 'generated-assets');
  assert.equal(coreAutomationNodeHandlers()['media.text-overlay@1'], textOverlay);
});

test('identical captions on the same source keep distinct slide identities', async () => {
  const input = execution(); input.inputs.captions = 'Shared caption';
  const result = parseCurrentAutomationGeneratedAssets((await textOverlay(input)).assets);
  assert.deepEqual(result.items.map(item=>item.presentation.index), [1,2]);
  assert.notEqual(result.items[0].assetId, result.items[1].assetId);
});
test('preparation v2 keeps exact copy separate from clean-image instructions without mutating approved plans', async () => {
  const input = execution();
  const instruction = 'Render the exact new caption: New words';
  const prompt = {title:'Portrait',task:'Create a home portrait',reference_plan:[{token:'@Source_1',title:'Source',role:'source composition',instruction:'Keep composition'}],subject:{identity:'Person',appearance:[],pose:'Standing',expression:'Calm'},scene:{environment:'Home',composition:'Portrait',lighting:'Daylight',camera:'Phone'},preserve:['Identity'],change:[instruction],avoid:[],output:{format:'photo',style:'natural'}};
  input.inputs = { plans: {schemaVersion:2,contract:null,decisions:null,slides:[{index:1,role:'scene',prompt,referenceAssetIds:[],text:{strategy:'rewrite',sourceText:'Old words',overlayText:'New words',instruction},confidence:1}]}, source: {slides:[{index:1,assetId:'overlay-source'}]} };
  const original = structuredClone(input.inputs);
  const handler = coreAutomationNodeHandlers()['logic.prepare-slideshow-image-requests@2'];
  input.config = {textRendering:'model'};
  const model = (await handler(input)).requests as {requests:Array<{prompt:string,presentation:{overlayText:string}}>};
  assert.deepEqual(JSON.parse(model.requests[0].prompt), prompt);
  input.config.textRendering = 'local-overlay';
  const local = (await handler(input)).requests as typeof model;
  const clean = JSON.parse(local.requests[0].prompt);
  assert.ok(!clean.change.includes(instruction));
  assert.ok(clean.change.some((value:string)=>value.includes('Do not draw replacement letters')));
  assert.equal(local.requests[0].presentation.overlayText, 'New words');
  assert.deepEqual(input.inputs, original);
});
