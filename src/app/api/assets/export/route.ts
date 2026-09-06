import { requireApiUser } from "@/lib/auth";
import { db, userCanAccessAsset, userCanAccessProject } from "@/lib/postgres-db";
import { coalesceContiguousVideoAssets, videoMasterExportRequestSchema } from "@/lib/video-export";
import { renderVideoMasterExport, type VideoMasterRenderSource as ExportSource } from "@/lib/video-master-render";

export const runtime = "nodejs";

type AssetRow = {
  id: string;
  storage_path: string;
  mime_type: string;
};

function safeFilename(value: string) {
  const cleaned = value.replace(/[\r\n"\\/]/g, "-").replace(/\s+/g, " ").trim().replace(/\.mp4$/i, "");
  return `${cleaned || "video-master-export"}.mp4`;
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = videoMasterExportRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose at least one valid video scene" }, { status: 400 });
  if (!await userCanAccessProject(auth.user.id, parsed.data.projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });

  // Keep scene boundaries when replacing audio: each scene has its own source
  // range and must be padded independently when that range is shorter.
  const requestedSources: typeof parsed.data.assets = parsed.data.audioMode === "original"
    ? parsed.data.assets
    : coalesceContiguousVideoAssets(parsed.data.assets);
  const sources: ExportSource[] = [];
  for (const asset of requestedSources) {
    const row = await db.prepare(`
      SELECT id, storage_path, mime_type
      FROM assets
      WHERE id = ?
    `).get(asset.id) as AssetRow | undefined;
    // A Video Master may keep media from another canvas the user can access
    // after connected nodes are moved or copied. Export follows the same
    // per-asset authorization as normal playback instead of requiring the
    // asset's project_id to equal the current canvas id.
    if (!row || !row.mime_type.startsWith("video/") || !await userCanAccessAsset(auth.user.id, row.id)) {
      return Response.json({ error: "One of the video scenes is no longer available" }, { status: 404 });
    }
    let audio: ExportSource["audio"];
    if (parsed.data.audioMode === "original" && asset.audio) {
      const range = asset.audio;
      const original = await db.prepare("SELECT id, storage_path, mime_type FROM assets WHERE id = ?").get(range.id) as AssetRow | undefined;
      if (!original || !original.mime_type.startsWith("video/") || !await userCanAccessAsset(auth.user.id, original.id)) {
        return Response.json({ error: "Original audio is no longer available for one of the scenes" }, { status: 404 });
      }
      audio = { ...original, start: range.start, end: range.end };
    }
    sources.push({ ...row, start: asset.start, end: asset.end, audio });
  }

  const filename = safeFilename(parsed.data.filename);
  try {
    const bytes = await renderVideoMasterExport(sources, filename, parsed.data.audioMode);
    return new Response(bytes, {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("Video Master export failed", { projectId: parsed.data.projectId, assetCount: sources.length, error });
    return Response.json({ error: "Could not render this video export" }, { status: 500 });
  }
}
