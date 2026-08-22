import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { patchGraphInYDoc, readGraphFromYDoc, writeGraphToYDoc } from "../src/lib/collaboration-document";
import type { FrameNode, ProjectGraph } from "../src/lib/types";

function node(id: string, title: string, x = 0): FrameNode {
  return { id, type: "frameNode", position: { x, y: 0 }, data: { kind: "note", title, createdAt: "2026-01-01T00:00:00.000Z" } };
}

test("collaboration document stores nodes as independently addressable Yjs maps", () => {
  const document = new Y.Doc();
  const graph: ProjectGraph = { nodes: [node("a", "One"), node("b", "Two", 200)], edges: [] };
  writeGraphToYDoc(document, graph);
  assert.equal(document.getMap("nodes").size, 2);
  assert.ok(document.getMap("nodes").get("a") instanceof Y.Map);
  assert.deepEqual(readGraphFromYDoc(document), graph);
});

test("field-level mutations merge concurrent edits to the same node", () => {
  const seed = new Y.Doc();
  writeGraphToYDoc(seed, { nodes: [node("a", "One"), node("b", "Two", 200)], edges: [] });
  const first = new Y.Doc();
  const second = new Y.Doc();
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  Y.applyUpdate(first, seedUpdate);
  Y.applyUpdate(second, seedUpdate);

  const firstGraph = readGraphFromYDoc(first);
  const firstNext = structuredClone(firstGraph);
  firstNext.nodes[0] = { ...firstNext.nodes[0], position: { x: 50, y: 25 } };
  patchGraphInYDoc(first, firstGraph, firstNext);
  const secondGraph = readGraphFromYDoc(second);
  const secondNext = structuredClone(secondGraph);
  secondNext.nodes[0] = { ...secondNext.nodes[0], data: { ...secondNext.nodes[0].data, title: "Changed" } };
  patchGraphInYDoc(second, secondGraph, secondNext);

  Y.applyUpdate(first, Y.encodeStateAsUpdate(second, Y.encodeStateVector(first)));
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first, Y.encodeStateVector(second)));
  const merged = readGraphFromYDoc(first);
  assert.deepEqual(merged.nodes.find((item) => item.id === "a")?.position, { x: 50, y: 25 });
  assert.equal(merged.nodes.find((item) => item.id === "a")?.data.title, "Changed");
  assert.equal(merged.nodes.length, 2);
});

test("a stale local mutation does not delete a node added remotely", () => {
  const seed = new Y.Doc();
  writeGraphToYDoc(seed, { nodes: [node("a", "One")], edges: [] });
  const first = new Y.Doc();
  const second = new Y.Doc();
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  Y.applyUpdate(first, seedUpdate);
  Y.applyUpdate(second, seedUpdate);

  const firstBefore = readGraphFromYDoc(first);
  const firstAfter = structuredClone(firstBefore);
  firstAfter.nodes[0] = { ...firstAfter.nodes[0], data: { ...firstAfter.nodes[0].data, subtitle: "Local detail" } };
  patchGraphInYDoc(first, firstBefore, firstAfter);

  const secondBefore = readGraphFromYDoc(second);
  const secondAfter = { ...secondBefore, nodes: [...secondBefore.nodes, node("remote", "Remote", 300)] };
  patchGraphInYDoc(second, secondBefore, secondAfter);

  Y.applyUpdate(first, Y.encodeStateAsUpdate(second, Y.encodeStateVector(first)));
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first, Y.encodeStateVector(second)));
  const merged = readGraphFromYDoc(first);
  assert.equal(merged.nodes.find((item) => item.id === "a")?.data.subtitle, "Local detail");
  assert.equal(merged.nodes.find((item) => item.id === "remote")?.data.title, "Remote");
  assert.equal(merged.nodes.length, 2);
});
