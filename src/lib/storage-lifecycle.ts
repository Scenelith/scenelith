import { db } from "./postgres-db";
import { abortDirectMultipartUpload, deleteStorageObject } from "./storage";
import type { UploadPurpose } from "./upload-session";
import { workerIdentity } from "./worker-identity";

export type DurableUploadSession = {
  id: string;
  workspace_id: string;
  project_id: string;
  user_id: string;
  purpose: UploadPurpose;
  bucket: string;
  object_key: string;
  storage_reference: string;
  upload_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  part_size: number;
  part_count: number;
  status: string;
  attempts: number;
  expires_at: string;
};

type PreparedUpload = {
  id: string;
  workspaceId: string;
  projectId: string;
  userId: string;
  purpose: UploadPurpose;
  bucket: string;
  key: string;
  reference: string;
  uploadId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  partSize: number;
  partCount: number;
  expiresAt: number;
};

async function lockedUsage(workspaceId: string) {
  await db.prepare(`INSERT INTO workspace_storage_usage (workspace_id, used_bytes, reserved_bytes, updated_at)
    VALUES (?, COALESCE((SELECT SUM(COALESCE(size_bytes, 0) + COALESCE(thumbnail_size_bytes, 0)) FROM assets WHERE workspace_id = ?), 0), 0, ?)
    ON CONFLICT(workspace_id) DO NOTHING`).run(workspaceId, workspaceId, new Date().toISOString());
  return await db.prepare(`SELECT used_bytes, reserved_bytes, quota_bytes FROM workspace_storage_usage
    WHERE workspace_id = ? FOR UPDATE`).get(workspaceId) as { used_bytes: number; reserved_bytes: number; quota_bytes: number };
}

export async function assertWorkspaceStorageCapacity(workspaceId: string, additionalBytes: number) {
  const usage = await lockedUsage(workspaceId);
  if (Number(usage.used_bytes) + Number(usage.reserved_bytes) + additionalBytes > Number(usage.quota_bytes)) {
    throw new Error("Workspace storage quota exceeded");
  }
  return usage;
}

export async function reserveDurableUploadSessions(uploads: PreparedUpload[]) {
  if (!uploads.length) return;
  const workspaceId = uploads[0].workspaceId;
  if (uploads.some((upload) => upload.workspaceId !== workspaceId)) throw new Error("Upload batch spans multiple workspaces");
  const totalBytes = uploads.reduce((total, upload) => total + upload.size, 0);
  await db.transaction(async () => {
    const usage = await lockedUsage(workspaceId);
    if (Number(usage.used_bytes) + Number(usage.reserved_bytes) + totalBytes > Number(usage.quota_bytes)) {
      throw new Error("Workspace storage quota exceeded");
    }
    const now = new Date().toISOString();
    for (const upload of uploads) {
      await db.prepare(`INSERT INTO asset_upload_sessions
        (id, workspace_id, project_id, user_id, purpose, bucket, object_key, storage_reference, upload_id,
         filename, original_name, mime_type, size_bytes, part_size, part_count, status, attempts,
         available_at, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?, ?, ?, ?)`)
        .run(upload.id, upload.workspaceId, upload.projectId, upload.userId, upload.purpose, upload.bucket,
          upload.key, upload.reference, upload.uploadId, upload.filename, upload.originalName, upload.mimeType,
          upload.size, upload.partSize, upload.partCount, now, new Date(upload.expiresAt).toISOString(), now, now);
    }
    await db.prepare(`UPDATE workspace_storage_usage SET reserved_bytes = reserved_bytes + ?, updated_at = ?
      WHERE workspace_id = ?`).run(totalBytes, now, workspaceId);
  })();
}

export async function beginDurableUploadCompletion(assetId: string, userId: string) {
  return await db.transaction(async () => {
    const session = await db.prepare("SELECT * FROM asset_upload_sessions WHERE id = ? FOR UPDATE").get(assetId) as DurableUploadSession | undefined;
    if (!session || session.user_id !== userId) return null;
    if (session.status === "completed") return session;
    if (session.status !== "prepared" || Date.parse(session.expires_at) <= Date.now()) return null;
    const now = new Date().toISOString();
    const changed = await db.prepare(`UPDATE asset_upload_sessions SET status = 'completing', locked_at = ?, worker_id = ?, updated_at = ?
      WHERE id = ? AND status = 'prepared'`).run(now, userId, now, assetId);
    return changed.changes === 1 ? { ...session, status: "completing" } : null;
  })();
}

export async function completeDurableUploadSession(assetId: string, userId: string) {
  await db.transaction(async () => {
    const session = await db.prepare("SELECT workspace_id, size_bytes, status, worker_id FROM asset_upload_sessions WHERE id = ? FOR UPDATE")
      .get(assetId) as { workspace_id: string; size_bytes: number; status: string; worker_id: string | null } | undefined;
    if (!session || session.status !== "completing" || session.worker_id !== userId) throw new Error("Upload completion lost its lease");
    const now = new Date().toISOString();
    await db.prepare(`UPDATE asset_upload_sessions SET status = 'completed', completed_at = ?, locked_at = NULL, worker_id = NULL, updated_at = ?
      WHERE id = ?`).run(now, now, assetId);
    await db.prepare(`UPDATE workspace_storage_usage SET reserved_bytes = GREATEST(0, reserved_bytes - ?), updated_at = ?
      WHERE workspace_id = ?`).run(session.size_bytes, now, session.workspace_id);
  })();
}

export async function releaseDurableUploadSession(assetId: string, terminalStatus: "aborted" | "failed", expectedWorkerId?: string) {
  return await db.transaction(async () => {
    const session = await db.prepare("SELECT workspace_id, size_bytes, status, worker_id FROM asset_upload_sessions WHERE id = ? FOR UPDATE")
      .get(assetId) as { workspace_id: string; size_bytes: number; status: string; worker_id: string | null } | undefined;
    if (!session || ["completed", "aborted", "failed"].includes(session.status)) return false;
    if (expectedWorkerId && session.worker_id !== expectedWorkerId) return false;
    const now = new Date().toISOString();
    await db.prepare(`UPDATE asset_upload_sessions SET status = ?, locked_at = NULL, worker_id = NULL, updated_at = ? WHERE id = ?`)
      .run(terminalStatus, now, assetId);
    await db.prepare(`UPDATE workspace_storage_usage SET reserved_bytes = GREATEST(0, reserved_bytes - ?), updated_at = ?
      WHERE workspace_id = ?`).run(session.size_bytes, now, session.workspace_id);
    return true;
  })();
}

export async function enqueueStorageDeletion(storageReference: string | null | undefined, workspaceId: string | null, reason: string) {
  if (!storageReference) return;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO storage_deletion_jobs
    (id, workspace_id, storage_reference, reason, status, attempts, max_attempts, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 0, 12, ?, ?, ?)
    ON CONFLICT(storage_reference) DO UPDATE SET status = CASE WHEN storage_deletion_jobs.status = 'completed' THEN 'queued' ELSE storage_deletion_jobs.status END,
      reason = excluded.reason, available_at = LEAST(storage_deletion_jobs.available_at, excluded.available_at), updated_at = excluded.updated_at`)
    .run(crypto.randomUUID(), workspaceId, storageReference, reason, now, now, now);
}

async function claimStorageDeletion(workerId: string) {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  return await db.transaction(async () => {
    const row = await db.prepare(`SELECT id, storage_reference, attempts, max_attempts FROM storage_deletion_jobs
      WHERE attempts < max_attempts AND ((status = 'queued' AND available_at <= ?) OR (status = 'processing' AND locked_at < ?))
      ORDER BY available_at ASC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`).get(now, staleBefore) as
      { id: string; storage_reference: string; attempts: number; max_attempts: number } | undefined;
    if (!row) return null;
    const attempts = Number(row.attempts) + 1;
    const changed = await db.prepare(`UPDATE storage_deletion_jobs SET status = 'processing', attempts = ?, locked_at = ?, worker_id = ?, updated_at = ?
      WHERE id = ? AND attempts = ?`).run(attempts, now, workerId, now, row.id, row.attempts);
    return changed.changes === 1 ? { ...row, attempts } : null;
  })();
}

async function drainExpiredUploadSession(workerId: string) {
  const now = new Date().toISOString();
  const session = await db.transaction(async () => {
    const row = await db.prepare(`SELECT * FROM asset_upload_sessions
      WHERE status = 'prepared' AND expires_at <= ? AND available_at <= ?
      ORDER BY expires_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`).get(now, now) as DurableUploadSession | undefined;
    if (!row) return null;
    const changed = await db.prepare(`UPDATE asset_upload_sessions SET status = 'aborting', attempts = attempts + 1,
      locked_at = ?, worker_id = ?, updated_at = ? WHERE id = ? AND status = 'prepared'`)
      .run(now, workerId, now, row.id);
    return changed.changes === 1 ? { ...row, attempts: Number(row.attempts) + 1 } : null;
  })();
  if (!session) return false;
  try {
    await abortDirectMultipartUpload({ bucket: session.bucket, key: session.object_key, reference: session.storage_reference, uploadId: session.upload_id });
    await releaseDurableUploadSession(session.id, "aborted", workerId);
  } catch (error) {
    const retryAt = new Date(Date.now() + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(8, session.attempts))).toISOString();
    await db.prepare(`UPDATE asset_upload_sessions SET status = 'prepared', available_at = ?, locked_at = NULL, worker_id = NULL,
      last_error = ?, updated_at = ? WHERE id = ? AND status = 'aborting' AND worker_id = ?`)
      .run(retryAt, error instanceof Error ? error.message.slice(0, 4_000) : "Multipart abort failed", now, session.id, workerId);
  }
  return true;
}

export async function drainStorageLifecycle(limit = 12) {
  const workerId = workerIdentity("storage");
  let processed = 0;
  while (processed < Math.max(1, limit)) {
    if (await drainExpiredUploadSession(workerId)) {
      processed += 1;
      continue;
    }
    const job = await claimStorageDeletion(workerId);
    if (!job) break;
    try {
      await deleteStorageObject(job.storage_reference);
      const now = new Date().toISOString();
      await db.prepare(`UPDATE storage_deletion_jobs SET status = 'completed', completed_at = ?, locked_at = NULL,
        worker_id = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND worker_id = ? AND attempts = ?`)
        .run(now, now, job.id, workerId, job.attempts);
    } catch (error) {
      const exhausted = job.attempts >= job.max_attempts;
      const now = new Date().toISOString();
      await db.prepare(`UPDATE storage_deletion_jobs SET status = ?, available_at = ?, locked_at = NULL, worker_id = NULL,
        last_error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND attempts = ?`)
        .run(exhausted ? "dead" : "queued", new Date(Date.now() + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(8, job.attempts))).toISOString(),
          error instanceof Error ? error.message.slice(0, 4_000) : "Storage deletion failed", exhausted ? now : null, now, job.id, workerId, job.attempts);
    }
    processed += 1;
  }
  return processed;
}
