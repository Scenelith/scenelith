import { z } from "zod";
import { textOverlaySettingsSchema, type TextOverlaySettings } from "./settings";

export type TextOverlayDocument = {
  sourceAssetId: string;
  text: string;
  settings: TextOverlaySettings;
};

const documentSchema = z.object({
  sourceAssetId: z.string().min(1).max(200),
  text: z.string().max(2_000),
  settings: textOverlaySettingsSchema,
});

// Automation assets already persisted this document before the canvas editor existed.
export function readTextOverlayDocument(assetId: string, metadataJson: string): TextOverlayDocument {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(metadataJson || "{}"); } catch { /* An ordinary image has no layer. */ }
  const parsed = documentSchema.safeParse(metadata);
  if (parsed.success && (metadata.textOverlayVersion === 1 || assetId.startsWith("overlay-image-"))) return parsed.data;
  return { sourceAssetId: assetId, text: "", settings: textOverlaySettingsSchema.parse({}) };
}

export type OverlayAsset = { assetId: string; url: string };
export type OverlayPreview = { url: string; width: number; height: number; bounds: number[] };

export function clampOverlayPosition(settings: TextOverlaySettings, preview: OverlayPreview): TextOverlaySettings {
  const [left, top, right, bottom] = preview.bounds;
  // Preview is rendered at 50%,50%. Preserve its actual bounding-box offset.
  const minX = (preview.width / 2 - left + 1) / preview.width * 100;
  const maxX = (preview.width * 1.5 - right - 1) / preview.width * 100;
  const minY = (preview.height / 2 - top + 1) / preview.height * 100;
  const maxY = (preview.height * 1.5 - bottom - 1) / preview.height * 100;
  return { ...settings, x: Math.max(minX, Math.min(maxX, settings.x)), y: Math.max(minY, Math.min(maxY, settings.y)) };
}
