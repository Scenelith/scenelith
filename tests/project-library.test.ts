import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const assetsRoute = readFileSync(new URL("../src/app/api/assets/route.ts", import.meta.url), "utf8");
const canvasApp = readFileSync(new URL("../src/components/CanvasApp.tsx", import.meta.url), "utf8");
const theme = readFileSync(new URL("../src/app/theme.css", import.meta.url), "utf8");

test("project Library exposes generated and explicitly uploaded assets from canvases the user can access", () => {
  assert.match(assetsRoute, /export async function GET\(request: Request\)/);
  assert.match(assetsRoute, /if \(await userCanAccessProject\(auth\.user\.id, project\.id\)\) accessibleProjects\.push\(project\)/);
  assert.match(assetsRoute, /a\.role = 'generated'/);
  assert.match(assetsRoute, /a\.role = 'library'/);
  assert.match(assetsRoute, /library_image', 'library_video'/);
  assert.match(assetsRoute, /LIBRARY_PAGE_SIZE \+ 1/);
  assert.match(assetsRoute, /variant=thumbnail&delivery=direct/);
});

test("Library uses top-level Media and Identities sections with canvas and media filters", () => {
  assert.match(canvasApp, /data-tooltip="Library"/);
  assert.match(canvasApp, /className="asset-library-tabs"/);
  assert.match(canvasApp, />Media</);
  assert.match(canvasApp, />Identities</);
  assert.match(canvasApp, /className="asset-library-canvas-menu"/);
  assert.match(canvasApp, /Every canvas in this project/);
  assert.match(canvasApp, /\[\['all', 'All'\], \['image', 'Images'\], \['video', 'Videos'\]\]/);
  assert.match(canvasApp, /openLibraryAsset\(asset\)/);
  assert.match(canvasApp, /placeLibraryAsset\(asset\)/);
  assert.match(canvasApp, /assetDownloadUrl\(asset\.url\)/);
});

test("Library uploads media without adding canvas nodes and keeps card actions quiet until hover", () => {
  assert.match(canvasApp, /uploadMediaFiles\(project\.id, "library", libraryUploadFiles/);
  assert.match(canvasApp, /no canvas nodes created/);
  assert.match(assetsRoute, /libraryUpload \? "project_library"/);
  assert.match(assetsRoute, /MAX_LIBRARY_MEDIA_PER_UPLOAD = 20/);
  assert.match(assetsRoute, /ACCEPTED_LIBRARY_IMAGE_TYPES = new Set\(\["image\/jpeg", "image\/jpg", "image\/png"\]\)/);
  assert.match(canvasApp, /className="library-upload-dialog"/);
  assert.match(canvasApp, /Drop images or videos here/);
  assert.match(canvasApp, /JPG, PNG, MP4, MOV or WebM/);
  assert.doesNotMatch(canvasApp, /PROJECT MEDIA/);
  assert.doesNotMatch(canvasApp, /Files stay in Library until you add them to a canvas/);
  assert.match(canvasApp, /LIBRARY_MAX_TOTAL_BYTES = 280 \* 1024 \* 1024/);
  assert.match(canvasApp, /CreateMultipartUploadCommand|\/api\/assets\/uploads/);
  assert.doesNotMatch(canvasApp, /Select references above/);
  assert.match(canvasApp, /className="identity-place-compact"/);
  assert.match(theme, /\.identity-state-panel \{[\s\S]*?align-content: start;[\s\S]*?overflow: hidden;/);
  assert.match(theme, /\.identity-asset-strip \{[\s\S]*?height: 120px;[\s\S]*?max-height: 120px;/);
  assert.match(theme, /\.asset-library-card footer button,[\s\S]*?background: transparent/);
});
