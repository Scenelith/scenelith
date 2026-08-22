import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let db: typeof import("./postgres-test-db")["db"];
let closeRelationalPool: typeof import("./postgres-test-db")["closeRelationalPool"];
let reserveDurableUploadSessions: typeof import("../src/lib/storage-lifecycle")["reserveDurableUploadSessions"];
let releaseDurableUploadSession: typeof import("../src/lib/storage-lifecycle")["releaseDurableUploadSession"];
let workspaceId = "";
let projectId = "";
let userId = "";

before(async () => {
  const testDb = await import("./postgres-test-db");
  ({ db, closeRelationalPool } = testDb);
  await testDb.resetTestDatabase();
  ({ reserveDurableUploadSessions, releaseDurableUploadSession } = await import("../src/lib/storage-lifecycle"));
  userId = crypto.randomUUID();
  workspaceId = crypto.randomUUID();
  projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, 'storage@example.test', 'Storage', ?, ?)").run(userId, now, now);
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Storage', ?, ?)").run(workspaceId, now, now);
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(workspaceId, userId, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, 'Canvas', '{\"nodes\":[],\"edges\":[]}', ?, ?)").run(projectId, workspaceId, now, now);
});

after(async () => closeRelationalPool());

async function usage() {
  return await db.prepare("SELECT used_bytes, reserved_bytes, quota_bytes FROM workspace_storage_usage WHERE workspace_id = ?")
    .get(workspaceId) as { used_bytes: number; reserved_bytes: number; quota_bytes: number };
}

test("asset rows maintain exact workspace storage usage", async () => {
  const assetId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO assets
    (id, workspace_id, project_id, kind, filename, storage_path, size_bytes, thumbnail_size_bytes, mime_type, created_at)
    VALUES (?, ?, ?, 'scene', 'image.jpg', '/tmp/image.jpg', 1200, 80, 'image/jpeg', ?)`)
    .run(assetId, workspaceId, projectId, now);
  assert.equal((await usage()).used_bytes, 1280);

  await db.prepare("UPDATE assets SET size_bytes = 1500, thumbnail_size_bytes = 100 WHERE id = ?").run(assetId);
  assert.equal((await usage()).used_bytes, 1600);

  await db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
  assert.equal((await usage()).used_bytes, 0);
  const deletionJobs = await db.prepare("SELECT storage_reference FROM storage_deletion_jobs WHERE storage_reference = ?")
    .all("/tmp/image.jpg") as Array<{ storage_reference: string }>;
  assert.deepEqual(deletionJobs.map((row) => row.storage_reference), ["/tmp/image.jpg"]);
});

test("multipart uploads reserve quota until completion or abort", async () => {
  const assetId = crypto.randomUUID();
  const expiresAt = Date.now() + 20 * 60_000;
  await reserveDurableUploadSessions([{
    id: assetId,
    workspaceId,
    projectId,
    userId,
    purpose: "library",
    bucket: "private",
    key: `uploads/${assetId}`,
    reference: `r2://private/uploads/${assetId}`,
    uploadId: "multipart-id",
    filename: "video.mp4",
    originalName: "video.mp4",
    mimeType: "video/mp4",
    size: 25_000,
    partSize: 16_000,
    partCount: 2,
    expiresAt,
  }]);
  assert.equal((await usage()).reserved_bytes, 25_000);
  assert.equal(await releaseDurableUploadSession(assetId, "aborted"), true);
  assert.equal((await usage()).reserved_bytes, 0);
});

test("quota is checked atomically before multipart reservations", async () => {
  await db.prepare("UPDATE workspace_storage_usage SET quota_bytes = 1024 WHERE workspace_id = ?").run(workspaceId);
  await assert.rejects(() => reserveDurableUploadSessions([{
    id: crypto.randomUUID(), workspaceId, projectId, userId, purpose: "canvas",
    bucket: "private", key: "too-large", reference: "r2://private/too-large", uploadId: "too-large",
    filename: "large.mp4", originalName: "large.mp4", mimeType: "video/mp4", size: 2048,
    partSize: 2048, partCount: 1, expiresAt: Date.now() + 60_000,
  }]), /quota exceeded/i);
  assert.equal((await usage()).reserved_bytes, 0);
});

test("project deletion tombstones collaboration state and queues every R2 object", async () => {
  const assetId = crypto.randomUUID();
  await db.prepare(`INSERT INTO assets
    (id, workspace_id, project_id, kind, filename, storage_path, thumbnail_storage_path, size_bytes, thumbnail_size_bytes, mime_type, created_at)
    VALUES (?, ?, ?, 'scene', 'delete.jpg', ?, ?, 100, 20, 'image/jpeg', ?)`)
    .run(assetId, workspaceId, projectId, "r2://private/delete.jpg", "r2://private/delete-thumb.webp", new Date().toISOString());
  await db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  assert.equal(await db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId), undefined);
  const jobs = await db.prepare("SELECT storage_reference FROM storage_deletion_jobs WHERE storage_reference LIKE 'r2://private/delete%' ORDER BY storage_reference")
    .all() as Array<{ storage_reference: string }>;
  assert.deepEqual(jobs.map((row) => row.storage_reference), ["r2://private/delete-thumb.webp", "r2://private/delete.jpg"]);
  assert.ok(await db.prepare("SELECT document_name FROM collaboration_document_tombstones WHERE document_name = ?").get(projectId));
});
