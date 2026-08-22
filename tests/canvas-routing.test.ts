import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const canvasPage = readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8");
const canvasApp = readFileSync(new URL("../src/components/CanvasApp.tsx", import.meta.url), "utf8");
const theme = readFileSync(new URL("../src/app/theme.css", import.meta.url), "utf8");
const database = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
const frameNode = readFileSync(new URL("../src/components/FrameNode.tsx", import.meta.url), "utf8");
const projectRoute = readFileSync(new URL("../src/app/api/projects/[id]/route.ts", import.meta.url), "utf8");

test("canvas route restores an explicitly selected accessible project", () => {
  assert.match(canvasPage, /project\?: string/);
  assert.match(canvasPage, /requestedProjectRow = requested\.project/);
  assert.match(canvasPage, /String\(row\.id\) === requested\.project/);
  assert.match(canvasPage, /requestedProjectWorkspaceId/);
});

test("client keeps the selected canvas in the URL without remounting the app", () => {
  assert.match(canvasApp, /url\.searchParams\.set\("project", project\.id\)/);
  assert.match(canvasApp, /window\.history\.replaceState/);
  assert.doesNotMatch(canvasApp, /router\.(?:push|replace)\([^)]*project/);
});

test("canvas switching uses realtime sync without prefetching duplicate full graphs", () => {
  assert.match(canvasApp, /projectCacheRef = useRef\(new Map/);
  assert.match(canvasApp, /projectSessionCachePrefix = "scenelith:canvas-graph:v1:"/);
  assert.match(canvasApp, /readProjectSessionCache\(next\.id, next\.revision\)/);
  assert.match(canvasApp, /writeProjectSessionCache\(body\.project\)/);
  assert.doesNotMatch(canvasApp, /prefetchProject/);
  assert.doesNotMatch(canvasApp, /projectLoadRef/);
  assert.match(canvasApp, /WebSocket sync has not completed/);
  assert.match(canvasApp, /}, 1_200\);/);
  assert.match(canvasApp, /setProject\(cachedTarget \|\| next\)/);
  assert.match(canvasApp, /if \(!cachedTarget\) \{/);
  assert.doesNotMatch(canvasApp, /<strong[^>]+onClick=\{\(event\) => event\.stopPropagation\(\)\}[^>]*>\{item\.name\}<\/strong>/);
  assert.match(canvasApp, /onlyRenderVisibleElements/);
  assert.match(canvasApp, /dirtyProjectIdsRef\.current\.has\(project\.id\)/);
  assert.match(canvasApp, /defaultViewport=\{initialProject\.graph\.viewport/);
  assert.match(canvasApp, /fitView\(\{ nodes: latestNodes\.slice\(0, 4\)/);
  assert.match(canvasApp, /if \(!collaborationReady\) return false/);
  assert.doesNotMatch(canvasApp, /body: JSON\.stringify\(\{ revision: project\.revision, graph:/);
  assert.doesNotMatch(canvasApp, /<div className="project-card-preview">/);
});

test("canvas list summaries never hydrate every full project", () => {
  const listItemBody = database.slice(database.indexOf("export function rowToProjectListItem"), database.indexOf("export async function ensureStarterProject"));
  assert.doesNotMatch(listItemBody, /rowToProject\(row\)/);
  assert.doesNotMatch(listItemBody, /graph_json/);
  assert.match(listItemBody, /parseProjectSummary\(row\.summary_json/);
  assert.match(database, /LEFT JOIN project_snapshots ps ON ps\.project_id = p\.id/);
  assert.match(database, /p\.id, p\.workspace_id, p\.name, p\.source_url, p\.status/);
  assert.doesNotMatch(database, /accessibleProjectRows = db\.prepare\(`SELECT DISTINCT p\.\*/);
});

test("canvas shell switches immediately and cold graphs hydrate through realtime", () => {
  const switchBody = canvasApp.slice(canvasApp.indexOf("async function switchProject"), canvasApp.indexOf("async function switchWorkspace"));
  assert.match(switchBody, /setProject\(cachedTarget \|\| next\)/);
  // A cold shell is cleared through the raw React Flow setter. Publishing that
  // transient empty graph into Yjs would erase the authoritative document.
  assert.match(switchBody, /setNodesState\(\[\]\)/);
  assert.match(switchBody, /setProjectHydratingId\(next\.id\)/);
  assert.match(canvasApp, /className="canvas-loading-dot-field"/);
  assert.match(canvasApp, /className="canvas-project-loading" aria-hidden="true"/);
  assert.doesNotMatch(canvasApp, /Opening \{project\.name\}/);
  assert.doesNotMatch(canvasApp, /projectRestoreDetail/);
  assert.doesNotMatch(canvasApp, /canvas-loading-wave/);
  assert.match(canvasApp, /nodes\.length === 0 && projectHydratingId !== project\.id/);
  assert.match(canvasApp, /projectHydratingIdRef\.current === project\.id/);
});

test("cached canvases remain protected until their live document has synced", () => {
  assert.match(canvasApp, /useState<string \| null>\(initialProject\.id\)/);
  assert.match(canvasApp, /ready: collaborationReady/);
  assert.match(canvasApp, /projectHydratingIdRef\.current = next\.id/);
  const switchBody = canvasApp.slice(canvasApp.indexOf("async function switchProject"), canvasApp.indexOf("async function switchWorkspace"));
  const cachedBody = switchBody.slice(switchBody.indexOf("if (cachedTarget)"), switchBody.indexOf("// The realtime document"));
  assert.doesNotMatch(cachedBody, /setProjectHydratingId\(null\)/);
  assert.match(switchBody, /stays[\s\S]*behind the read-only hydration guard until Yjs confirms/);
  assert.match(canvasApp, /savedGeneratedAt >= taskGeneratedAt/);
});

test("an old client cannot overwrite a versioned canvas graph", () => {
  assert.match(projectRoute, /parsed\.data\.graph && parsed\.data\.revision === undefined/);
  assert.match(projectRoute, /Canvas revision is required/);
  assert.match(projectRoute, /status: 428/);
});

test("canvas media avoids eager full-file downloads during graph hydration", () => {
  assert.match(frameNode, /preload="metadata"/);
  assert.match(frameNode, /preload="none"/);
});

test("Library header actions have no persistent button fills", () => {
  assert.match(theme, /\.library-refresh \{[\s\S]*?background: transparent;/);
  assert.match(theme, /\.library-media-upload \{[\s\S]*?background: transparent;/);
  assert.match(theme, /\.identity-library-actions \.library-add:first-child \{[\s\S]*?background: transparent;/);
});
