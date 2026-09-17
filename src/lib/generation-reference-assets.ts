import { db, userCanAccessAsset } from "./postgres-db";

export type GenerationReferenceAsset = {
  storage_path: string; mime_type: string; kind: string; role: string | null;
  metadata_json: string | null; size_bytes?: number;
};

export async function loadGenerationReferenceAssets(userId: string, assetIds: string[]) {
  const assets = await Promise.all(assetIds.map(async (id) => {
    if (!await userCanAccessAsset(userId, id)) return null;
    return await db.prepare("SELECT storage_path, mime_type, kind, role, metadata_json, size_bytes FROM assets WHERE id = ?")
      .get(id) as GenerationReferenceAsset | undefined;
  }));
  const unavailableAssetIds = assetIds.filter((_, index) => !assets[index]);
  if (unavailableAssetIds.length) return { ok: false as const, unavailableAssetIds };
  return { ok: true as const, assets: assets as GenerationReferenceAsset[] };
}
