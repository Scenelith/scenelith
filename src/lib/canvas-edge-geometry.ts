export type EdgePoint = { x: number; y: number; distance: number };

/** Sample React Flow's cubic once, when its geometry changes, never per frame. */
export function sampleCanvasEdge(path: string): EdgePoint[] {
  if (!/^M[^A-Za-z]*C[^A-Za-z]*$/.test(path)) return [];
  const values = path.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number);
  if (!values || values.length !== 8 || values.some((value) => !Number.isFinite(value))) return [];
  const [x0, y0, x1, y1, x2, y2, x3, y3] = values;
  const length = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  const steps = Math.min(1024, Math.max(8, Math.ceil(length / 10)));
  const points: EdgePoint[] = [];
  let distance = 0;
  for (let index = 0; index <= steps; index++) {
    const t = index / steps, s = 1 - t;
    const x = s ** 3 * x0 + 3 * s ** 2 * t * x1 + 3 * s * t ** 2 * x2 + t ** 3 * x3;
    const y = s ** 3 * y0 + 3 * s ** 2 * t * y1 + 3 * s * t ** 2 * y2 + t ** 3 * y3;
    if (index) distance += Math.hypot(x - points[index - 1].x, y - points[index - 1].y);
    points.push({ x, y, distance });
  }
  return points;
}
