import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../src/app/api/personas/route.ts", import.meta.url), "utf8");

test("identity asset inserts provide exactly one value per database column", () => {
  const statement = route.match(/INSERT INTO assets \(([^)]+)\)\s*VALUES \(([^)]+)\)/s);
  assert.ok(statement, "identity asset insert was not found");

  const columns = statement[1].split(",").map((value) => value.trim());
  const values = statement[2].split(",").map((value) => value.trim());

  assert.equal(values.length, columns.length);
  assert.equal(values.filter((value) => value === "?").length, 18);
});

test("identity uploads verify image bytes and bounded sizes before storage", () => {
  assert.match(route, /mediaContentMatchesMime/);
  assert.match(route, /MAX_PERSONA_IMAGE_BYTES/);
  assert.match(route, /MAX_PERSONA_BATCH_BYTES/);
});

test("identity endpoints resolve the async collection before serializing it", () => {
  assert.doesNotMatch(route, /personas:\s*listPersonas\(/);
  assert.equal(route.match(/personas:\s*await listPersonas\(/g)?.length, 8);
});

test("generated images are copied into identities without moving the canvas asset", () => {
  assert.match(route, /userCanAccessAsset\(auth\.user\.id, sourceAssetId\)/);
  assert.match(route, /readStorageObject\(source\.storage_path\)/);
  assert.match(route, /sourceAssetId \? \{ sourceAssetId \} : \{\}/);
  assert.match(route, /metadata_json->>'sourceAssetId'/);
  assert.match(route, /identity\.generated_reference_added/);
  assert.doesNotMatch(route, /UPDATE assets SET persona_id/);
});

test("identity responses expose generated-image lineage for already-added UI", () => {
  assert.match(route, /SELECT id, filename, role, sort_order, metadata_json FROM assets/);
  assert.match(route, /typeof metadata\.sourceAssetId === "string"/);
  assert.match(route, /sourceAssetId \? \{ sourceAssetId \} : \{\}/);
});

test("a generated image can create an identity without a browser re-upload", () => {
  assert.match(route, /Identity could not be created from generated image/);
  assert.match(route, /storePersonaFiles\(workspaceId, id, \[\{ file, role: role as/);
  assert.match(route, /metadata: \{ referenceCount: 1, sourceAssetId, role \}/);
  assert.match(route, /personaId: id/);
});
