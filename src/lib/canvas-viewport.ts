export type CanvasViewport = { x: number; y: number; zoom: number };
const prefix = "scenelith:canvas-viewport:v1:";

function valid(value: unknown): value is CanvasViewport {
  if (!value || typeof value !== "object") return false;
  const v = value as CanvasViewport;
  return [v.x, v.y, v.zoom].every((n) => typeof n === "number" && Number.isFinite(n)) && v.zoom > 0;
}

/** Absence stays undefined so a first visit can fit nodes; a saved view always wins. */
export function readCanvasViewportSession(projectId: string, fallback?: CanvasViewport): CanvasViewport | undefined {
  try {
    if (typeof window !== "undefined") {
      const value: unknown = JSON.parse(window.sessionStorage.getItem(`${prefix}${projectId}`) || "null");
      if (valid(value)) return value;
    }
  } catch { /* Storage may be disabled. */ }
  return valid(fallback) ? fallback : undefined;
}

export function writeCanvasViewportSession(projectId: string, viewport: CanvasViewport) {
  if (typeof window === "undefined" || !valid(viewport)) return;
  try { window.sessionStorage.setItem(`${prefix}${projectId}`, JSON.stringify(viewport)); } catch { /* Storage may be disabled. */ }
}
