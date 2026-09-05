import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { assignCanvasNodeNumbers, canvasNodeLabel } from "../collaboration/node-numbers.mjs";
// The production collaboration codec is also exercised against real Yjs state.
// @ts-expect-error Runtime module has no declaration file.
import { readGraph, writeGraph, numberDocumentNodes } from "../collaboration/document-codec.mjs";
import { duplicateGraphSelection, normalizeProjectGraph } from "../src/lib/canvas-graph";
import { patchGraphInYDoc } from "../src/lib/collaboration-document";
import type { FrameNode } from "../src/lib/types";

const node = (id: string, kind: FrameNode["data"]["kind"] = "prompt", mediaType: "image" | "video" = "image", createdAt?: string): FrameNode => ({ id, type: "frameNode", position: { x: 0, y: 0 }, data: { kind, title: "Custom title", mediaType, ...(createdAt ? { createdAt } : {}) } });

test("numbers are per canvas and type, ordered by creation without moving nodes", () => {
  const input = [node("new", "prompt", "image", "2026-02-02"), node("old", "prompt", "image", "2026-02-01"), node("video", "prompt", "video"), node("assistant", "assistant"), node("legacy")];
  const result = assignCanvasNodeNumbers(input);
  assert.deepEqual(result.map(n => n.data.nodeNumber), [2, 1, 1, 1, 3]);
  assert.deepEqual(result.map(n => n.id), input.map(n => n.id));
  assert.equal(canvasNodeLabel(result[0].data), "Image Generator 2");
  assert.equal(canvasNodeLabel(result[2].data), "Video Generator 1");
  assert.equal(result[0].data.title, "Custom title");
  assert.equal(assignCanvasNodeNumbers([node("elsewhere")])[0].data.nodeNumber, 1);
  assert.equal(assignCanvasNodeNumbers(result), result);
});

test("deletion preserves every survivor and creation reuses the smallest free slot", () => {
  const original = assignCanvasNodeNumbers([node("a"), node("b"), node("c"), node("d")]);
  const survivors = original.filter(n => !["a", "c"].includes(n.id));
  const after = assignCanvasNodeNumbers([...survivors, node("e"), node("f")], original);
  assert.deepEqual(after.map(n => n.data.nodeNumber), [2, 4, 1, 3]);
  const reloaded = normalizeProjectGraph(JSON.parse(JSON.stringify({ nodes: after, edges: [] })));
  assert.deepEqual(reloaded.nodes.map(n => n.data.nodeNumber), [2, 4, 1, 3]);
});

test("duplicates and type changes allocate new slots; edits cannot renumber nodes", () => {
  const original = assignCanvasNodeNumbers([node("a"), node("b"), node("v", "prompt", "video")]);
  const duplicate = duplicateGraphSelection(original, [], ["a"], () => "copy").nodes[0];
  assert.equal(duplicate.data.nodeNumber, undefined);
  const after = assignCanvasNodeNumbers([...original, duplicate], original);
  assert.equal(after[3].data.nodeNumber, 3);
  const changed = after.map(n => n.id === "a" ? { ...n, data: { ...n.data, nodeNumber: 99, mediaType: "video" as const } } : n);
  assert.deepEqual(assignCanvasNodeNumbers(changed, after).map(n => n.data.nodeNumber), [2, 2, 1, 3]);
  const renamed = after.map(n => ({ ...n, data: { ...n.data, nodeNumber: 99, title: "Renamed" } }));
  assert.deepEqual(assignCanvasNodeNumbers(renamed, after).map(n => n.data.nodeNumber), [1, 2, 1, 3]);
});

test("backfill repairs duplicate and invalid slots while reserving every valid number", () => {
  const input = [node("a"), node("b"), node("c"), node("d")];
  input[0].data.nodeNumber = 2;
  input[1].data.nodeNumber = 2;
  input[2].data.nodeNumber = -1;
  input[3].data.nodeNumber = 5;
  assert.deepEqual(assignCanvasNodeNumbers(input).map(n => n.data.nodeNumber), [2, 1, 3, 5]);
});

test("Yjs backfill persists numbers, preserves data, and is idempotent", () => {
  const document = new Y.Doc();
  writeGraph(document, { nodes: [node("a"), node("b")], edges: [] });
  assert.equal(numberDocumentNodes(document), true);
  assert.equal(numberDocumentNodes(document), false);
  const reload = new Y.Doc();
  Y.applyUpdate(reload, Y.encodeStateAsUpdate(document));
  assert.deepEqual(readGraph(reload).nodes.map((n: FrameNode) => n.data.nodeNumber), [1, 2]);
  assert.equal(readGraph(reload).nodes[0].data.title, "Custom title");
  document.destroy(); reload.destroy();
});

test("concurrent creations converge on free slots without changing the established node", () => {
  const server = new Y.Doc();
  writeGraph(server, { nodes: assignCanvasNodeNumbers([node("a")]), edges: [] });
  let previous = readGraph(server).nodes;
  const peers = [new Y.Doc(), new Y.Doc()];
  for (const [index, peer] of peers.entries()) {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    const before = readGraph(peer);
    const after = { ...before, nodes: assignCanvasNodeNumbers([...before.nodes, node(`new-${index}`)], before.nodes) };
    patchGraphInYDoc(peer, before, after);
  }
  for (const peer of peers) {
    Y.applyUpdate(server, Y.encodeStateAsUpdate(peer));
    numberDocumentNodes(server, previous);
    previous = readGraph(server).nodes;
  }
  const result = readGraph(server);
  assert.equal(result.nodes.find((n: FrameNode) => n.id === "a").data.nodeNumber, 1);
  assert.deepEqual(result.nodes.map((n: FrameNode) => n.data.nodeNumber).sort(), [1, 2, 3]);
  for (const peer of peers) {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    assert.deepEqual(readGraph(peer), result);
    peer.destroy();
  }
  server.destroy();
});
