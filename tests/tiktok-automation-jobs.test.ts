import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let db: typeof import("./postgres-test-db")["db"];
let closeRelationalPool: typeof import("./postgres-test-db")["closeRelationalPool"];
let jobs: typeof import("../src/lib/tiktok-automation-jobs");
const selfHosted = process.env.SCENELITH_DEPLOYMENT_TYPE === "selfhost";

before(async () => {
  const testDb = await import("./postgres-test-db");
  ({ db, closeRelationalPool } = testDb);
  await testDb.resetTestDatabase();
  jobs = await import("../src/lib/tiktok-automation-jobs");
});

after(async () => {
  await closeRelationalPool();
});

async function seedOwner() {
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, 'Owner', ?, ?)")
    .run(userId, `${userId}@example.test`, now, now);
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'Workspace', ?, ?)")
    .run(workspaceId, now, now);
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run(workspaceId, userId, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, graph_json, created_at, updated_at) VALUES (?, ?, 'Canvas', '{\"nodes\":[],\"edges\":[]}', ?, ?)")
    .run(projectId, workspaceId, now, now);
  return { userId, workspaceId, projectId };
}

function request(projectId: string, sourceNodeId = "source-node") {
  return {
    projectId,
    sourceNodeId,
    sourceAssetIds: [crypto.randomUUID(), crypto.randomUUID()],
    personaId: null,
    modelId: "nano-banana-2",
    planningModelId: "google/gemini-3.1-flash-lite-preview",
    caption: "",
    preferences: { mode: "concept" as const, newOutfit: true, newLocation: true, textStrategy: "rewrite" as const, creativeBrief: "" },
  };
}

test("identical active automation requests collapse into one durable job", async () => {
  const owner = await seedOwner();
  const payload = request(owner.projectId);
  const first = await jobs.enqueueTikTokAutomationJob({ userId: owner.userId, workspaceId: owner.workspaceId, request: payload });
  const second = await jobs.enqueueTikTokAutomationJob({ userId: owner.userId, workspaceId: owner.workspaceId, request: payload });
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.deduplicated, true);
  const count = await db.prepare("SELECT COUNT(*) AS count FROM tiktok_automation_jobs WHERE user_id = ?").get(owner.userId) as { count: number };
  assert.equal(count.count, 1);
});

test("every resumed attempt receives a fresh credit reservation id", () => {
  const jobId = crypto.randomUUID();
  const first = jobs.tiktokAutomationReservationId(jobId, 2, "resume-a");
  const second = jobs.tiktokAutomationReservationId(jobId, 2, "resume-b");
  assert.notEqual(first, second);
  assert.match(first, new RegExp(`^tiktok:${jobId}:2:`));
});

test("job progress is private to the user who queued it", async () => {
  const owner = await seedOwner();
  const stranger = await seedOwner();
  const queued = await jobs.enqueueTikTokAutomationJob({ userId: owner.userId, workspaceId: owner.workspaceId, request: request(owner.projectId, "private-source") });
  assert.equal(await jobs.getTikTokAutomationJob(queued.jobId, stranger.userId), null);
  const visible = await jobs.getTikTokAutomationJob(queued.jobId, owner.userId);
  assert.equal(visible?.status, "queued");
  assert.ok((visible?.queuePosition || 0) >= 1);
  assert.equal(visible?.result, null);
});

test("job progress disappears as soon as canvas access is revoked", async () => {
  const owner = await seedOwner();
  const queued = await jobs.enqueueTikTokAutomationJob({ userId: owner.userId, workspaceId: owner.workspaceId, request: request(owner.projectId, "revoked-source") });
  assert.equal((await jobs.getTikTokAutomationJob(queued.jobId, owner.userId))?.status, "queued");
  await db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(owner.workspaceId, owner.userId);
  assert.equal(await jobs.getTikTokAutomationJob(queued.jobId, owner.userId), null);
});

test("background worker consumes queued jobs without holding the POST request", async () => {
  const owner = await seedOwner();
  const queued = await jobs.enqueueTikTokAutomationJob({ userId: owner.userId, workspaceId: owner.workspaceId, request: request(owner.projectId, "worker-source") });
  await jobs.drainTikTokAutomationJobs();
  const finished = await jobs.getTikTokAutomationJob(queued.jobId, owner.userId);
  assert.equal(finished?.status, "failed");
  assert.equal(finished?.httpStatus, selfHosted ? 400 : 402);
  assert.equal(finished?.code, selfHosted ? null : "PAID_ACCESS_REQUIRED");
});
