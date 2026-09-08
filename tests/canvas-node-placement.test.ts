import assert from "node:assert/strict";
import test from "node:test";
import { canvasBoundsOverlap, canvasNodeBounds, canvasNodeSize, placeCanvasNode, placeChangedCanvasNodes } from "../src/lib/canvas-node-placement";
import type { FrameNode, FrameNodeData, ProjectGraph } from "../src/lib/types";

const node = (id: string, x = 0, y = 0, data: Partial<FrameNodeData> = {}): FrameNode => ({ id, type: "frameNode", position: { x, y }, data: { kind: "prompt", title: id, aspectRatio: "1:1", ...data } });
const clear = (nodes: FrameNode[]) => {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    assert.equal(canvasBoundsOverlap(canvasNodeBounds(nodes[i]), canvasNodeBounds(nodes[j])), false, `${nodes[i].id} overlaps ${nodes[j].id}`);
  }
};

test("vertical generators reserve their full height, titles and future result history", () => {
  assert.deepEqual(canvasNodeSize(node("p", 0, 0, { aspectRatio: "9:16" }).data), { width: 430, height: 36 + 430 * 16 / 9 });
  assert.equal(canvasNodeSize(node("l", 0, 0, { aspectRatio: "16:9" }).data).width, 620);
  const first = node("first", 100, 100);
  const second = node("second", 100, 530);
  second.position = placeCanvasNode(second, [first]);
  assert.equal(second.position.x, first.position.x);
  assert.ok(second.position.y > 530);
  clear([first, second]);
});

test("free coordinates remain exact and hidden nodes do not occupy space", () => {
  const requested = node("new", -733.5, 928.25);
  assert.deepEqual(placeCanvasNode(requested, [node("old")]), requested.position);
  assert.deepEqual(placeCanvasNode(requested, [{ ...node("hidden", -733.5, 928.25), hidden: true }]), requested.position);
});

test("a batch uses final dimensions and places each node against earlier additions", () => {
  const previous: ProjectGraph = { nodes: [node("existing")], edges: [] };
  const next = placeChangedCanvasNodes(previous, { nodes: [...structuredClone(previous.nodes), ...Array.from({ length: 16 }, (_, i) => node(`new-${i}`, 0, i * 430, { aspectRatio: "9:16" }))], edges: [] });
  assert.deepEqual(next.nodes[0], previous.nodes[0]);
  clear(next.nodes);
});

test("resizing moves only the enlarged node and ordinary edits do not tidy existing overlaps", () => {
  const previous: ProjectGraph = { nodes: [node("first"), node("second", 0, 600)], edges: [] };
  const next = structuredClone(previous);
  next.nodes[0].data.aspectRatio = "9:16";
  placeChangedCanvasNodes(previous, next);
  clear(next.nodes);
  assert.deepEqual(next.nodes[1], previous.nodes[1]);
  const moved = structuredClone(previous);
  moved.nodes[1].position = { x: 0, y: 0 };
  moved.nodes[0].data.prompt = "New prompt";
  assert.deepEqual(placeChangedCanvasNodes(previous, structuredClone(moved)), moved);
});

test("mixed dense canvases find bounded free positions without moving obstacles", () => {
  const nodes: FrameNode[] = [];
  for (let i = 0; i < 150; i++) {
    const candidate = node(String(i), (i * 137 % 1400) - 700, (i * 193 % 1800) - 900,
      i % 5 === 0 ? { kind: "videoMaster" } : i % 3 === 0 ? { kind: "note", nodeWidth: 360, nodeHeight: 800 } : { aspectRatio: i % 2 ? "9:16" : "16:9" });
    candidate.position = placeCanvasNode(candidate, nodes);
    nodes.push(candidate);
  }
  clear(nodes);
});
