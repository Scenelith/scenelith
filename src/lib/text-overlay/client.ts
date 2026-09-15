import type { OverlayAsset, OverlayPreview, TextOverlayDocument } from "./document";
import type { TextOverlaySettings } from "./settings";

async function result<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not update text");
  return body as T;
}

export function getTextOverlay(projectId: string, assetId: string, signal?: AbortSignal) {
  return fetch(`/api/assets/text-overlay?${new URLSearchParams({ projectId, assetId })}`, { signal, cache: "no-store" }).then(result<TextOverlayDocument>);
}

export function saveTextOverlay(projectId: string, assetId: string, text: string, settings: TextOverlaySettings) {
  return fetch("/api/assets/text-overlay", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, assetId, text, settings, mode: "save" }) }).then(result<OverlayAsset>);
}

export function previewTextOverlay(projectId: string, assetId: string, text: string, settings: TextOverlaySettings, signal: AbortSignal) {
  return fetch("/api/assets/text-overlay", { method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ projectId, assetId, text, settings: { ...settings, x: 50, y: 50 }, mode: "preview" }) }).then(result<OverlayPreview>);
}
