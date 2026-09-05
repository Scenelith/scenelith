import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { relationalPool, closeRelationalPool } from "../src/lib/relational-db";
import { assignCanvasNodeNumbers } from "../collaboration/node-numbers.mjs";

after(closeRelationalPool);

test("legacy SQL backfill matches runtime slots, preserves graph fields and is idempotent", async () => {
  const client = await relationalPool().connect();
  try {
    await client.query("BEGIN");
    const migration = await readFile(new URL("../database/migrations/core/006_canvas_node_numbers.sql", import.meta.url), "utf8");
    await client.query(migration);
    const graph = { nodes: [
      { id: "late", data: { kind: "prompt", mediaType: "image", title: "Keep me", createdAt: "2026-02-02T00:00:00Z" } },
      { id: "first", data: { kind: "prompt", createdAt: "2026-02-01T00:00:00Z" } },
      { id: "video", data: { kind: "prompt", mediaType: "video" } },
      { id: "kept", data: { kind: "prompt", nodeNumber: 5 } },
      { id: "duplicate", data: { kind: "prompt", nodeNumber: 5 } },
      { id: "note", data: { kind: "note" } },
    ], edges: [{ id: "edge", source: "first", target: "late" }], viewport: { x: 4, y: 9, zoom: 0.6 } };
    const expected = { ...graph, nodes: assignCanvasNodeNumbers(graph.nodes) };
    const first = await client.query("SELECT pg_temp.number_canvas_nodes($1::jsonb) AS graph", [JSON.stringify(graph)]);
    const numbered = JSON.parse(first.rows[0].graph);
    assert.deepEqual(numbered, expected);
    const second = await client.query("SELECT pg_temp.number_canvas_nodes($1::jsonb) AS graph", [JSON.stringify(numbered)]);
    assert.deepEqual(JSON.parse(second.rows[0].graph), expected);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
