// Bump when older Canvas code can rewrite newer document semantics on sync.
export const CANVAS_CLIENT_VERSION = 2;

export function assertCanvasClientVersion(version) {
  if (version !== CANVAS_CLIENT_VERSION) {
    throw Object.assign(new Error("Canvas was updated. Refresh this page before editing."), {
      code: "CANVAS_CLIENT_OUTDATED", status: 426,
    });
  }
}
