import assert from "node:assert/strict";
import { test } from "node:test";
import { automationCanvasReferences } from "../src/lib/automation-workflows/canvas-references";

const request = {
  referenceAssetIds: ["source", "before-2", "before-1"],
  referenceRoles: ["reference-image", "reference-image", "reference-image"],
  referenceLabels: ["source slide", "image2", "image3"],
};
const assets = ["before-1", "before-2", "unused"].map((id) => ({ id, persona_id: "identity", persona_name: "Test identity", role: "before" }));

test("canvas references keep exactly the requested identity images in request order", () => {
  const references = automationCanvasReferences(request, assets, "source");
  assert.deepEqual(references.map((ref) => ref.assetId), ["before-2", "before-1"]);
  assert.equal(references[0].title, "Test identity · before · image2");
  assert.equal(references[0].personaId, "identity");
  assert.equal(references[0].variant, "before");
  assert.equal(references[0].url, "/api/assets/before-2");
  assert.equal(references[0].thumbnailUrl, "/api/assets/before-2?variant=thumbnail");
});

test("without a source connection all references are attached, including unavailable historical assets", () => {
  const references = automationCanvasReferences(request, []);
  assert.deepEqual(references.map((ref) => ref.assetId), request.referenceAssetIds);
  assert.deepEqual(references.map((ref) => ref.title), request.referenceLabels);
  assert.equal(references[1].personaId, undefined);
});

test("a source used in another role remains attached and no extra source image is invented", () => {
  const references = automationCanvasReferences({ ...request, referenceRoles: ["start-frame", "reference-image", "end-frame"] }, assets, "source");
  assert.deepEqual(references.map((ref) => ref.role), ["start-frame", "reference-image", "end-frame"]);
  assert.deepEqual(automationCanvasReferences({ referenceAssetIds: [], referenceRoles: [], referenceLabels: [] }, assets, "source"), []);
});
