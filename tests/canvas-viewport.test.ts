import assert from "node:assert/strict";
import test from "node:test";
import { readCanvasViewportSession, writeCanvasViewportSession } from "../src/lib/canvas-viewport";

test("reload prefers the saved camera, keeps projects separate and distinguishes a first visit", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } } });
  try {
    const saved = { x: -4200, y: -18000, zoom: .42 };
    const fallback = { x: 0, y: 0, zoom: 1 };
    assert.equal(readCanvasViewportSession("first"), undefined);
    writeCanvasViewportSession("a", saved);
    assert.deepEqual(readCanvasViewportSession("a", fallback), saved);
    assert.equal(readCanvasViewportSession("b"), undefined);
    writeCanvasViewportSession("b", fallback);
    assert.deepEqual(readCanvasViewportSession("a"), saved);
    data.set("scenelith:canvas-viewport:v1:a", '{"x":0,"y":0,"zoom":0}');
    assert.deepEqual(readCanvasViewportSession("a", fallback), fallback);
    data.set("scenelith:canvas-viewport:v1:a", 'null');
    assert.equal(readCanvasViewportSession("a"), undefined);
    data.set("scenelith:canvas-viewport:v1:a", '{bad');
    assert.equal(readCanvasViewportSession("a"), undefined);
    Object.defineProperty(globalThis, "window", { configurable: true, value: { get sessionStorage() { throw new Error("Storage disabled"); } } });
    assert.deepEqual(readCanvasViewportSession("a", fallback), fallback);
    assert.doesNotThrow(() => writeCanvasViewportSession("a", saved));
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
