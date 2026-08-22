import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { putStorageObject, readStorageObject, type StoredObject } from "@/lib/storage";

export const ASSET_THUMBNAIL_SIZE = 1600;
export const ASSET_THUMBNAIL_CACHE_CONTROL = "private, max-age=31536000, immutable";
export const IDENTITY_THUMBNAIL_SIZE = ASSET_THUMBNAIL_SIZE;
export const IDENTITY_THUMBNAIL_CACHE_CONTROL = ASSET_THUMBNAIL_CACHE_CONTROL;

type ThumbnailSource = {
  id: string;
  workspaceId: string;
  personaId?: string | null;
  storagePath: string;
  objectKey?: string | null;
};

export function assetThumbnailKey(source: ThumbnailSource) {
  if (source.objectKey) return join(dirname(source.objectKey), "thumbnails", `${source.id}.webp`);
  if (source.personaId) return join("workspaces", source.workspaceId, "personas", source.personaId, "thumbnails", `${source.id}.webp`);
  return join("workspaces", source.workspaceId, "assets", "thumbnails", `${source.id}.webp`);
}

export const identityThumbnailKey = assetThumbnailKey;

export async function createAssetThumbnail(bytes: ArrayBuffer | Uint8Array, source: ThumbnailSource): Promise<{ stored: StoredObject; bytes: Buffer }> {
  const thumbnail = await sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({
      width: ASSET_THUMBNAIL_SIZE,
      height: ASSET_THUMBNAIL_SIZE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90, effort: 4, smartSubsample: true })
    .toBuffer();

  const stored = await putStorageObject(thumbnail, assetThumbnailKey(source), {
    contentType: "image/webp",
    cacheControl: ASSET_THUMBNAIL_CACHE_CONTROL,
  });
  return { stored, bytes: thumbnail };
}

export const createIdentityThumbnail = createAssetThumbnail;

export async function createAssetThumbnailFromStorage(source: ThumbnailSource) {
  return createAssetThumbnail(await readStorageObject(source.storagePath), source);
}

function runProcess(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => (errorText += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(errorText.slice(-1600) || `${command} exited with ${code}`)));
  });
}

export async function createVideoAssetThumbnailFromStorage(source: ThumbnailSource, timeSeconds = .05) {
  const directory = await mkdtemp(join(tmpdir(), "scenelith-video-thumbnail-"));
  const inputPath = join(directory, "source-video");
  const framePath = join(directory, "frame.jpg");
  try {
    await writeFile(inputPath, await readStorageObject(source.storagePath));
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-ss", Math.max(0, Number(timeSeconds) || 0).toFixed(3),
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", `scale=${ASSET_THUMBNAIL_SIZE}:-2:force_original_aspect_ratio=decrease`,
      "-q:v", "2",
      framePath,
    ]);
    return await createAssetThumbnail(await readFile(framePath), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const createIdentityThumbnailFromStorage = createAssetThumbnailFromStorage;
