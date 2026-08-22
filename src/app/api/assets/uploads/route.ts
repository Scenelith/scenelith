import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, userCanAccessProject } from "@/lib/postgres-db";
import { abortDirectMultipartUpload, createDirectMultipartUpload, safeExtension, signedDirectUploadPartUrls, storageProvider } from "@/lib/storage";
import { signUploadSession, type UploadPurpose } from "@/lib/upload-session";
import { reserveDurableUploadSessions } from "@/lib/storage-lifecycle";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";

const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_TOTAL_BYTES = 280 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;

type RequestedFile = { name?: unknown; type?: unknown; size?: unknown };

function normalizedMime(file: RequestedFile) {
  const type = String(file.type || "").toLowerCase();
  if (IMAGE_TYPES.has(type) || VIDEO_TYPES.has(type)) return type === "image/jpg" ? "image/jpeg" : type;
  const name = String(file.name || "").toLowerCase();
  if (/\.jpe?g$/.test(name)) return "image/jpeg";
  if (/\.png$/.test(name)) return "image/png";
  if (/\.webm$/.test(name)) return "video/webm";
  if (/\.mov$/.test(name)) return "video/quicktime";
  if (/\.(mp4|m4v)$/.test(name)) return "video/mp4";
  return "";
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "upload-prepare", identity: auth.user.id, limit: 30, windowSeconds: 600 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({})) as { projectId?: unknown; purpose?: unknown; files?: unknown };
  const projectId = String(body.projectId || "");
  const purpose = String(body.purpose || "canvas") as UploadPurpose;
  const files = Array.isArray(body.files) ? body.files.slice(0, 21) as RequestedFile[] : [];
  if (!projectId || !files.length) return Response.json({ error: "Choose at least one image or video" }, { status: 400 });
  if (!new Set<UploadPurpose>(["library", "canvas", "edit-reference"]).has(purpose)) return Response.json({ error: "Invalid upload purpose" }, { status: 400 });
  if (!await userCanAccessProject(auth.user.id, projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project?.workspace_id) return Response.json({ error: "Canvas has no workspace" }, { status: 409 });
  const limit = purpose === "library" ? 20 : 12;
  if (files.length > limit) return Response.json({ error: `Add up to ${limit} files at once` }, { status: 400 });
  if (storageProvider() === "local") return Response.json({ mode: "proxy" });

  const normalized = files.map((file) => ({
    name: String(file.name || "upload").slice(0, 240),
    size: Number(file.size),
    mimeType: normalizedMime(file),
  }));
  if (normalized.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0)) return Response.json({ error: "Invalid file size" }, { status: 400 });
  if (normalized.some((file) => !file.mimeType || (purpose === "edit-reference" && !IMAGE_TYPES.has(file.mimeType)))) {
    return Response.json({ error: purpose === "edit-reference" ? "Upload JPG or PNG images" : "Add JPG, PNG, MP4, MOV or WebM files" }, { status: 400 });
  }
  if (normalized.some((file) => file.mimeType.startsWith("image/") && file.size > MAX_IMAGE_BYTES)) return Response.json({ error: "Each image must be smaller than 25 MB" }, { status: 400 });
  if (normalized.some((file) => file.mimeType.startsWith("video/") && file.size > MAX_VIDEO_BYTES)) return Response.json({ error: "Each video must be smaller than 250 MB" }, { status: 400 });
  if (normalized.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) return Response.json({ error: "These files are too large to upload together" }, { status: 400 });

  const created: Array<ReturnType<typeof createDirectMultipartUpload> extends Promise<infer T> ? T : never> = [];
  try {
    const uploads: Array<{ assetId: string; payload: Parameters<typeof signUploadSession>[0]; partSize: number; parts: Array<{ partNumber: number; url: string }> }> = [];
    const durableSessions: Parameters<typeof reserveDurableUploadSessions>[0] = [];
    for (const [index, file] of normalized.entries()) {
      const assetId = crypto.randomUUID();
      const mediaType = file.mimeType.startsWith("video/") ? "video" : "image";
      const extension = safeExtension(file.name, file.mimeType);
      const filename = `${purpose === "edit-reference" ? "edit-reference" : purpose === "library" ? `library-${mediaType}` : `canvas-${mediaType}`}-${Date.now()}-${String(index + 1).padStart(2, "0")}${extension}`;
      const group = purpose === "edit-reference" ? "edit-references" : purpose === "library" ? "library" : "canvas-uploads";
      const direct = await createDirectMultipartUpload(`workspaces/${project.workspace_id}/projects/${projectId}/${group}/${assetId}-${filename}`, { contentType: file.mimeType });
      created.push(direct);
      const partCount = Math.ceil(file.size / PART_SIZE);
      const parts = await signedDirectUploadPartUrls(direct, partCount);
      const expiresAt = Date.now() + 20 * 60 * 1000;
      const payload = { ...direct, assetId, userId: auth.user.id, projectId, workspaceId: project.workspace_id, purpose, filename, originalName: file.name, mimeType: file.mimeType, size: file.size, partSize: PART_SIZE, partCount, expiresAt };
      durableSessions.push({ id: assetId, workspaceId: project.workspace_id, projectId, userId: auth.user.id, purpose, bucket: direct.bucket, key: direct.key, reference: direct.reference, uploadId: direct.uploadId, filename, originalName: file.name, mimeType: file.mimeType, size: file.size, partSize: PART_SIZE, partCount, expiresAt });
      uploads.push({
        assetId,
        payload,
        partSize: PART_SIZE,
        parts,
      });
    }
    const signedUploads = uploads.map(({ payload, ...upload }) => ({ ...upload, token: signUploadSession(payload) }));
    await reserveDurableUploadSessions(durableSessions);
    return Response.json({ mode: "direct", uploads: signedUploads });
  } catch (error) {
    await Promise.allSettled(created.map((upload) => abortDirectMultipartUpload(upload)));
    const message = error instanceof Error ? error.message : "Could not prepare storage upload";
    if (message.includes("quota")) return Response.json({ error: message }, { status: 413 });
    console.error("Direct upload preparation failed", error);
    return Response.json({ error: "Could not prepare storage upload" }, { status: 500 });
  }
}
