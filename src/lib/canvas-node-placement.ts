import type { FrameNode, FrameNodeData, ProjectGraph } from "./types";

export type CanvasBounds = { x: number; y: number; width: number; height: number };
const GAP = 24;
const positive = (value: unknown, fallback: number) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

/** Same aspect-dependent default width as the rendered generator card. */
export function generatorNodeWidth(ratio: number) {
  return ratio >= 1.65 ? 620 : ratio >= 1.2 ? 520 : 430;
}

export function canvasNodeSize(data: FrameNodeData) {
  const [rw, rh] = String(data.aspectRatio || "4:5").split(":").map(Number);
  const ratio = positive(rw / rh, 16 / 9);
  if (data.kind === "prompt") {
    const width = positive(data.nodeWidth, generatorNodeWidth(ratio));
    return { width, height: 36 + width / ratio };
  }
  if (data.kind === "note") return { width: positive(data.nodeWidth, 330), height: positive(data.nodeHeight, 410) };
  if (data.kind === "assistant") {
    const width = positive(data.nodeWidth, 430);
    return { width, height: width + 36 };
  }
  if (data.kind === "videoMaster") {
    const width = Math.max(860, positive(data.nodeWidth, 920));
    // Preview, title, transport, two timeline lanes and footer.
    return { width, height: Math.round(Math.max(430, Math.min(560, width * .58))) + 320 };
  }
  if (data.kind === "source" && data.mediaType === "video" && data.videoSegments?.length) {
    const width = positive(data.nodeWidth, 580);
    return { width, height: width * 9 / 16 + 280 };
  }
  if (data.kind === "scene" || data.kind === "persona") {
    const width = positive(data.nodeWidth, 260);
    // Reserve the initial placeholder too, before the natural media ratio loads.
    const mediaRatio = positive(data.videoAspectRatio, data.aspectRatio ? positive(rw / rh, 9 / 16) : 9 / 16);
    return { width, height: 36 + Math.max(width * 410 / 260, width / mediaRatio) };
  }
  return { width: positive(data.nodeWidth, 260), height: positive(data.nodeHeight, data.kind === "generation" ? 430 : 240) };
}

/** Includes handles, the selected toolbar, and space for result history even before the first run. */
export function canvasNodeBounds(node: FrameNode): CanvasBounds {
  const size = canvasNodeSize(node.data);
  return { x: node.position.x - 16, y: node.position.y - 48, width: size.width + 32, height: size.height + 80 };
}

export function canvasBoundsOverlap(a: CanvasBounds, b: CanvasBounds, gap = GAP) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

/** Search along the requested row and column, jumping over occupied intervals.
 * This preserves alignment and remains bounded even on a dense 500-node canvas. */
export function placeCanvasNode(node: FrameNode, obstacles: FrameNode[]) {
  if (node.hidden) return node.position;
  const bounds = canvasNodeBounds(node);
  const occupied = obstacles.filter((other) => other.id !== node.id && !other.hidden).map(canvasNodeBounds);
  if (!occupied.some((other) => canvasBoundsOverlap(bounds, other))) return node.position;
  const candidates = (["y", "x"] as const).flatMap((axis) => {
    const cross = axis === "x" ? "y" : "x";
    const extent = axis === "x" ? "width" : "height";
    const crossExtent = axis === "x" ? "height" : "width";
    const intervals = occupied.filter((other) => bounds[cross] < other[cross] + other[crossExtent] + GAP
      && bounds[cross] + bounds[crossExtent] + GAP > other[cross])
      .map((other) => ({ start: other[axis] - bounds[extent] - GAP, end: other[axis] + other[extent] + GAP }))
      .sort((a, b) => a.start - b.start);
    return [1, -1].map((direction) => {
      let value = bounds[axis];
      for (const interval of direction === 1 ? intervals : [...intervals].reverse()) {
        if (value > interval.start && value < interval.end) value = direction === 1 ? Math.ceil(interval.end) : Math.floor(interval.start);
      }
      const delta = value - bounds[axis];
      return { position: { ...node.position, [axis]: value + (node.position[axis] - bounds[axis]) }, distance: Math.abs(delta) };
    });
  });
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0].position;
}

/** Only new or resized nodes move. Explicit moves and unrelated edits retain their coordinates. */
export function placeChangedCanvasNodes(previous: ProjectGraph, next: ProjectGraph) {
  const before = new Map(previous.nodes.map((node) => [node.id, node]));
  const needsPlacement = (node: FrameNode) => {
    const old = before.get(node.id);
    if (!old) return true;
    const oldSize = canvasNodeSize(old.data);
    const size = canvasNodeSize(node.data);
    return size.width > oldSize.width || size.height > oldSize.height;
  };
  const occupied = next.nodes.filter((node) => !needsPlacement(node));
  for (const node of next.nodes.filter(needsPlacement)) {
    node.position = placeCanvasNode(node, occupied);
    occupied.push(node);
  }
  return next;
}
