import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultTikTokWorkflowGraph } from "../src/lib/automation-workflows/default-tiktok";
import { previewAutomationPaths } from "../src/lib/automation-workflows/preview";

const edgeId = (source: string, sourcePort: string, target: string, targetPort: string) => `${source}:${sourcePort}->${target}:${targetPort}`;

function preview(input: { identityId?: string; mode?: "concept" | "identity"; newOutfit: boolean; newLocation: boolean; textStrategy: "keep" | "rewrite" | "remove" }) {
  return previewAutomationPaths(createDefaultTikTokWorkflowGraph(), {
    "identity.identity": input.identityId || "",
    "creative-settings.mode": input.mode || "concept",
    "creative-settings.newOutfit": input.newOutfit,
    "creative-settings.newLocation": input.newLocation,
    "creative-settings.textStrategy": input.textStrategy,
  });
}

test("optional identity activates only when a person or character is selected", () => {
  const withoutIdentity = preview({ identityId: "", newOutfit: true, newLocation: true, textStrategy: "rewrite" });
  assert.equal(withoutIdentity.activeNodeIds.has("identity"), false);
  assert.equal(withoutIdentity.activeNodeIds.has("inspect-identity"), false);
  assert.equal(withoutIdentity.activeEdgeIds.has(edgeId("manual-run", "run", "identity", "run")), false);
  assert.equal(withoutIdentity.activeEdgeIds.has(edgeId("identity", "identity", "inspect-identity", "primary")), false);
  assert.equal(withoutIdentity.activeEdgeIds.has(edgeId("identity", "identity", "generate-images", "identity")), false);
  assert.equal(withoutIdentity.activeNodeIds.has("generate-images"), true);

  const withIdentity = preview({ identityId: "persona-1", newOutfit: true, newLocation: true, textStrategy: "rewrite" });
  assert.equal(withIdentity.activeNodeIds.has("identity"), true);
  assert.equal(withIdentity.activeNodeIds.has("inspect-identity"), true);
  assert.equal(withIdentity.activeEdgeIds.has(edgeId("manual-run", "run", "identity", "run")), true);
  assert.equal(withIdentity.activeEdgeIds.has(edgeId("identity", "identity", "inspect-identity", "primary")), true);
  assert.equal(withIdentity.activeEdgeIds.has(edgeId("identity", "identity", "generate-images", "identity")), true);
  assert.equal(withIdentity.activeNodeIds.has("generate-images"), true);
});

test("adaptation mode activates exactly one real workflow route", () => {
  const concept = preview({ mode: "concept", newOutfit: true, newLocation: true, textStrategy: "rewrite" });
  assert.equal(concept.activeNodeIds.has("adaptation-mode-choice"), true);
  assert.equal(concept.activeNodeIds.has("rebuild-concept-mode"), true);
  assert.equal(concept.activeNodeIds.has("keep-concept-mode"), false);
  assert.equal(concept.activeEdgeIds.has(edgeId("adaptation-mode-choice", "yes", "rebuild-concept-mode", "data")), true);
  assert.equal(concept.activeEdgeIds.has(edgeId("adaptation-mode-choice", "no", "keep-concept-mode", "data")), false);

  const identity = preview({ mode: "identity", newOutfit: true, newLocation: true, textStrategy: "rewrite" });
  assert.equal(identity.activeNodeIds.has("adaptation-mode-choice"), true);
  assert.equal(identity.activeNodeIds.has("rebuild-concept-mode"), false);
  assert.equal(identity.activeNodeIds.has("keep-concept-mode"), true);
  assert.equal(identity.activeEdgeIds.has(edgeId("adaptation-mode-choice", "yes", "rebuild-concept-mode", "data")), false);
  assert.equal(identity.activeEdgeIds.has(edgeId("adaptation-mode-choice", "no", "keep-concept-mode", "data")), true);
  assert.equal(identity.activeNodeIds.has("interpret-brief"), true);
});

test("run choices preview the exact wardrobe and location route", () => {
  const change = preview({ newOutfit: true, newLocation: true, textStrategy: "rewrite" });
  assert.equal(change.activeEdgeIds.has(edgeId("wardrobe-choice", "yes", "allow-wardrobe-change", "data")), true);
  assert.equal(change.activeEdgeIds.has(edgeId("wardrobe-choice", "no", "preserve-wardrobe", "data")), false);
  assert.equal(change.activeEdgeIds.has(edgeId("location-choice", "yes", "allow-location-change", "data")), true);
  assert.equal(change.activeEdgeIds.has(edgeId("location-choice", "no", "preserve-location", "data")), false);
  assert.equal(change.activeNodeIds.has("allow-wardrobe-change"), true);
  assert.equal(change.activeNodeIds.has("preserve-wardrobe"), false);
  assert.equal(change.activeNodeIds.has("allow-location-change"), true);
  assert.equal(change.activeNodeIds.has("preserve-location"), false);

  const preserve = preview({ newOutfit: false, newLocation: false, textStrategy: "rewrite" });
  assert.equal(preserve.activeEdgeIds.has(edgeId("wardrobe-choice", "yes", "allow-wardrobe-change", "data")), false);
  assert.equal(preserve.activeEdgeIds.has(edgeId("wardrobe-choice", "no", "preserve-wardrobe", "data")), true);
  assert.equal(preserve.activeEdgeIds.has(edgeId("location-choice", "yes", "allow-location-change", "data")), false);
  assert.equal(preserve.activeEdgeIds.has(edgeId("location-choice", "no", "preserve-location", "data")), true);
  assert.equal(preserve.activeNodeIds.has("allow-wardrobe-change"), false);
  assert.equal(preserve.activeNodeIds.has("preserve-wardrobe"), true);
  assert.equal(preserve.activeNodeIds.has("allow-location-change"), false);
  assert.equal(preserve.activeNodeIds.has("preserve-location"), true);
  assert.equal(preserve.activeNodeIds.has("interpret-brief"), true);
});

test("text handling activates exactly one complete route", () => {
  const rewrite = preview({ newOutfit: true, newLocation: true, textStrategy: "rewrite" });
  for (const nodeId of ["decompose-copy", "rewrite-copy", "review-copy", "select-copy"]) assert.equal(rewrite.activeNodeIds.has(nodeId), true, nodeId);
  for (const nodeId of ["keep-copy", "remove-copy", "text-route-keep"]) assert.equal(rewrite.activeNodeIds.has(nodeId), false, nodeId);

  const keep = preview({ newOutfit: true, newLocation: true, textStrategy: "keep" });
  for (const nodeId of ["text-route-keep", "keep-copy", "select-copy"]) assert.equal(keep.activeNodeIds.has(nodeId), true, nodeId);
  for (const nodeId of ["decompose-copy", "rewrite-copy", "review-copy", "remove-copy"]) assert.equal(keep.activeNodeIds.has(nodeId), false, nodeId);

  const remove = preview({ newOutfit: true, newLocation: true, textStrategy: "remove" });
  for (const nodeId of ["text-route-keep", "remove-copy", "select-copy"]) assert.equal(remove.activeNodeIds.has(nodeId), true, nodeId);
  for (const nodeId of ["decompose-copy", "rewrite-copy", "review-copy", "keep-copy"]) assert.equal(remove.activeNodeIds.has(nodeId), false, nodeId);
});
