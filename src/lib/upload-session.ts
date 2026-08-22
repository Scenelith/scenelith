import { createHmac, timingSafeEqual } from "node:crypto";
import type { DirectMultipartUpload } from "@/lib/storage";

export type UploadPurpose = "library" | "canvas" | "edit-reference";

export type UploadSessionPayload = DirectMultipartUpload & {
  assetId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  purpose: UploadPurpose;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  partSize: number;
  partCount: number;
  expiresAt: number;
};

function uploadSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be configured for direct uploads");
  return secret;
}

function signature(encoded: string) {
  return createHmac("sha256", uploadSecret()).update(encoded).digest("base64url");
}

export function signUploadSession(payload: UploadSessionPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

export function verifyUploadSession(token: string): UploadSessionPayload {
  const separator = token.lastIndexOf(".");
  if (separator < 1) throw new Error("Invalid upload session");
  const encoded = token.slice(0, separator);
  const actual = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(signature(encoded));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid upload session");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as UploadSessionPayload;
  if (!payload.assetId || !payload.uploadId || !payload.key || !payload.bucket || payload.expiresAt <= Date.now()) {
    throw new Error("Upload session expired");
  }
  return payload;
}
