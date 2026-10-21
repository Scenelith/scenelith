import assert from "node:assert/strict";
import test from "node:test";
import { sampleCanvasEdge } from "../src/lib/canvas-edge-geometry";

test("edge sampling preserves endpoints, direction and continuous dash distance on a backtracking cubic", () => {
  const points = sampleCanvasEdge("M100,30 C900,30 -700,500 300,500");
  assert.deepEqual(points[0], { x: 100, y: 30, distance: 0 });
  assert.equal(points.at(-1)?.x, 300); assert.equal(points.at(-1)?.y, 500);
  assert.ok(points.at(-1)!.distance > Math.hypot(200, 470));
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].distance >= points[i - 1].distance);
    assert.ok(Number.isFinite(points[i].x) && Number.isFinite(points[i].y));
  }
});

test("sampling is bounded for very long connections and rejects unsupported or malformed geometry", () => {
  assert.ok(sampleCanvasEdge("M0,0 C1000000,0 -1000000,0 1000000,20").length <= 1025);
  assert.deepEqual(sampleCanvasEdge("M0,0 L2,3"), []);
  assert.deepEqual(sampleCanvasEdge("M0,0 CNaN,0 20,30 40,50"), []);
  assert.deepEqual(sampleCanvasEdge(""), []);
});
