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

function videoSourceGraph(): ProjectGraph {
  return {
    nodes: [
      { id: 'source', position: { x: 0, y: 0 }, data: { kind: 'source', title: 'Video', mediaType: 'video', assetId: 'original', videoOutputSelection: 'full', videoSegments: [
        { id: 'one', index: 1, label: 'Scene 01', role: 'hook', confidence: 1, start: 0, end: 3 },
        { id: 'two', index: 2, label: 'Scene 02', role: 'scene', confidence: 1, start: 3, end: 8, clipAssetId: 'clip-two', clipUrl: '/clip-two.mp4' },
      ] } },
      { id: 'generator', position: { x: 500, y: 0 }, data: { kind: 'prompt', title: 'Generator', mediaType: 'video', modelId: 'seedance-2-5' } },
      { id: 'master', position: { x: 500, y: 400 }, data: { kind: 'videoMaster', title: 'Master' } },
    ],
    edges: [
      { id: 'ref', source: 'source', target: 'generator', sourceHandle: 'video-output', targetHandle: 'reference-video-input', data: { portType: 'video', inputRole: 'reference-video' } },
      { id: 'master-ref', source: 'source', target: 'master', sourceHandle: 'segment-output:one', targetHandle: 'master:a:reference-video-input', data: { portType: 'video', inputRole: 'reference-video', masterClipId: 'a', sourceSegmentId: 'one', sourceSegmentStart: 0, sourceSegmentEnd: 3, clipAssetId: 'clip-one' } },
    ],
  };
}

test('changing a connected source selection updates generator range and preserves pinned Master clips', () => {
  const before = videoSourceGraph();
  const next = structuredClone(before);
  next.nodes[0].data.videoOutputSelection = 'two';
  const { graph, disconnected } = reconcileGeneratorReferenceChanges(before, next);
  const ref = graph.edges[0];
  assert.equal(disconnected, 0);
  assert.equal(ref.id, 'ref');
  assert.equal(ref.sourceHandle, 'segment-output:two');
  assert.equal(ref.data?.sourceSegmentStart, 3);
  assert.equal(ref.data?.sourceSegmentEnd, 8);
  assert.equal(ref.data?.clipAssetId, 'clip-two');
  assert.equal(ref.data?.clipUrl, '/clip-two.mp4');
  assert.deepEqual(graph.edges[1], before.edges[1]);
  assert.equal(before.edges[0].data?.sourceSegmentId, undefined);
});

test('Full removes every old trim and prepared-generation asset from the connected reference', () => {
  const before = videoSourceGraph();
  before.nodes[0].data.videoOutputSelection = 'two';
  before.edges[0] = { ...before.edges[0], sourceHandle: 'segment-output:two', data: { ...before.edges[0].data, sourceSegmentId: 'two', sourceSegmentStart: 3, sourceSegmentEnd: 8, clipAssetId: 'clip-two', clipUrl: '/clip-two.mp4', generationClipAssetId: 'old-generation-trim', generationClipUrl: '/old.mp4', generationClipDuration: 5 } };
  const next = structuredClone(before);
  next.nodes[0].data.videoOutputSelection = 'full';
  const { graph } = reconcileGeneratorReferenceChanges(before, next);
  assert.equal(graph.edges[0].sourceHandle, 'video-output');
  for (const field of ['sourceSegmentId', 'sourceSegmentStart', 'sourceSegmentEnd', 'clipAssetId', 'clipUrl', 'generationClipAssetId', 'generationClipUrl', 'generationClipDuration']) assert.equal((graph.edges[0].data as Record<string, unknown>)[field], undefined, field);
  assert.equal(graph.nodes[0].data.assetId, 'original');
  assert.deepEqual(graph.edges[1], before.edges[1]);
});

test('selecting an unprepared scene cannot forward the previous prepared clip, and a read preserves explicit links', () => {
  const before = videoSourceGraph();
  before.nodes[0].data.videoOutputSelection = 'two';
  before.edges[0].data = { ...before.edges[0].data, sourceSegmentId: 'two', clipAssetId: 'clip-two' };
  before.nodes[0].data.videoOutputSelection = undefined;
  assert.deepEqual(reconcileGeneratorReferenceChanges(before, structuredClone(before)).graph.edges, before.edges);
  before.nodes[0].data.videoOutputSelection = 'two';
  const next = structuredClone(before);
  next.nodes[0].data.videoOutputSelection = 'one';
  const ref = reconcileGeneratorReferenceChanges(before, next).graph.edges[0];
  assert.equal(ref.data?.sourceSegmentId, 'one');
  assert.equal(ref.data?.clipAssetId, undefined);
  assert.equal(ref.data?.sourceSegmentStart, 0);
  assert.equal(ref.data?.sourceSegmentEnd, 3);
});
