import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, userCanAccessProject } from "@/lib/postgres-db";
import { probeVideoMetadata } from "@/lib/media-probe";
import { mediaContentMatchesMime } from "@/lib/media-content";
import { deleteStorageObject, safeExtension, saveBytes } from "@/lib/storage";
import { assertWorkspaceStorageCapacity } from "@/lib/storage-lifecycle";
import type { LibraryMediaAsset } from "@/lib/types";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);
const ACCEPTED_LIBRARY_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);
const ACCEPTED_EDIT_REFERENCE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);
const ACCEPTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);
const MAX_CANVAS_MEDIA_PER_UPLOAD = 12;
const MAX_LIBRARY_MEDIA_PER_UPLOAD = 20;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_TOTAL_BYTES = 280 * 1024 * 1024;
const LIBRARY_PAGE_SIZE = 72;

type GeneratedAssetRow = {
  id: string;
  project_id: string;
  canvas_name: string;
  filename: string;
  mime_type: string;
  metadata_json: string;
  created_at: string;
  model_id: string | null;
  role: string;
};

function readLibraryMetadata(value: string) {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const searchParams = new URL(request.url).searchParams;
  const workspaceId = String(searchParams.get("workspaceId") || "");
  const requestedProjectId = String(searchParams.get("projectId") || "");
  const requestedMediaType = String(searchParams.get("mediaType") || "all");
  const search = String(searchParams.get("search") || "").trim().toLowerCase().slice(0, 120);
  const cursor = String(searchParams.get("cursor") || "");
  if (!workspaceId) return Response.json({ error: "Project is required" }, { status: 400 });
  if (!new Set(["all", "image", "video"]).has(requestedMediaType)) return Response.json({ error: "Invalid media filter" }, { status: 400 });

  const projectRows = await db.prepare("SELECT id, name FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId) as Array<{ id: string; name: string }>;
  const accessibleProjects = [];
  for (const project of projectRows) {
    if (await userCanAccessProject(auth.user.id, project.id)) accessibleProjects.push(project);
  }
  if (!accessibleProjects.length) return Response.json({ error: "Project not found" }, { status: 404 });
  if (requestedProjectId && !accessibleProjects.some((project) => project.id === requestedProjectId)) {
    return Response.json({ error: "Canvas not found" }, { status: 404 });
  }

  const projectIds = requestedProjectId ? [requestedProjectId] : accessibleProjects.map((project) => project.id);
  const projectPlaceholders = projectIds.map(() => "?").join(",");
  const baseConditions = [
    `a.project_id IN (${projectPlaceholders})`,
    "((a.role = 'generated' AND a.kind IN ('generated_image', 'generated_video')) OR (a.role = 'library' AND a.kind IN ('library_image', 'library_video')))",
  ];
  const baseValues: Array<string> = [...projectIds];
  if (search) {
    baseConditions.push("(lower(a.filename) LIKE ? OR lower(p.name) LIKE ? OR lower(COALESCE(a.metadata_json ->> 'originalName', '')) LIKE ?)");
    baseValues.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const countRows = await db.prepare(`SELECT CASE WHEN a.mime_type LIKE 'video/%' THEN 'video' ELSE 'image' END AS media_type, COUNT(*) AS count
    FROM assets a
    JOIN projects p ON p.id = a.project_id
    WHERE ${baseConditions.join(" AND ")}
    GROUP BY media_type`).all(...baseValues) as Array<{ media_type: "image" | "video"; count: number }>;
  const imageCount = Number(countRows.find((row) => row.media_type === "image")?.count || 0);
  const videoCount = Number(countRows.find((row) => row.media_type === "video")?.count || 0);

  const conditions = [...baseConditions];
  const values: Array<string | number> = [...baseValues];
  if (requestedMediaType !== "all") {
    conditions.push(requestedMediaType === "video" ? "a.mime_type LIKE 'video/%'" : "a.mime_type LIKE 'image/%'");
  }
  if (cursor) {
    const separator = cursor.lastIndexOf("|");
    const cursorDate = separator > 0 ? cursor.slice(0, separator) : "";
    const cursorId = separator > 0 ? cursor.slice(separator + 1) : "";
    if (cursorDate && cursorId) {
      conditions.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
      values.push(cursorDate, cursorDate, cursorId);
    }
  }

  const rows = await db.prepare(`SELECT a.id, a.project_id, p.name AS canvas_name, a.filename, a.mime_type, a.metadata_json, a.created_at, a.role,
      (SELECT g.model_id FROM generations g WHERE g.output_asset_id = a.id ORDER BY g.created_at DESC LIMIT 1) AS model_id
    FROM assets a
    JOIN projects p ON p.id = a.project_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?`).all(...values, LIBRARY_PAGE_SIZE + 1) as GeneratedAssetRow[];
  const hasMore = rows.length > LIBRARY_PAGE_SIZE;
  const visibleRows = rows.slice(0, LIBRARY_PAGE_SIZE);
  const assets: LibraryMediaAsset[] = visibleRows.map((row) => {
    const metadata = readLibraryMetadata(row.metadata_json);
    const numberFromMetadata = (key: string) => {
      const value = Number(metadata[key]);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    return {
      id: row.id,
      projectId: row.project_id,
      canvasName: row.canvas_name,
      filename: row.filename,
      originalName: typeof metadata.originalName === "string" ? metadata.originalName : undefined,
      source: row.role === "library" ? "uploaded" : "generated",
      mediaType: row.mime_type.startsWith("video/") ? "video" : "image",
      mimeType: row.mime_type,
      url: `/api/assets/${row.id}`,
      thumbnailUrl: `/api/assets/${row.id}?variant=thumbnail&delivery=direct&v=2`,
      createdAt: row.created_at,
      modelId: row.model_id || (typeof metadata.modelId === "string" ? metadata.modelId : undefined),
      durationSeconds: numberFromMetadata("durationSeconds") || numberFromMetadata("duration"),
      width: numberFromMetadata("width"),
      height: numberFromMetadata("height"),
      aspectRatio: numberFromMetadata("aspectRatio"),
    };
  });
  const last = visibleRows.at(-1);
  return Response.json({
    assets,
    counts: { all: imageCount + videoCount, image: imageCount, video: videoCount },
    nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null,
  });
}

function normalizedUploadMimeType(file: File) {
  const declared = file.type.toLowerCase();
  if (ACCEPTED_IMAGE_TYPES.has(declared) || ACCEPTED_VIDEO_TYPES.has(declared)) return declared;
  const name = file.name.toLowerCase();
  if (/\.jpe?g$/.test(name)) return "image/jpeg";
  if (/\.png$/.test(name)) return "image/png";
  if (/\.webm$/.test(name)) return "video/webm";
  if (/\.(mov)$/.test(name)) return "video/quicktime";
  if (/\.(mp4|m4v)$/.test(name)) return "video/mp4";
  return declared;
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "upload-proxy", identity: auth.user.id, limit: 20, windowSeconds: 600 });
  if (limited) return limited;

  const form = await request.formData();
  const projectId = String(form.get("projectId") || "");
  const editReferenceUpload = String(form.get("purpose") || "") === "edit-reference";
  const libraryUpload = String(form.get("purpose") || "") === "library";
  const media = [...form.getAll("files"), ...form.getAll("images")]
    .filter((value): value is File => value instanceof File && value.size > 0);

  if (!projectId || !media.length) {
    return Response.json({ error: "Choose at least one image or video" }, { status: 400 });
  }
  if (!await userCanAccessProject(auth.user.id, projectId)) {
    return Response.json({ error: "Canvas not found" }, { status: 404 });
  }
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project?.workspace_id) return Response.json({ error: "Canvas has no workspace" }, { status: 409 });
  const maxMediaPerUpload = libraryUpload ? MAX_LIBRARY_MEDIA_PER_UPLOAD : MAX_CANVAS_MEDIA_PER_UPLOAD;
  if (media.length > maxMediaPerUpload) {
    return Response.json({ error: `Add up to ${maxMediaPerUpload} files at once` }, { status: 400 });
  }
  const uploads = media.map((file) => ({ file, mimeType: normalizedUploadMimeType(file) }));
  const acceptsFile = (mimeType: string) => editReferenceUpload
    ? ACCEPTED_EDIT_REFERENCE_TYPES.has(mimeType)
    : libraryUpload
      ? ACCEPTED_LIBRARY_IMAGE_TYPES.has(mimeType) || ACCEPTED_VIDEO_TYPES.has(mimeType)
      : ACCEPTED_IMAGE_TYPES.has(mimeType) || ACCEPTED_VIDEO_TYPES.has(mimeType);
  if (uploads.some((upload) => !acceptsFile(upload.mimeType))) {
    return Response.json({ error: editReferenceUpload ? "Upload JPG or PNG images" : "Add JPG, PNG, MP4, MOV or WebM files" }, { status: 400 });
  }
  if (uploads.some(({ file, mimeType }) => mimeType.startsWith("image/") && file.size > MAX_IMAGE_BYTES)) {
    return Response.json({ error: "Each image must be smaller than 25 MB" }, { status: 400 });
  }
  if (uploads.some(({ file, mimeType }) => mimeType.startsWith("video/") && file.size > MAX_VIDEO_BYTES)) {
    return Response.json({ error: "Each video must be smaller than 250 MB" }, { status: 400 });
  }
  if (media.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
    return Response.json({ error: "These files are too large to upload together" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const assets: Array<{ id: string; url: string; filename: string; originalName: string; mediaType: "image" | "video"; mimeType: string; durationSeconds?: number; width?: number; height?: number; aspectRatio?: number }> = [];

  for (const [index, upload] of uploads.entries()) {
    const { file, mimeType } = upload;
    const id = crypto.randomUUID();
    const mediaType = mimeType.startsWith("video/") ? "video" : "image";
    const extension = safeExtension(file.name, mimeType);
    const filename = `${editReferenceUpload ? "edit-reference" : libraryUpload ? `library-${mediaType}` : `canvas-${mediaType}`}-${Date.now()}-${String(index + 1).padStart(2, "0")}${extension}`;
    const bytes = await file.arrayBuffer();
    if (!mediaContentMatchesMime(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 64)), mimeType)) {
      return Response.json({ error: `File ${file.name || index + 1} does not match its format` }, { status: 400 });
    }
    const videoMetadata: { durationSeconds?: number; width?: number; height?: number; aspectRatio?: number } = mediaType === "video"
      ? await probeVideoMetadata(bytes, extension).catch(() => ({}))
      : {};
    const { durationSeconds, width, height, aspectRatio } = videoMetadata;
    const stored = await saveBytes(bytes, `workspaces/${project.workspace_id}/projects/${projectId}/${editReferenceUpload ? "edit-references" : libraryUpload ? "library" : "canvas-uploads"}`, filename, mimeType);
    try {
      await db.transaction(async () => {
        await assertWorkspaceStorageCapacity(project.workspace_id, stored.size);
        await db.prepare(
          `INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, project.workspace_id, projectId, editReferenceUpload ? "edit_reference" : libraryUpload ? `library_${mediaType}` : "scene", editReferenceUpload ? "edit_reference" : libraryUpload ? "library" : "canvas_upload", filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash, mimeType, JSON.stringify({ source: editReferenceUpload ? "image_edit" : libraryUpload ? "project_library" : "canvas_upload", mediaType, originalName: file.name || null, durationSeconds, width, height, aspectRatio }), now);
      })();
    } catch (error) {
      await deleteStorageObject(stored.reference).catch(() => undefined);
      if (error instanceof Error && error.message.includes("quota")) return Response.json({ error: error.message }, { status: 413 });
      throw error;
    }
    assets.push({ id, url: `/api/assets/${id}`, filename, originalName: file.name || filename, mediaType, mimeType, durationSeconds, width, height, aspectRatio });
  }

  return Response.json({ assets });
}
