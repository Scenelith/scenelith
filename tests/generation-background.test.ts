import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ProjectGraph } from "../src/lib/types";

process.env.STORAGE_PROVIDER = "local";

let db: typeof import("./postgres-test-db")["db"];
let closeRelationalPool: typeof import("./postgres-test-db")["closeRelationalPool"];
let state: typeof import("../src/lib/generation-state");
let database: typeof import("../src/lib/postgres-db");

before(async () => {
  const testDb = await import("./postgres-test-db");
  ({ db, closeRelationalPool } = testDb);
  await testDb.resetTestDatabase();
  database = await import("../src/lib/postgres-db");
  state = await import("../src/lib/generation-state");
});

after(async () => {
  await closeRelationalPool();
});

async function seedGeneration(operation: "generation" | "edit" = "generation") {
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const now = new Date().toISOString();
  const originalAssetId = operation === "edit" ? crypto.randomUUID() : undefined;
  const graph: ProjectGraph = {
    nodes: [{
      id: nodeId,
      type: "frameNode",
      position: { x: 0, y: 0 },
      data: {
        kind: "prompt",
        title: "Background node",
        status: "queued",
        ...(originalAssetId ? {
          outputUrl: `/api/assets/${originalAssetId}`,
          assetId: originalAssetId,
          mediaType: "image" as const,
          editReferencesByAssetId: { [originalAssetId]: [{ assetId: "reference", url: "/reference.png", title: "Reference", origin: "canvas" as const, detail: "Canvas reference" }] },
        } : {}),
      },
    }],
    edges: [],
  };
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Workspace', ?, ?)").run(workspaceId, now, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, 'Canvas', ?, ?, ?)")
    .run(projectId, workspaceId, JSON.stringify(graph), now, now);
  await db.prepare(`INSERT INTO generations
    (id, project_id, usage_workspace_id, node_id, prompt, status, operation, model_id, media_type, credit_cost, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'prompt', 'completed', ?, 'nano-banana-2', 'image', 8, ?, ?)`)
    .run(generationId, projectId, workspaceId, nodeId, operation, now, now);
  return { generationId, projectId, nodeId, originalAssetId };
}

const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("a completed background generation is written into its original saved node", async () => {
  const seeded = await seedGeneration();
  const assetId = await state.persistGenerationOutput(seeded.generationId, tinyPng);
  const row = await db.prepare("SELECT graph_json FROM projects WHERE id = ?").get(seeded.projectId) as { graph_json: string };
  const graph = JSON.parse(row.graph_json) as ProjectGraph;
  const node = graph.nodes.find((item) => item.id === seeded.nodeId)!;
  assert.equal(node.data.status, "ready");
  assert.equal(node.data.assetId, assetId);
  assert.equal(node.data.outputUrl, `/api/assets/${assetId}`);
  assert.deepEqual(node.data.generatedOutputs?.map((item) => item.assetId), [assetId]);
});

test("a completed Video Master generation is written into its exact OUTPUT scene", async () => {
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const clipId = crypto.randomUUID();
  const now = new Date().toISOString();
  const graph: ProjectGraph = {
    nodes: [{
      id: nodeId,
      type: "frameNode",
      position: { x: 0, y: 0 },
      data: {
        kind: "videoMaster",
        title: "Video Master",
        status: "working",
        modelId: "seedance-2-5",
        mediaType: "video",
        duration: "4",
        videoMasterGeneratingClipId: clipId,
        videoMasterClips: [{ id: clipId, title: "Scene 03", role: "scene", origin: "source", duration: 3.042, prompt: "motion" }],
      },
    }],
    edges: [],
  };
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Workspace', ?, ?)").run(workspaceId, now, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, 'Canvas', ?, ?, ?)")
    .run(projectId, workspaceId, JSON.stringify(graph), now, now);
  await db.prepare(`INSERT INTO generations
    (id, project_id, usage_workspace_id, node_id, prompt, status, operation, model_id, media_type, credit_cost, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'prompt', 'completed', 'generation', 'seedance-2-5', 'video', 100, ?, ?)`).run(generationId, projectId, workspaceId, nodeId, now, now);

  const assetId = await state.persistGenerationOutput(generationId, tinyPng);
  const row = await db.prepare("SELECT graph_json FROM projects WHERE id = ?").get(projectId) as { graph_json: string };
  const saved = JSON.parse(row.graph_json) as ProjectGraph;
  const master = saved.nodes.find((item) => item.id === nodeId)!;
  const clip = master.data.videoMasterClips?.[0];
  assert.equal(master.data.outputUrl, undefined);
  assert.equal(master.data.videoMasterGeneratingClipId, undefined);
  assert.equal(master.data.status, "ready");
  assert.equal(clip?.origin, "generated");
  assert.equal(clip?.outputUrl, `/api/assets/${assetId}`);
  assert.equal(clip?.outputAssetId, assetId);
  assert.equal(clip?.generatedDuration, 4);
  assert.deepEqual(clip?.generatedOutputs?.map((item) => item.assetId), [assetId]);
});

test("a Video Master task keeps its OUTPUT target even after foreground state is cleared", async () => {
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const clipId = crypto.randomUUID();
  const now = new Date().toISOString();
  const graph: ProjectGraph = {
    nodes: [{
      id: nodeId,
      type: "frameNode",
      position: { x: 0, y: 0 },
      data: {
        kind: "videoMaster",
        title: "Video Master",
        status: "ready",
        modelId: "seedance-2-5",
        mediaType: "video",
        duration: "4",
        videoMasterClips: [{ id: clipId, title: "Scene 03", role: "scene", origin: "source", duration: 3.042, prompt: "motion" }],
      },
    }],
    edges: [],
  };
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Workspace', ?, ?)").run(workspaceId, now, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, 'Canvas', ?, ?, ?)")
    .run(projectId, workspaceId, JSON.stringify(graph), now, now);
  await db.prepare(`INSERT INTO generations
    (id, project_id, usage_workspace_id, node_id, prompt, status, operation, model_id, media_type, credit_cost, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'prompt', 'completed', 'generation', 'seedance-2-5', 'video', 100, ?, ?)`).run(generationId, projectId, workspaceId, nodeId, now, now);
  await db.prepare(`INSERT INTO generation_dispatch_jobs
    (generation_id, payload_json, status, attempts, available_at, created_at, updated_at)
    VALUES (?, ?, 'dispatched', 1, ?, ?, ?)`).run(generationId, JSON.stringify({ targetClipId: clipId }), now, now, now);

  const assetId = await state.persistGenerationOutput(generationId, tinyPng);
  const row = await db.prepare("SELECT graph_json FROM projects WHERE id = ?").get(projectId) as { graph_json: string };
  const saved = JSON.parse(row.graph_json) as ProjectGraph;
  const clip = saved.nodes[0].data.videoMasterClips?.[0];
  assert.equal(clip?.outputAssetId, assetId);
  assert.equal(clip?.outputUrl, `/api/assets/${assetId}`);
});

test("a background edit keeps the previous version and its edit references", async () => {
  const seeded = await seedGeneration("edit");
  const assetId = await state.persistGenerationOutput(seeded.generationId, tinyPng);
  const row = await db.prepare("SELECT graph_json FROM projects WHERE id = ?").get(seeded.projectId) as { graph_json: string };
  const graph = JSON.parse(row.graph_json) as ProjectGraph;
  const node = graph.nodes.find((item) => item.id === seeded.nodeId)!;
  assert.deepEqual(node.data.generatedOutputs?.map((item) => item.assetId), [seeded.originalAssetId, assetId]);
  assert.equal(node.data.editReferencesByAssetId?.[assetId]?.[0]?.assetId, "reference");
  assert.equal(node.data.subtitle, "Image edited in place");
});

test("replaying a Master variation preserves a newer run and its exact scene target", async () => {
  const seeded = await seedGeneration();
  await database.mutateProjectGraphSnapshot(seeded.projectId, (graph) => {
    graph.nodes[0].data = { kind: "videoMaster", title: "Master", status: "working", videoMasterGeneratingClipId: "b",
      videoMasterClips: ["a", "b"].map((id) => ({ id, title: id, role: "scene", origin: "source", duration: 6, prompt: "Turn" })) };
    return graph;
  });
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO generation_dispatch_jobs
    (generation_id, payload_json, status, attempts, available_at, created_at, updated_at)
    VALUES (?, ?, 'dispatched', 1, ?, ?, ?)`).run(seeded.generationId, JSON.stringify({ targetClipId: "a" }), now, now, now);
  const assetId = await state.persistGenerationOutput(seeded.generationId, tinyPng);
  const first = (await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0].data;
  assert.equal(first.videoMasterClips?.[0].outputAssetId, assetId);
  assert.equal(first.videoMasterClips?.[1].outputUrl, undefined);
  assert.equal(first.status, "working");
  assert.equal(first.videoMasterGeneratingClipId, "b");
  await database.mutateProjectGraphSnapshot(seeded.projectId, (graph) => {
    graph.nodes[0].data.videoMasterGeneratingClipId = "a";
    return graph;
  });
  await state.persistGenerationOutput(seeded.generationId, tinyPng);
  const replayed = (await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0].data;
  assert.equal(replayed.status, "working");
  assert.equal(replayed.videoMasterGeneratingClipId, "a");
  assert.equal(replayed.videoMasterClips?.[0].generatedOutputs?.length, 1);
});

test("project hydration reads the authoritative snapshot instead of reconstructing generations", async () => {
  const seeded = await seedGeneration();
  const firstAssetId = await state.persistGenerationOutput(seeded.generationId, tinyPng);
  const secondGenerationId = crypto.randomUUID();
  const now = new Date(Date.now() + 1000).toISOString();
  await db.prepare(`INSERT INTO generations
    (id, project_id, usage_workspace_id, node_id, prompt, status, operation, model_id, media_type, credit_cost, created_at, updated_at)
    SELECT ?, project_id, usage_workspace_id, node_id, 'prompt 2', 'completed', 'generation', model_id, media_type, credit_cost, ?, ?
    FROM generations WHERE id = ?`).run(secondGenerationId, now, now, seeded.generationId);
  const secondAssetId = await state.persistGenerationOutput(secondGenerationId, tinyPng);
  const saved = await db.prepare("SELECT * FROM projects WHERE id = ?").get(seeded.projectId) as Record<string, unknown>;
  const stripped = JSON.parse(String(saved.graph_json)) as ProjectGraph;
  stripped.nodes[0].data.generatedOutputs = [];
  saved.graph_json = JSON.stringify(stripped);
  const hydrated = await database.rowToProject(saved);
  assert.deepEqual(hydrated.graph.nodes[0].data.generatedOutputs?.map((output) => output.assetId), [firstAssetId, secondAssetId]);
});

test("project snapshots increment revisions and reject a stale whole-graph save", async () => {
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Workspace', ?, ?)").run(workspaceId, now, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, 'Canvas', '{\"nodes\":[],\"edges\":[]}', ?, ?)")
    .run(projectId, workspaceId, now, now);
  const initial = await database.readProjectGraphSnapshot(projectId);
  const nextGraph: ProjectGraph = {
    nodes: [{ id: "scene-1", type: "frameNode", position: { x: 0, y: 0 }, data: { kind: "scene", title: "Scene" } }],
    edges: [],
  };
  const saved = await database.writeProjectGraphSnapshot(projectId, nextGraph, { expectedRevision: initial.revision });
  assert.equal(saved.ok, true);
  assert.equal(saved.snapshot.revision, initial.revision + 1);
  assert.equal(saved.snapshot.summary.scenes, 1);
  const stale = await database.writeProjectGraphSnapshot(projectId, { nodes: [], edges: [] }, { expectedRevision: initial.revision });
  assert.equal(stale.ok, false);
  assert.equal(stale.snapshot.revision, saved.snapshot.revision);
  assert.equal(stale.snapshot.graph.nodes[0]?.id, "scene-1");
  const versions = await db.prepare("SELECT revision, graph_json FROM project_snapshot_versions WHERE project_id = ? ORDER BY revision").all(projectId) as Array<{ revision: number; graph_json: string }>;
  assert.deepEqual(versions.map((version) => version.revision), [saved.snapshot.revision]);
  assert.deepEqual(versions.map((version) => (JSON.parse(version.graph_json) as ProjectGraph).nodes.length), [1]);
});

async function seedLaterAttempt(seeded: Awaited<ReturnType<typeof seedGeneration>>, status = "completed") {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO generations (id, project_id, usage_workspace_id, node_id, prompt, status, operation, model_id, media_type, credit_cost, created_at, updated_at)
    SELECT ?, project_id, usage_workspace_id, node_id, 'next', ?, operation, model_id, media_type, credit_cost, created_at + interval '1 second', updated_at + interval '1 second'
    FROM generations WHERE id = ?`).run(id, status, seeded.generationId);
  return id;
}

test("old failures and late output cannot replace a newer attempt's result or status", async () => {
  const seeded = await seedGeneration();
  await db.prepare("UPDATE generations SET status = 'running' WHERE id = ?").run(seeded.generationId);
  const newer = await seedLaterAttempt(seeded);
  const currentAsset = await state.persistGenerationOutput(newer, tinyPng);
  await state.finalizeGenerationFromWebhook({ generationId: seeded.generationId, status: "failed", error: "Old failure" });
  let node = (await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0];
  assert.equal(node.data.status, "ready"); assert.equal(node.data.generationError, undefined);
  assert.equal(node.data.assetId, currentAsset);
  const olderAsset = await state.persistGenerationOutput(seeded.generationId, tinyPng);
  node = (await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0];
  assert.equal(node.data.assetId, currentAsset); assert.equal(node.data.status, "ready");
  assert.ok(node.data.generatedOutputs?.some((item) => item.assetId === olderAsset));
});

test("replaying saved success repairs stale error without selecting a different variation or calling provider", async () => {
  const seeded = await seedGeneration();
  await state.persistGenerationOutput(seeded.generationId, tinyPng);
  await database.mutateProjectGraphSnapshot(seeded.projectId, (graph) => {
    graph.nodes[0].data = { ...graph.nodes[0].data, status: "failed", generationError: "Stale", generationAttemptCreatedAt: undefined, generatedAt: new Date(Date.now() + 15000).toISOString(), outputUrl: "/selected-older.png", activeGeneratedOutputIndex: 0 };
    return graph;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Saved success must not query an expiring provider"); };
  try { await state.reconcileGeneration(seeded.generationId); } finally { globalThis.fetch = originalFetch; }
  const node = (await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0];
  assert.equal(node.data.status, "ready"); assert.equal(node.data.generationError, undefined);
  assert.equal(node.data.outputUrl, "/selected-older.png");
  await state.finalizeGenerationFromWebhook({ generationId: seeded.generationId, status: "failed", error: "Delayed failure" });
  assert.equal((await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0].data.status, "ready");
});

test("an old expired unsaved result cannot manufacture a node failure when timeout was refused", async () => {
  const seeded = await seedGeneration();
  await db.prepare("UPDATE generations SET created_at = ?, updated_at = ?, provider_task_id = 'expired-test', status = 'success', output_url = ? WHERE id = ?")
    .run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", "https://expired.test/image.png", seeded.generationId);
  const newer = await seedLaterAttempt(seeded);
  await state.persistGenerationOutput(newer, tinyPng);
  const before = (await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0];
  const originalFetch = globalThis.fetch, oldKey = process.env.KIE_API_KEY;
  process.env.KIE_API_KEY = "test-key";
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://api.kie.ai/")) return Response.json({ code: 200, data: { state: "success", resultUrls: ["https://expired.test/image.png"] } });
    return new Response("expired", { status: 403 });
  };
  try { await state.reconcileGeneration(seeded.generationId); } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = oldKey;
  }
  assert.ok(calls.includes("https://expired.test/image.png"));
  assert.deepEqual((await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0], before);
});

test("the newest genuine failure remains visible and old success cannot clear it", async () => {
  const seeded = await seedGeneration();
  await state.persistGenerationOutput(seeded.generationId, tinyPng);
  const newer = await seedLaterAttempt(seeded, "running");
  await state.finalizeGenerationFromWebhook({ generationId: newer, status: "failed", error: "Current failure" });
  let node = (await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0];
  assert.equal(node.data.status, "failed"); assert.equal(node.data.generationError, "Current failure");
  await state.reconcileGeneration(seeded.generationId);
  node = (await database.readProjectGraphSnapshot(seeded.projectId)).graph.nodes[0];
  assert.equal(node.data.status, "failed"); assert.equal(node.data.generationError, "Current failure");
});
