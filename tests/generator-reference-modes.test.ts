import assert from "node:assert/strict";
import test from "node:test";
import { reconcileGeneratorReferenceChanges } from "../src/lib/generator-reference-modes";
import type { FrameEdge, GeneratorInputRole, ProjectGraph } from "../src/lib/types";

const reference = (role: GeneratorInputRole) => ({ assetId: role, url: `/api/assets/${role}`, title: role, role });
const edge = (role: GeneratorInputRole, clipId = "a"): FrameEdge => ({ id: `${clipId}-${role}`, source: role, target: "master", targetHandle: `master:${clipId}:${role}-input`, data: { inputRole: role, masterClipId: clipId } });
function fixture(): ProjectGraph {
  return { nodes: [{ id: "master", position: { x: 0, y: 0 }, data: { kind: "videoMaster", title: "Master", videoMasterClips: ["a", "b"].map(id => ({ id, title: id, origin: "source", role: "scene", duration: 5, prompt: "test", modelId: "seedance-2-5", sourceUrl: "/original.mp4", outputUrl: "/generated.mp4", attachedReferences: [reference("reference-image"), reference("reference-audio")] })) } }], edges: [edge("reference-video"), edge("reference-video", "b")] };
}

test("connecting a strict frame atomically disconnects edges and attachments in that Master scene only", () => {
  const before = fixture();
  const { graph, disconnected } = reconcileGeneratorReferenceChanges(before, { ...before, edges: [...before.edges, edge("start-frame")] });
  assert.equal(disconnected, 3);
  assert.deepEqual(graph.edges.map(e => e.id), ["b-reference-video", "a-start-frame"]);
  assert.deepEqual(graph.nodes[0].data.videoMasterClips?.[0].attachedReferences, []);
  assert.equal(graph.nodes[0].data.videoMasterClips?.[0].sourceUrl, "/original.mp4");
  assert.equal(graph.nodes[0].data.videoMasterClips?.[0].outputUrl, "/generated.mp4");
  assert.deepEqual(graph.nodes[0].data.videoMasterClips?.[1], before.nodes[0].data.videoMasterClips?.[1]);
  assert.equal(before.edges.length, 2);
});

test("connecting a video restores multimodal mode and removes both strict frames", () => {
  const before = fixture();
  before.edges = [edge("start-frame"), edge("end-frame")];
  before.nodes[0].data.videoMasterClips![0].attachedReferences = [reference("start-frame")];
  const next = structuredClone(before);
  next.nodes[0].data.videoMasterClips![0].attachedReferences!.push(reference("reference-video"), reference("reference-image"));
  const { graph, disconnected } = reconcileGeneratorReferenceChanges(before, next);
  assert.equal(disconnected, 3);
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(graph.nodes[0].data.videoMasterClips![0].attachedReferences?.map(r => r.role), ["reference-video", "reference-image"]);
});

test("materialization and metadata updates do not silently reinterpret existing legacy modes", () => {
  const before = fixture();
  before.edges.push(edge("start-frame"));
  const next = structuredClone(before);
  next.edges[0].data!.clipAssetId = "materialized";
  next.nodes[0].data.videoMasterClips![0].attachedReferences![0].thumbnailUrl = "/thumb.png";
  const result = reconcileGeneratorReferenceChanges(before, next);
  assert.equal(result.disconnected, 0);
  assert.deepEqual(result.graph, next);
});

test("the last newly connected mode wins in a batch while compatible frame pairs coexist", () => {
  const before = fixture();
  const result = reconcileGeneratorReferenceChanges(before, { ...before, edges: [...before.edges, edge("start-frame"), edge("end-frame"), { ...edge("reference-image"), id: "new-image" }] });
  assert.deepEqual(result.graph.edges.map(e => e.id), ["a-reference-video", "b-reference-video", "new-image"]);
});

test("ordinary generators use the same rule, without restricting Kling frame plus motion video", () => {
  for (const modelId of ["seedance-2-5", "kling-3-motion", "wan-2-7", "veo-3-1-fast"]) {
    const before: ProjectGraph = { nodes: [{ id: "generator", position: { x: 0, y: 0 }, data: { kind: "prompt", title: "Video", modelId, attachedReferences: [reference("start-frame")] } }], edges: [] };
    const role = modelId === "veo-3-1-fast" ? "reference-image" : "reference-video";
    const next = { ...before, edges: [{ id: "input", source: "source", target: "generator", targetHandle: `${role}-input` }] };
    const result = reconcileGeneratorReferenceChanges(before, next);
    assert.equal(result.disconnected, modelId === "kling-3-motion" ? 0 : 1, modelId);
  }
});

test("legacy image attachments without an explicit role still switch out of frame mode", () => {
  const before: ProjectGraph = { nodes: [{ id: "generator", position: { x: 0, y: 0 }, data: { kind: "prompt", title: "Video", modelId: "seedance-2-5", attachedReferences: [reference("start-frame")] } }], edges: [] };
  const next = structuredClone(before);
  next.nodes[0].data.attachedReferences!.push({ assetId: "identity", title: "Identity", url: "/identity.png" });
  const result = reconcileGeneratorReferenceChanges(before, next);
  assert.equal(result.disconnected, 1);
  assert.deepEqual(result.graph.nodes[0].data.attachedReferences?.map(ref => ref.assetId), ["identity"]);
});
