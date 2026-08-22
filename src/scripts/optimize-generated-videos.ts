import { dirname, extname, join } from "node:path";
import { closeRelationalPool } from "../lib/relational-db";
import { db } from "../lib/postgres-db";
import { mp4HasFastStart, optimizeMp4ForStreaming } from "../lib/media-probe";
import { enqueueStorageDeletion } from "../lib/storage-lifecycle";
import { putStorageObject, readStorageObject } from "../lib/storage";

type VideoAsset = {
  id: string;
  workspace_id: string;
  storage_path: string;
  storage_bucket: string | null;
  object_key: string | null;
  metadata_json: string;
};

async function main() {
  const assets = await db.prepare(`SELECT id, workspace_id, storage_path, storage_bucket, object_key, metadata_json
    FROM assets WHERE kind = 'generated_video' AND mime_type = 'video/mp4' ORDER BY created_at`).all() as VideoAsset[];
  let optimized = 0;
  let skipped = 0;
  for (const asset of assets) {
    const input = await readStorageObject(asset.storage_path);
    if (mp4HasFastStart(input)) {
      skipped += 1;
      continue;
    }
    if (!asset.object_key) throw new Error(`Generated video ${asset.id} has no object key`);
    const extension = extname(asset.object_key) || ".mp4";
    const stem = asset.object_key.slice(0, -extension.length);
    const nextKey = join(dirname(asset.object_key), `${stem.slice(stem.lastIndexOf("/") + 1)}.faststart.mp4`);
    const output = await optimizeMp4ForStreaming(input);
    const stored = await putStorageObject(output, nextKey, { bucket: asset.storage_bucket || "private", contentType: "video/mp4" });
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(asset.metadata_json || "{}"); } catch {}
    const now = new Date().toISOString();
    const updated = await db.prepare(`UPDATE assets SET storage_path = ?, storage_provider = ?, storage_bucket = ?, object_key = ?,
      size_bytes = ?, content_hash = ?, metadata_json = ? WHERE id = ? AND storage_path = ?`).run(
        stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash,
        JSON.stringify({ ...metadata, fastStart: true, streamingOptimizedAt: now }), asset.id, asset.storage_path,
      );
    if (updated.changes !== 1) {
      await enqueueStorageDeletion(stored.reference, asset.workspace_id, "unused-video-faststart");
      throw new Error(`Generated video ${asset.id} changed during optimization`);
    }
    await enqueueStorageDeletion(asset.storage_path, asset.workspace_id, "video-faststart-replaced");
    optimized += 1;
    console.info(JSON.stringify({ assetId: asset.id, optimized: true, size: stored.size }));
  }
  console.info(JSON.stringify({ ok: true, total: assets.length, optimized, skipped }));
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => closeRelationalPool());
