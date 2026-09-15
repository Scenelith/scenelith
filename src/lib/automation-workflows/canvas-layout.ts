import { canvasNodeBounds, type CanvasBounds } from "../canvas-node-placement";
import type { FrameNode, ProjectGraph } from "../types";

const GAP = 48;
const SOURCE_GAP = 72;
const MAX_COLUMNS = 3;

function union(bounds: CanvasBounds[]): CanvasBounds {
  const x = Math.min(...bounds.map((b) => b.x));
  const y = Math.min(...bounds.map((b) => b.y));
  return { x, y, width: Math.max(...bounds.map((b) => b.x + b.width)) - x, height: Math.max(...bounds.map((b) => b.y + b.height)) - y };
}

/** Find a nearby empty rectangle, keeping the entire slideshow together.
 * Only obstacle boundaries need checking: never scan canvas pixels or move existing nodes. */
function freeBlock(block: CanvasBounds, occupied: CanvasBounds[]) {
  const rows = [...new Set([block.y, ...occupied.map((b) => b.y + b.height + GAP).filter((y) => y >= block.y)])].sort((a, b) => a - b);
  let best = { x: block.x, y: block.y, distance: Infinity };
  for (const y of rows) {
    if (y - block.y > best.distance) break;
    const intervals = occupied.filter((b) => y < b.y + b.height + GAP && y + block.height + GAP > b.y)
      .map((b) => ({ start: b.x - block.width - GAP, end: b.x + b.width + GAP }))
      .sort((a, b) => a.start - b.start);
    for (const direction of [1, -1]) {
      let x = block.x;
      for (const interval of direction === 1 ? intervals : [...intervals].reverse()) {
        if (x > interval.start && x < interval.end) x = direction === 1 ? interval.end : interval.start;
      }
      const distance = Math.hypot(x - block.x, y - block.y);
      if (distance < best.distance) best = { x, y, distance };
    }
  }
  return best;
}

/** Place new results in reading order, up to three slides per row, beside their source.
 * Notes get a separate column. Row heights follow the actual aspect ratios. */
export function placeAutomationCanvasResults(graph: ProjectGraph, additions: FrameNode[], sourceNodeId: string, layout: "beside-source" | "new-row") {
  if (!additions.length) return additions;
  const occupied = graph.nodes.filter((n) => !n.hidden);
  const source = occupied.find((n) => n.id === sourceNodeId);
  const sourceBounds = source ? canvasNodeBounds(source) : null;
  const scenes = new Set(graph.edges.filter((e) => e.source === sourceNodeId).map((e) => e.target));
  const sourceBranch = source ? occupied.filter((n) => n.id === sourceNodeId || (n.data.kind === "scene" && (scenes.has(n.id) || n.data.tiktokSourceNodeId === sourceNodeId))) : occupied;
  const below = sourceBranch.length ? Math.max(...sourceBranch.map((n) => { const b = canvasNodeBounds(n); return b.y + b.height; })) + SOURCE_GAP : 0;
  const anchor = sourceBounds && layout === "beside-source"
    ? { x: sourceBounds.x + sourceBounds.width + SOURCE_GAP, y: sourceBounds.y }
    : { x: sourceBounds?.x ?? (occupied.length ? Math.min(...occupied.map((n) => n.position.x)) : 0), y: below };
  const notes = additions.filter((n) => n.data.kind === "note");
  const slides = additions.filter((n) => n.data.kind !== "note");
  const noteWidth = notes.length ? Math.max(...notes.map((n) => canvasNodeBounds(n).width)) + GAP : 0;
  const columnWidth = slides.length ? Math.max(...slides.map((n) => canvasNodeBounds(n).width)) + GAP : 0;
  const positioned = new Map<string, FrameNode>();
  const put = (node: FrameNode, x: number, y: number) => {
    const b = canvasNodeBounds(node);
    positioned.set(node.id, { ...node, position: { x: x + node.position.x - b.x, y: y + node.position.y - b.y } });
  };
  let noteY = 0;
  for (const note of notes) { put(note, 0, noteY); noteY += canvasNodeBounds(note).height + GAP; }
  let rowY = 0;
  for (let offset = 0; offset < slides.length; offset += MAX_COLUMNS) {
    const row = slides.slice(offset, offset + MAX_COLUMNS);
    row.forEach((slide, column) => put(slide, noteWidth + column * columnWidth, rowY));
    rowY += Math.max(...row.map((n) => canvasNodeBounds(n).height)) + GAP;
  }
  const relative = additions.map((n) => positioned.get(n.id)!);
  const bounds = union(relative.map(canvasNodeBounds));
  const origin = freeBlock({ ...bounds, ...anchor }, occupied.map(canvasNodeBounds));
  return relative.map((n) => ({ ...n, position: { x: n.position.x + origin.x, y: n.position.y + origin.y } }));
}
