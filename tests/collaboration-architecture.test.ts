import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = source("collaboration/server.mjs");
const store = source("src/lib/collaboration-store.ts");
const canvasPage = source("src/app/canvas/page.tsx");
const projectRoute = source("src/app/api/projects/[id]/route.ts");
const tokenRoute = source("src/app/api/collaboration/token/route.ts");
const compose = source("deploy/compose/runtime.yaml");

test("database projection hydrates the shell without opening a live Yjs document", () => {
  assert.match(server, /const projectionMatch = url\.pathname\.match/);
  assert.match(server, /encodeStateVectorFromUpdate/);
  assert.match(server, /SELECT state, graph, revision, updated_at FROM collaboration_documents/);
  assert.doesNotMatch(store, /readCollaborative(?:Projection|ProjectIndex)/);
  assert.doesNotMatch(canvasPage, /readCollaborative(?:Projection|ProjectIndex)/);
  assert.doesNotMatch(projectRoute, /readCollaborative(?:Projection|ProjectIndex)/);
  assert.match(canvasPage, /rowToProject\(initialProjectRow\)/);
  assert.match(projectRoute, /readProjectGraphSnapshot/);
});

test("long-running canvas actions commit through the current synced document", () => {
  const hook = source("src/lib/use-canvas-collaboration.ts");
  const canvas = source("src/components/CanvasApp.tsx");
  assert.match(hook, /const syncedProjectIdRef = useRef/);
  assert.match(hook, /syncedProjectIdRef\.current = input\.projectId/);
  assert.match(hook, /syncedProjectIdRef\.current !== input\.projectId/);
  assert.match(canvas, /const mutateCollaborativeGraphRef = useRef\(mutateCollaborativeGraph\)/);
  assert.match(canvas, /const commitGraph = useCallback/);
  assert.match(canvas, /commitGraph\(selectGraphNode\(\[\.\.\.currentNodes, \.\.\.importedNodes\], focusedImportedNode\.id\), \[\.\.\.currentEdges, \.\.\.sourceEdges\]\)/);
});

test("collaboration schema is versioned by a one-shot migration service", () => {
  assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS collaboration_documents/);
  assert.match(server, /assertCollaborationMigrationsCurrent/);
  assert.match(compose, /collaboration-migrate:/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(source("collaboration/migration-runner.mjs"), /pg_advisory_lock/);
  assert.match(source("collaboration/migration-runner.mjs"), /Applied collaboration migration changed/);
  assert.match(source("collaboration/migration-runner.mjs"), /Collaboration migration is not expand-only/);
});

test("deleted canvases are tombstoned and cannot be recreated by a stale realtime replica", () => {
  const server = source("collaboration/server.mjs");
  const applicationDeletion = source("database/baselines/core-v1.sql");
  const tombstones = source("collaboration/migrations/004_document_tombstones.sql");
  const projectRoute = source("src/app/api/projects/[id]/route.ts");
  assert.match(tombstones, /collaboration_document_tombstones/);
  assert.match(server, /WHERE NOT EXISTS \(SELECT 1 FROM collaboration_document_tombstones/);
  assert.match(server, /request\.method === "DELETE"/);
  assert.match(applicationDeletion, /projects_retire_collaboration_document/);
  assert.match(projectRoute, /workspaceRoleForUser/);
  assert.match(projectRoute, /deleteCollaborativeGraph/);
});

test("realtime authorization is enforced after authentication", () => {
  assert.match(tokenRoute, /const permission = role === "owner" \|\| role === "member" \? "write" : "read"/);
  assert.match(server, /connectionConfig\.readOnly = context\.permission !== "write"/);
  assert.match(server, /context\?\.permission !== "write"/);
  assert.match(server, /beforeHandleAwareness/);
  assert.match(server, /Canvas access changed/);
  assert.match(tokenRoute, /userCanAccessProject/);
});

test("collaboration resource growth and shutdown are bounded", () => {
  assert.match(server, /COLLABORATION_MAX_UPDATE_BYTES/);
  assert.match(server, /Canvas update rate exceeded/);
  assert.match(server, /pruneCollaborationHistory/);
  assert.match(server, /compactCollaborationDocument/);
  assert.match(server, /update_bytes_since_checkpoint/);
  assert.match(server, /documentEpoch/);
  assert.match(tokenRoute, /documentEpoch/);
  assert.match(source("src/lib/use-canvas-collaboration.ts"), /refreshed\.documentEpoch !== session\.documentEpoch/);
  assert.match(server, /candidate\.version_kind = 'automatic'/);
  assert.match(server, /server\.destroy/);
  assert.match(server, /pool\.end/);
});

test("durable queue leases are fenced by a live role-specific worker", () => {
  const generation = source("src/lib/generation-dispatch.ts");
  const automation = source("src/lib/tiktok-automation-jobs.ts");
  const worker = source("src/worker.ts");
  assert.match(generation, /locked_by = \? AND attempts = \?/);
  assert.match(generation, /NOT EXISTS \([\s\S]*worker_heartbeats/);
  assert.match(generation, /if \(leaseFailed\) await \(await usageAuthority\(\)\)\.releaseGeneration/);
  assert.match(automation, /worker\.worker_id = job\.worker_id AND worker\.last_seen_at >= \?/);
  assert.match(automation, /worker_id = \? AND attempts = \? AND locked_at < \?/);
  assert.match(worker, /workerIdentity\("generation"\)/);
  assert.match(worker, /workerIdentity\("automation"\)/);
});
