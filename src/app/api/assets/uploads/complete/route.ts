import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, userCanAccessProject } from "@/lib/postgres-db";
import { probeVideoMetadataUrl } from "@/lib/media-probe";
import { mediaContentMatchesMime } from "@/lib/media-content";
import { abortDirectMultipartUpload, completeDirectMultipartUpload, deleteStorageObject, readStoragePrefix, signedStorageReadUrl } from "@/lib/storage";
import { verifyUploadSession } from "@/lib/upload-session";
import { beginDurableUploadCompletion, completeDurableUploadSession, releaseDurableUploadSession } from "@/lib/storage-lifecycle";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "upload-complete", identity: auth.user.id, limit: 80, windowSeconds: 600 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({})) as { token?: unknown };
  let upload;
  try { upload = verifyUploadSession(String(body.token || "")); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid upload session" }, { status: 400 }); }
  if (upload.userId !== auth.user.id || !await userCanAccessProject(auth.user.id, upload.projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(upload.projectId) as { workspace_id: string } | undefined;
  if (!project || project.workspace_id !== upload.workspaceId) return Response.json({ error: "Canvas changed" }, { status: 409 });

  const existing = await db.prepare("SELECT id, filename, mime_type, metadata_json FROM assets WHERE id = ?").get(upload.assetId) as { id: string; filename: string; mime_type: string; metadata_json: string } | undefined;
  if (existing) return Response.json({ asset: { id: existing.id, url: `/api/assets/${existing.id}`, filename: existing.filename, mimeType: existing.mime_type, ...JSON.parse(existing.metadata_json || "{}") } });
  const durable = await beginDurableUploadCompletion(upload.assetId, auth.user.id);
  if (!durable
    || durable.workspace_id !== upload.workspaceId
    || durable.project_id !== upload.projectId
    || durable.upload_id !== upload.uploadId
    || durable.object_key !== upload.key
    || Number(durable.size_bytes) !== upload.size) {
    return Response.json({ error: "Upload session is no longer available" }, { status: 409 });
  }

  let objectCompleted = false;
  try {
    const stored = await completeDirectMultipartUpload(upload, upload.partCount);
    objectCompleted = true;
    if (stored.size !== upload.size) {
      await deleteStorageObject(upload.reference);
      await releaseDurableUploadSession(upload.assetId, "failed", auth.user.id);
      return Response.json({ error: "Uploaded file size does not match" }, { status: 400 });
    }
    const prefix = await readStoragePrefix(upload.reference);
    if (!mediaContentMatchesMime(prefix, upload.mimeType)) {
      await deleteStorageObject(upload.reference);
      await releaseDurableUploadSession(upload.assetId, "failed", auth.user.id);
      return Response.json({ error: "File content does not match its format" }, { status: 400 });
    }
    const mediaType = upload.mimeType.startsWith("video/") ? "video" : "image";
    const videoMetadata = mediaType === "video"
      ? await signedStorageReadUrl(upload.reference, { expiresIn: 10 * 60 }).then((url) => url ? probeVideoMetadataUrl(url) : {}).catch(() => ({}))
      : {};
    const metadata = { source: upload.purpose === "edit-reference" ? "image_edit" : upload.purpose === "library" ? "project_library" : "canvas_upload", mediaType, originalName: upload.originalName, ...videoMetadata };
    const kind = upload.purpose === "edit-reference" ? "edit_reference" : upload.purpose === "library" ? `library_${mediaType}` : "scene";
    const role = upload.purpose === "edit-reference" ? "edit_reference" : upload.purpose === "library" ? "library" : "canvas_upload";
    await db.transaction(async () => {
      await db.prepare(`INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'r2', ?, ?, ?, NULL, ?, ?, ?)`)
        .run(upload.assetId, upload.workspaceId, upload.projectId, kind, role, upload.filename, upload.reference, upload.bucket, upload.key, upload.size, upload.mimeType, JSON.stringify(metadata), new Date().toISOString());
      await completeDurableUploadSession(upload.assetId, auth.user.id);
    })();
    return Response.json({ asset: { id: upload.assetId, url: `/api/assets/${upload.assetId}`, filename: upload.filename, originalName: upload.originalName, mediaType, mimeType: upload.mimeType, ...videoMetadata } });
  } catch (error) {
    if (objectCompleted) await deleteStorageObject(upload.reference).catch(() => undefined);
    else await abortDirectMultipartUpload(upload).catch(() => undefined);
    await releaseDurableUploadSession(upload.assetId, "failed", auth.user.id).catch(() => undefined);
    console.error("Direct upload finalization failed", error);
    return Response.json({ error: "Could not finish upload" }, { status: 500 });
  }
}
