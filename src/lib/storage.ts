import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, extname, join, normalize, relative } from "node:path";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListPartsCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readInstanceSecret, requireInstanceSecret } from "@/platform/secrets";
import { incrementOperationalCounter } from "@/lib/operational-telemetry";

export const storageRoot = process.env.STORAGE_PATH || join(/* turbopackIgnore: true */ process.cwd(), "data", "storage");

export type StoredObject = {
  provider: "local" | "r2" | "s3";
  bucket: string | null;
  key: string;
  reference: string;
  size: number;
  contentHash: string;
};

type PutStorageOptions = {
  bucket?: "private" | "public" | string;
  contentType?: string;
  cacheControl?: string;
};

let objectStorageClient: S3Client | null = null;

async function objectStorageRequest<T>(operation: string, request: () => Promise<T>) {
  const provider = storageProvider();
  try {
    const result = await request();
    incrementOperationalCounter("scenelith_object_storage_requests_total", "S3-compatible object storage requests by operation and result.", { operation, provider, result: "success" });
    return result;
  } catch (error) {
    incrementOperationalCounter("scenelith_object_storage_requests_total", "S3-compatible object storage requests by operation and result.", { operation, provider, result: "failure" });
    throw error;
  }
}

export function storageProvider() {
  const provider = (process.env.STORAGE_PROVIDER || "local").toLowerCase();
  if (provider === "r2" || provider === "s3") return provider;
  return "local";
}

export type DirectMultipartUpload = {
  bucket: string;
  key: string;
  reference: string;
  uploadId: string;
};

export async function createDirectMultipartUpload(key: string, options: PutStorageOptions = {}): Promise<DirectMultipartUpload> {
  const provider = storageProvider();
  if (provider === "local") throw new Error("Direct uploads require S3-compatible object storage");
  const normalizedKey = safeObjectKey(key);
  const bucket = bucketName(options.bucket);
  const created = await objectStorageRequest("create_multipart_upload", () => getObjectStorageClient().send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: normalizedKey,
    ContentType: options.contentType,
    CacheControl: options.cacheControl,
  })));
  if (!created.UploadId) throw new Error("Object storage did not create an upload session");
  return { bucket, key: normalizedKey, reference: objectStorageReference(provider, bucket, normalizedKey), uploadId: created.UploadId };
}

export async function signedDirectUploadPartUrls(upload: DirectMultipartUpload, partCount: number, expiresIn = 20 * 60) {
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > 10_000) throw new Error("Invalid multipart upload size");
  return Promise.all(Array.from({ length: partCount }, async (_, index) => ({
    partNumber: index + 1,
    url: await getSignedUrl(getObjectStorageClient(), new UploadPartCommand({
      Bucket: upload.bucket,
      Key: upload.key,
      UploadId: upload.uploadId,
      PartNumber: index + 1,
    }), { expiresIn: Math.min(60 * 60, Math.max(60, expiresIn)) }),
  })));
}

export async function completeDirectMultipartUpload(upload: DirectMultipartUpload, expectedParts: number) {
  const listed = await objectStorageRequest("list_multipart_parts", () => getObjectStorageClient().send(new ListPartsCommand({
    Bucket: upload.bucket,
    Key: upload.key,
    UploadId: upload.uploadId,
    MaxParts: 10_000,
  })));
  const parts = (listed.Parts || [])
    .filter((part) => part.PartNumber && part.ETag)
    .sort((left, right) => Number(left.PartNumber) - Number(right.PartNumber));
  if (parts.length !== expectedParts || parts.some((part, index) => part.PartNumber !== index + 1)) {
    throw new Error("Upload is incomplete");
  }
  await objectStorageRequest("complete_multipart_upload", () => getObjectStorageClient().send(new CompleteMultipartUploadCommand({
    Bucket: upload.bucket,
    Key: upload.key,
    UploadId: upload.uploadId,
    MultipartUpload: { Parts: parts.map((part) => ({ ETag: part.ETag, PartNumber: part.PartNumber })) },
  })));
  const stored = await objectStorageRequest("head_object", () => getObjectStorageClient().send(new HeadObjectCommand({ Bucket: upload.bucket, Key: upload.key })));
  return { size: Number(stored.ContentLength || 0), contentType: stored.ContentType || "application/octet-stream" };
}

export async function abortDirectMultipartUpload(upload: DirectMultipartUpload) {
  await objectStorageRequest("abort_multipart_upload", () => getObjectStorageClient().send(new AbortMultipartUploadCommand({
    Bucket: upload.bucket,
    Key: upload.key,
    UploadId: upload.uploadId,
  })));
}

function getObjectStorageClient() {
  if (objectStorageClient) return objectStorageClient;
  const provider = storageProvider();
  if (provider === "local") throw new Error("S3-compatible object storage is not configured");
  const accountId = process.env.R2_ACCOUNT_ID;
  const endpoint = provider === "r2"
    ? accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ""
    : String(process.env.S3_ENDPOINT || "").replace(/\/$/, "");
  if (provider === "r2" && !endpoint) throw new Error("R2_ACCOUNT_ID is not configured");
  const accessKeyId = provider === "r2"
    ? requireInstanceSecret("R2_ACCESS_KEY_ID")
    : readInstanceSecret("S3_ACCESS_KEY_ID") || requireInstanceSecret("AWS_ACCESS_KEY_ID");
  const secretAccessKey = provider === "r2"
    ? requireInstanceSecret("R2_SECRET_ACCESS_KEY")
    : readInstanceSecret("S3_SECRET_ACCESS_KEY") || requireInstanceSecret("AWS_SECRET_ACCESS_KEY");
  objectStorageClient = new S3Client({
    region: provider === "r2" ? "auto" : process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
    // The AWS SDK resolves the regional AWS S3 endpoint itself. Operators set
    // S3_ENDPOINT only for S3-compatible services such as MinIO or Backblaze.
    endpoint: endpoint || undefined,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: provider === "s3" && process.env.S3_FORCE_PATH_STYLE === "true",
  });
  return objectStorageClient;
}

function bucketName(requested: PutStorageOptions["bucket"] = "private") {
  const prefix = storageProvider() === "s3" ? "S3" : "R2";
  if (requested === "private") return process.env[`${prefix}_PRIVATE_BUCKET`] || "scenelith-private";
  if (requested === "public") return process.env[`${prefix}_PUBLIC_BUCKET`] || "scenelith-public";
  return requested;
}

function objectStorageReference(provider: "r2" | "s3", bucket: string, key: string) {
  return `${provider}://${bucket}/${key}`;
}

function parseObjectStorageReference(reference: string) {
  const protocol = reference.startsWith("r2://") ? "r2" : reference.startsWith("s3://") ? "s3" : null;
  if (!protocol) return null;
  const value = reference.slice(protocol.length + 3);
  const separator = value.indexOf("/");
  if (separator < 1) throw new Error("Invalid object storage reference");
  return { provider: protocol, bucket: value.slice(0, separator), key: safeObjectKey(value.slice(separator + 1)) };
}

function safeObjectKey(key: string) {
  const normalized = normalize(key).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("..") || normalized.includes("/../")) {
    throw new Error("Invalid storage object key");
  }
  return normalized;
}

function localPathForKey(key: string) {
  const path = join(/* turbopackIgnore: true */ storageRoot, safeObjectKey(key));
  const withinRoot = relative(storageRoot, path);
  if (!withinRoot || withinRoot.startsWith("..")) throw new Error("Storage path escaped its workspace root");
  return path;
}

export function safeExtension(filename: string, mimeType = "") {
  const ext = extname(filename).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".avif", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".m4a"].includes(ext)) return ext;
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/avif") return ".avif";
  if (mimeType.startsWith("video/")) return ".mp4";
  if (mimeType.startsWith("audio/")) return ".mp3";
  return ".jpg";
}

export async function putStorageObject(bytes: ArrayBuffer | Uint8Array, key: string, options: PutStorageOptions = {}): Promise<StoredObject> {
  const normalizedKey = safeObjectKey(key);
  const buffer = bytes instanceof ArrayBuffer
    ? Buffer.from(bytes)
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const provider = storageProvider();
  if (provider !== "local") {
    const bucket = bucketName(options.bucket);
    await objectStorageRequest("put_object", () => getObjectStorageClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: normalizedKey,
      Body: buffer,
      ContentType: options.contentType,
      CacheControl: options.cacheControl,
      Metadata: { sha256: contentHash },
    })));
    return { provider, bucket, key: normalizedKey, reference: objectStorageReference(provider, bucket, normalizedKey), size: buffer.byteLength, contentHash };
  }
  const path = localPathForKey(normalizedKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  return { provider: "local", bucket: null, key: normalizedKey, reference: path, size: buffer.byteLength, contentHash };
}

export async function saveBytes(bytes: ArrayBuffer | Uint8Array, group: string, filename: string, contentType?: string) {
  return putStorageObject(bytes, join(group, filename), { contentType });
}

export async function downloadToStorage(url: string, group: string, filename: string) {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 Frameflow/1.0" }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Media download failed (${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  const stored = await putStorageObject(await response.arrayBuffer(), join(group, filename), { contentType });
  return { path: stored.reference, contentType, stored };
}

export async function readStorageObject(reference: string) {
  const object = parseObjectStorageReference(reference);
  if (!object) return readFile(/* turbopackIgnore: true */ reference);
  const response = await objectStorageRequest("get_object", () => getObjectStorageClient().send(new GetObjectCommand({ Bucket: object.bucket, Key: object.key })));
  if (!response.Body) throw new Error("Object storage returned no body");
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function statStorageObject(reference: string) {
  const object = parseObjectStorageReference(reference);
  if (!object) return stat(/* turbopackIgnore: true */ reference);
  const response = await objectStorageRequest("head_object", () => getObjectStorageClient().send(new HeadObjectCommand({ Bucket: object.bucket, Key: object.key })));
  return { size: Number(response.ContentLength || 0) };
}

export async function streamStorageObject(reference: string, range?: { start: number; end: number }) {
  const object = parseObjectStorageReference(reference);
  if (!object) {
    const stream = range ? createReadStream(/* turbopackIgnore: true */ reference, range) : createReadStream(/* turbopackIgnore: true */ reference);
    return Readable.toWeb(stream) as ReadableStream;
  }
  const response = await objectStorageRequest("get_object_range", () => getObjectStorageClient().send(new GetObjectCommand({
    Bucket: object.bucket,
    Key: object.key,
    Range: range ? `bytes=${range.start}-${range.end}` : undefined,
  })));
  if (!response.Body) throw new Error("Object storage returned no body");
  return response.Body.transformToWebStream();
}

export async function readStoragePrefix(reference: string, length = 64) {
  const safeLength = Math.min(4_096, Math.max(1, Math.floor(length)));
  const stream = await streamStorageObject(reference, { start: 0, end: safeLength - 1 });
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < safeLength) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const chunk = value.subarray(0, safeLength - received);
      chunks.push(chunk);
      received += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), received);
}

type SignedReadOptions = {
  downloadName?: string;
  expiresIn?: number;
};

function safeDownloadName(filename: string) {
  return filename.replace(/[\r\n"\\]/g, "").trim() || "download";
}

export async function signedStorageReadUrl(reference: string, options: SignedReadOptions = {}) {
  const object = parseObjectStorageReference(reference);
  if (!object) return null;
  // A stable signature inside the window lets browsers reuse the immutable
  // object cache instead of receiving a unique URL for every node render.
  const expiresIn = Math.min(60 * 60, Math.max(60, options.expiresIn || 20 * 60));
  const signingWindowMs = 10 * 60 * 1000;
  const signingDate = new Date(Math.floor(Date.now() / signingWindowMs) * signingWindowMs);
  const downloadName = options.downloadName ? safeDownloadName(options.downloadName) : null;
  const contentDisposition = downloadName
    ? `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    : undefined;
  return getSignedUrl(
    getObjectStorageClient(),
    new GetObjectCommand({ Bucket: object.bucket, Key: object.key, ResponseContentDisposition: contentDisposition }),
    { expiresIn, signingDate },
  );
}

export async function deleteStorageObject(reference: string) {
  const object = parseObjectStorageReference(reference);
  if (object) {
    await objectStorageRequest("delete_object", () => getObjectStorageClient().send(new DeleteObjectCommand({ Bucket: object.bucket, Key: object.key })));
    return;
  }
  await unlink(/* turbopackIgnore: true */ reference).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function fileToData(path: string) {
  return readStorageObject(path);
}

export function publicMediaUrl(key: string) {
  const base = process.env.NEXT_PUBLIC_MEDIA_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/${safeObjectKey(key)}` : `/${safeObjectKey(key)}`;
}
