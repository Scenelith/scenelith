import { requireApiUser } from "@/lib/auth";
import { db, userCanAccessAsset } from "@/lib/postgres-db";
import { ASSET_THUMBNAIL_CACHE_CONTROL, createAssetThumbnailFromStorage, createVideoAssetThumbnailFromStorage } from "@/lib/image-thumbnails";
import { signedStorageReadUrl, statStorageObject, streamStorageObject } from "@/lib/storage";

export const runtime = "nodejs";

const IMMUTABLE_ASSET_CACHE_CONTROL = "private, max-age=31536000, immutable";
const VIDEO_STREAM_CACHE_CONTROL = "private, no-store";
// Direct asset URLs are signed for one hour from a ten-minute signing window.
// Cache the authenticated redirect only inside the browser for five minutes:
// repeated filmstrip cells then share one R2 URL, while the redirect always
// expires well before its signature and is never stored by shared caches.
const DIRECT_REDIRECT_CACHE_CONTROL = "private, max-age=300";

type AssetRow = {
  id: string;
  workspace_id: string;
  persona_id: string | null;
  kind: string;
  filename: string;
  storage_path: string;
  object_key: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  mime_type: string;
  thumbnail_storage_path: string | null;
  thumbnail_size_bytes: number | null;
  thumbnail_content_hash: string | null;
  thumbnail_mime_type: string | null;
};

type ServedAsset = {
  storagePath: string;
  size: number;
  contentHash: string | null;
  mimeType: string;
  filename: string;
  bytes?: Buffer;
  cacheControl: string;
};

const thumbnailJobs = new Map<string, Promise<ServedAsset>>();

function etagForHash(hash: string | null) {
  return hash ? `"${hash}"` : null;
}

function responseHeaders(asset: ServedAsset, download = false) {
  const filename = asset.filename.replace(/[\r\n"\\]/g, "").trim() || "download";
  const encodedFilename = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = new Headers({
    "content-type": asset.mimeType,
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`,
    "cache-control": asset.cacheControl,
  });
  const etag = etagForHash(asset.contentHash);
  if (etag) headers.set("etag", etag);
  return headers;
}

export function parseVideoByteRange(value: string, size: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || !value.startsWith("bytes=") || value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= size) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function originalAsset(row: AssetRow): Promise<ServedAsset> {
  const size = Number(row.size_bytes || 0) || Number((await statStorageObject(row.storage_path)).size || 0);
  return {
    storagePath: row.storage_path,
    size,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    filename: row.filename,
    cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
  };
}

async function assetThumbnail(row: AssetRow): Promise<ServedAsset> {
  if (row.thumbnail_storage_path && row.thumbnail_size_bytes) {
    return {
      storagePath: row.thumbnail_storage_path,
      size: Number(row.thumbnail_size_bytes),
      contentHash: row.thumbnail_content_hash,
      mimeType: row.thumbnail_mime_type || "image/webp",
      filename: `${row.id}.webp`,
      cacheControl: ASSET_THUMBNAIL_CACHE_CONTROL,
    };
  }
  if (!row.mime_type.startsWith("image/") && !row.mime_type.startsWith("video/")) return originalAsset(row);

  const existingJob = thumbnailJobs.get(row.id);
  if (existingJob) return existingJob;
  const job = (async () => {
    const source = {
      id: row.id,
      workspaceId: row.workspace_id,
      personaId: row.persona_id,
      storagePath: row.storage_path,
      objectKey: row.object_key,
    };
    const thumbnail = row.mime_type.startsWith("video/")
      ? await createVideoAssetThumbnailFromStorage(source)
      : await createAssetThumbnailFromStorage(source);
    await db.prepare(`
      UPDATE assets
      SET thumbnail_storage_path = ?, thumbnail_size_bytes = ?, thumbnail_content_hash = ?, thumbnail_mime_type = 'image/webp'
      WHERE id = ?
    `).run(thumbnail.stored.reference, thumbnail.stored.size, thumbnail.stored.contentHash, row.id);
    return {
      storagePath: thumbnail.stored.reference,
      size: thumbnail.stored.size,
      contentHash: thumbnail.stored.contentHash,
      mimeType: "image/webp",
      filename: `${row.id}.webp`,
      bytes: thumbnail.bytes,
      cacheControl: ASSET_THUMBNAIL_CACHE_CONTROL,
    };
  })().finally(() => thumbnailJobs.delete(row.id));
  thumbnailJobs.set(row.id, job);
  return job;
}

async function videoAssetThumbnailAtTime(row: AssetRow, timeSeconds: number): Promise<ServedAsset> {
  const timeMilliseconds = Math.max(0, Math.round(timeSeconds * 1000));
  const jobKey = `${row.id}:frame:${timeMilliseconds}`;
  const existingJob = thumbnailJobs.get(jobKey);
  if (existingJob) return existingJob;
  const job = (async () => {
    const thumbnail = await createVideoAssetThumbnailFromStorage({
      id: `${row.id}-frame-${timeMilliseconds}`,
      workspaceId: row.workspace_id,
      personaId: row.persona_id,
      storagePath: row.storage_path,
      objectKey: row.object_key,
    }, timeMilliseconds / 1000);
    return {
      storagePath: thumbnail.stored.reference,
      size: thumbnail.stored.size,
      contentHash: thumbnail.stored.contentHash,
      mimeType: "image/webp",
      filename: `${row.id}-frame-${timeMilliseconds}.webp`,
      bytes: thumbnail.bytes,
      cacheControl: ASSET_THUMBNAIL_CACHE_CONTROL,
    };
  })().finally(() => thumbnailJobs.delete(jobKey));
  thumbnailJobs.set(jobKey, job);
  return job;
}

export async function GET(request: Request, context: RouteContext<"/api/assets/[id]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const row = await db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | undefined;
  if (!row || !await userCanAccessAsset(auth.user.id, id)) return Response.json({ error: "Asset not found" }, { status: 404 });

  const searchParams = new URL(request.url).searchParams;
  const wantsDownload = searchParams.get("download") === "1";
  const wantsThumbnail = !wantsDownload && searchParams.get("variant") === "thumbnail";
  const requestedThumbnailTime = Number(searchParams.get("time"));
  const wantsTimedVideoThumbnail = wantsThumbnail
    && row.mime_type.startsWith("video/")
    && searchParams.has("time")
    && Number.isFinite(requestedThumbnailTime)
    && requestedThumbnailTime >= 0
    && requestedThumbnailTime <= 3_600;
  const wantsDirectDelivery = wantsDownload || searchParams.get("delivery") === "direct";
  let served: ServedAsset;
  try {
    served = wantsTimedVideoThumbnail
      ? await videoAssetThumbnailAtTime(row, requestedThumbnailTime)
      : wantsThumbnail ? await assetThumbnail(row) : await originalAsset(row);
  } catch (error) {
    if (!wantsThumbnail) return Response.json({ error: "Asset file is missing" }, { status: 404 });
    console.error("Asset thumbnail could not be prepared", { assetId: row.id, error });
    served = { ...(await originalAsset(row)), cacheControl: "private, max-age=60" };
  }

  if (wantsDirectDelivery) {
    try {
      const directUrl = await signedStorageReadUrl(served.storagePath, {
        downloadName: wantsDownload ? served.filename : undefined,
        expiresIn: wantsDownload ? undefined : 60 * 60,
      });
      if (directUrl) return new Response(null, {
        status: 307,
        headers: {
          location: directUrl,
          "cache-control": DIRECT_REDIRECT_CACHE_CONTROL,
          "referrer-policy": "no-referrer",
        },
      });
    } catch (error) {
      console.error("Direct R2 asset delivery could not be prepared", { assetId: row.id, error });
    }
  }

  const headers = responseHeaders(served, wantsDownload);
  const isStreamedVideo = served.mimeType.startsWith("video/") && !wantsDirectDelivery;
  if (isStreamedVideo) {
    // Media elements issue many independent range requests while seeking.
    // Persisting an authenticated 206 as immutable can make Chromium reuse a
    // partial response for another segment after a production deployment.
    headers.set("cache-control", VIDEO_STREAM_CACHE_CONTROL);
    headers.set("accept-ranges", "bytes");
  }
  const etag = headers.get("etag");
  const requestedRange = request.headers.get("range");
  if (!requestedRange && etag && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  if (requestedRange && served.mimeType.startsWith("video/")) {
    const range = parseVideoByteRange(requestedRange, served.size);
    if (!range) {
      headers.set("content-range", `bytes */${served.size}`);
      return new Response(null, { status: 416, headers });
    }
    const { start, end } = range;
    const stream = await streamStorageObject(served.storagePath, { start, end });
    headers.set("content-length", String(end - start + 1));
    headers.set("content-range", `bytes ${start}-${end}/${served.size}`);
    headers.set("accept-ranges", "bytes");
    return new Response(stream, { status: 206, headers });
  }

  headers.set("content-length", String(served.size));
  if (served.bytes) return new Response(Uint8Array.from(served.bytes).buffer, { headers });
  const stream = await streamStorageObject(served.storagePath);
  return new Response(stream, { headers });
}
