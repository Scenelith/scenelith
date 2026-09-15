import assert from "node:assert/strict";
import test from "node:test";
import { placeAutomationCanvasResults } from "../src/lib/automation-workflows/canvas-layout";
import { canvasBoundsOverlap, canvasNodeBounds } from "../src/lib/canvas-node-placement";
import type { FrameNode, FrameNodeData, ProjectGraph } from "../src/lib/types";

const node = (id: string, x = 0, y = 0, data: Partial<FrameNodeData> = {}): FrameNode => ({ id, type: "frameNode", position: { x, y }, data: { kind: "prompt", title: id, aspectRatio: "9:16", ...data } });
const slides = (count: number) => Array.from({ length: count }, (_, i) => node(`slide-${i}`));
const clear = (results: FrameNode[], existing: FrameNode[]) => {
  for (const [i, result] of results.entries()) for (const other of [...existing.filter((n) => !n.hidden), ...results.slice(0, i)]) {
    assert.equal(canvasBoundsOverlap(canvasNodeBounds(result), canvasNodeBounds(other)), false, `${result.id} overlaps ${other.id}`);
  }
};

test("eight portrait slides stay next to the source in three aligned rows, even at y=0", () => {
  const graph: ProjectGraph = { nodes: [node("source", 80, 0, { kind: "source" }), node("distant", -9000, 80000)], edges: [] };
  const outputs = placeAutomationCanvasResults(graph, slides(8), "source", "beside-source");
  assert.equal(outputs[0].position.y, 0);
  assert.ok(outputs[0].position.x > 80 && outputs[0].position.x < 600);
  assert.deepEqual(outputs.slice(0, 3).map((n) => n.position.y), [0, 0, 0]);
  assert.equal(outputs[0].position.x, outputs[3].position.x);
  assert.equal(outputs[0].position.x, outputs[6].position.x);
  clear(outputs, graph.nodes);
});

test("occupied space shifts the entire group nearby without scattering slides or moving originals", () => {
  const graph: ProjectGraph = { nodes: [node("source", 80, 16000, { kind: "source" }), node("occupied", 450, 16000), node("unrelated", 80000, 90000)], edges: [] };
  const original = structuredClone(graph);
  const outputs = placeAutomationCanvasResults(graph, slides(5), "source", "beside-source");
  assert.deepEqual(graph, original);
  assert.ok(outputs[0].position.y >= 16000 && outputs[0].position.y < 18000);
  assert.equal(outputs[0].position.y, outputs[2].position.y);
  assert.equal(outputs[0].position.x, outputs[3].position.x);
  clear(outputs, graph.nodes);
});

test("new row starts below the source's imported slides instead of the bottom of the whole canvas", () => {
  const source = node("source", 80, 16000, { kind: "source" });
  const scene = node("imported", 450, 16000, { kind: "scene", tiktokSourceNodeId: source.id });
  const graph: ProjectGraph = { nodes: [source, scene, node("far", -80000, 80000)], edges: [] };
  const outputs = placeAutomationCanvasResults(graph, slides(2), source.id, "new-row");
  assert.equal(outputs[0].position.x, source.position.x);
  assert.ok(outputs[0].position.y > canvasNodeBounds(scene).y + canvasNodeBounds(scene).height);
  assert.ok(outputs[0].position.y < 18000);
  clear(outputs, graph.nodes);
});

test("mixed ratios and multiple full-plan notes reserve their dimensions across repeated runs", () => {
  const graph: ProjectGraph = { nodes: [node("source", -500, -500, { kind: "source" })], edges: [] };
  const additions = [node("note1", 0, 0, { kind: "note", nodeWidth: 420, nodeHeight: 980 }), node("note2", 0, 0, { kind: "note", nodeWidth: 420, nodeHeight: 980 }), ...slides(7)];
  additions[3].data.aspectRatio = "16:9";
  const first = placeAutomationCanvasResults(graph, additions, "source", "beside-source");
  clear(first, graph.nodes);
  graph.nodes.push(...first);
  const second = placeAutomationCanvasResults(graph, slides(4).map((n) => ({ ...n, id: `next-${n.id}` })), "source", "beside-source");
  clear(second, graph.nodes);
});

test("missing source and dense canvases still find free space; hidden nodes are ignored", () => {
  const existing = Array.from({ length: 300 }, (_, i) => node(`old-${i}`, (i % 15) * 600, Math.floor(i / 15) * 1000));
  existing.push({ ...node("hidden", 0, 50000), hidden: true });
  const graph: ProjectGraph = { nodes: existing, edges: [] };
  clear(placeAutomationCanvasResults(graph, slides(12), "missing", "beside-source"), existing);
  assert.deepEqual(placeAutomationCanvasResults(graph, [], "missing", "beside-source"), []);
});
