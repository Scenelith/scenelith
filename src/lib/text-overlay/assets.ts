import { createHash } from "node:crypto";
import sharp from "sharp";
import { db, userCanAccessAsset, userCanAccessProject } from "@/lib/postgres-db";
import { putStorageObject, readStorageObject, statStorageObject } from "@/lib/storage";
import { assertWorkspaceStorageCapacity } from "@/lib/storage-lifecycle";
import { readTextOverlayDocument } from "./document";
import { renderTextOverlay, type TextOverlaySettings } from "./render";

export class OverlayError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type AssetRow = { id: string; storage_path: string; mime_type: string; size_bytes: number; metadata_json: string };

export async function resolveTextOverlay(userId: string, projectId: string, assetId: string) {
  if (!await userCanAccessProject(userId, projectId)) throw new OverlayError("Canvas not found", 404);
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project) throw new OverlayError("Canvas not found", 404);
  const readAsset = async (id: string) => {
    if (!await userCanAccessAsset(userId, id)) throw new OverlayError("Image not found", 404);
    const row = await db.prepare("SELECT id, storage_path, mime_type, size_bytes, metadata_json FROM assets WHERE id = ?").get(id) as AssetRow | undefined;
    if (!row?.mime_type.startsWith("image/") || row.mime_type === "image/svg+xml") throw new OverlayError("Choose a still image");
    return row;
  };
  const asset = await readAsset(assetId);
  const document = readTextOverlayDocument(asset.id, asset.metadata_json);
  const source = document.sourceAssetId === asset.id ? asset : await readAsset(document.sourceAssetId);
  return { project, source, document };
}

// Bound native image processes per web worker and per account, including previews.
const renderingUsers = new Set<string>();
export async function updateTextOverlay(userId: string, projectId: string, assetId: string, text: string, settings: TextOverlaySettings, mode: "save" | "preview", signal?: AbortSignal) {
  const { project, source } = await resolveTextOverlay(userId, projectId, assetId);
  if (!text.trim()) return { assetId: source.id, url: `/api/assets/${source.id}` };
  if (renderingUsers.has(userId) || renderingUsers.size >= 4) throw new OverlayError("Text renderer is busy. Try again in a moment.", 429);
  renderingUsers.add(userId);
  try {
    const config = { ...settings, transparent: mode === "preview" };
    const key = createHash("sha256").update(JSON.stringify([1, projectId, source.id, text, { ...settings, transparent: false }])).digest("hex");
    const id = `overlay-image-${key}`;
    if (mode === "save" && await db.prepare("SELECT id FROM assets WHERE id = ?").get(id)) return { assetId: id, url: `/api/assets/${id}` };
    if (Number(source.size_bytes) > 32 * 1024 * 1024 || (await statStorageObject(source.storage_path)).size > 32 * 1024 * 1024) throw new OverlayError("Choose an image smaller than 32 MB");
    const rendered = await renderTextOverlay(await readStorageObject(source.storage_path), text, config, signal);
    if (mode === "preview") {
      const [left, top, right, bottom] = rendered.layout.bounds;
      const crop = await sharp(rendered.overlay!).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
      return { url: `data:image/png;base64,${crop.toString("base64")}`, width: rendered.layout.width, height: rendered.layout.height, bounds: rendered.layout.bounds };
    }
    await db.transaction(async () => {
      await assertWorkspaceStorageCapacity(project.workspace_id, 0);
      if (await db.prepare("SELECT id FROM assets WHERE id = ?").get(id)) return;
      await assertWorkspaceStorageCapacity(project.workspace_id, rendered.image.length);
      const filename = `${id}.png`;
      const stored = await putStorageObject(rendered.image, `workspaces/${project.workspace_id}/projects/${projectId}/overlays/${filename}`, { contentType: "image/png" });
      await db.prepare(`INSERT INTO assets
        (id,workspace_id,project_id,kind,role,filename,storage_path,storage_provider,storage_bucket,object_key,size_bytes,content_hash,mime_type,metadata_json,created_at)
        VALUES (?,?,?,'generated_image','generated',?,?,?,?,?,?,?,'image/png',?,?) ON CONFLICT(id) DO NOTHING`).run(
        id, project.workspace_id, projectId, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash,
        JSON.stringify({ textOverlayVersion: 1, sourceAssetId: source.id, text, settings: { ...settings, transparent: false }, layout: rendered.layout }), new Date().toISOString());
    })();
    return { assetId: id, url: `/api/assets/${id}` };
  } finally { renderingUsers.delete(userId); }
}
