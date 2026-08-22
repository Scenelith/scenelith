import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("asset delivery uses project-aware authorization instead of raw workspace membership", () => {
  const route = source("src/app/api/assets/[id]/route.ts");
  assert.match(route, /userCanAccessAsset\(auth\.user\.id, id\)/);
  assert.doesNotMatch(route, /JOIN workspace_members/);
});

test("revoked users cannot keep reading project background activity", () => {
  const tasksRoute = source("src/app/api/tasks/route.ts");
  const jobs = source("src/lib/tiktok-automation-jobs.ts");
  assert.match(tasksRoute, /await userCanAccessProject\(auth\.user\.id, row\.project_id\)/);
  assert.match(jobs, /!await userCanAccessProject\(userId, row\.project_id\)/);
});

test("manual hooks cannot combine a workspace with a canvas from another workspace", () => {
  const route = source("src/app/api/hooks/route.ts");
  assert.match(route, /SELECT 1 FROM projects WHERE id = \? AND workspace_id = \?/);
  assert.match(route, /!projectMatchesWorkspace \|\| !await userCanAccessProject/);
});

test("workspace access is selected through a narrow distribution adapter", () => {
  const database = source("src/lib/postgres-db.ts");
  const access = source("src/core/access/owner-workspace-access.ts");
  assert.match(database, /@\/editions\/current\/access/);
  assert.match(access, /wm\.role = 'owner'/);
  assert.doesNotMatch(access, /team_memberships|team_canvas_grants|team_managed/);
});

test("expensive authenticated mutations are origin checked and rate limited across web replicas", () => {
  const limiter = source("src/lib/distributed-rate-limit.ts");
  assert.match(limiter, /redis\.call\('INCR'/);
  assert.match(limiter, /REDIS_URL is required for distributed request rate limiting/);
  for (const route of [
    "src/app/api/assistant/route.ts",
    "src/app/api/prompts/compose/route.ts",
    "src/app/api/import/tiktok/route.ts",
    "src/app/api/automations/tiktok/plan/route.ts",
    "src/app/api/assets/uploads/route.ts",
    "src/app/api/personas/route.ts",
  ]) {
    assert.match(source(route), /sameOriginRequest/);
    assert.match(source(route), /enforceDistributedRateLimit/);
  }
});

test("sensitive access and deletion actions append bounded audit evidence", () => {
  const migration = source("database/baselines/core-v1.sql");
  const worker = source("src/worker.ts");
  assert.match(migration, /audit_events_append_only/);
  assert.match(migration, /'400 days'::interval/);
  assert.match(worker, /DELETE FROM audit_events WHERE expires_at/);
  assert.match(source("src/app/api/projects/[id]/route.ts"), /project\.deleted/);
  assert.doesNotMatch(source("src/core/access/owner-workspace-access.ts"), /member_removed/);
});
