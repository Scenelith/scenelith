import { z } from "zod";

export type VideoExportAsset = {
  id: string;
  start: number;
  end: number;
};

// Projects created by older imports and internal QA canvases use stable
// human-readable ids instead of UUIDs. Access is still checked against the
// exact id after parsing, so accepting both formats does not broaden access.
export const videoMasterExportRequestSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
  filename: z.string().trim().min(1).max(120),
  assets: z.array(z.object({
    id: z.string().uuid(),
    start: z.number().finite().min(0),
    end: z.number().finite().positive(),
  }).refine((asset) => asset.end > asset.start, "Invalid video range")).min(1).max(30),
});

export function coalesceContiguousVideoAssets(assets: VideoExportAsset[], tolerance = .03) {
  const result: VideoExportAsset[] = [];
  for (const asset of assets) {
    const normalized = {
      id: asset.id,
      start: Math.max(0, Number(asset.start || 0)),
      end: Math.max(0, Number(asset.end || 0)),
    };
    const previous = result[result.length - 1];
    if (previous
      && previous.id === normalized.id
      && previous.end > previous.start
      && normalized.end > normalized.start
      && Math.abs(previous.end - normalized.start) <= tolerance) {
      previous.end = normalized.end;
      continue;
    }
    result.push(normalized);
  }
  return result;
}
