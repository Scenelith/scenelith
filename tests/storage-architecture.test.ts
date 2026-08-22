import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("large media bypasses the Next.js request body through resumable R2 multipart uploads", () => {
  const storage = source("src/lib/storage.ts");
  const client = source("src/components/CanvasApp.tsx");
  const prepare = source("src/app/api/assets/uploads/route.ts");
  const complete = source("src/app/api/assets/uploads/complete/route.ts");
  assert.match(storage, /CreateMultipartUploadCommand/);
  assert.match(storage, /UploadPartCommand/);
  assert.match(storage, /ListPartsCommand/);
  assert.match(storage, /CompleteMultipartUploadCommand/);
  assert.match(client, /Math\.min\(3, plan\.parts\.length\)/);
  assert.match(client, /for \(let attempt = 0; attempt < 3/);
  assert.match(prepare, /PART_SIZE = 16 \* 1024 \* 1024/);
  assert.match(complete, /stored\.size !== upload\.size/);
  assert.match(complete, /mediaContentMatchesMime/);
  assert.match(complete, /readStoragePrefix/);
});

test("user uploads reject WebP consistently", () => {
  const client = source("src/components/CanvasApp.tsx");
  const legacy = source("src/app/api/assets/route.ts");
  const direct = source("src/app/api/assets/uploads/route.ts");
  assert.doesNotMatch(client, /accept="[^"]*webp/i);
  assert.doesNotMatch(legacy, /ACCEPTED_IMAGE_TYPES = new Set\([^\n]*webp/);
  assert.doesNotMatch(direct, /IMAGE_TYPES = new Set\([^\n]*webp/);
});

test("application PostgreSQL schema is immutable and versioned", () => {
  const runner = source("database/migration-runner.mjs");
  assert.match(runner, /pg_advisory_lock\(\$1::bigint\)/);
  assert.match(runner, /Applied application migration changed/);
  assert.match(runner, /Application migration is not expand-only/);
  assert.match(source("database/baselines/core-v1.sql"), /CREATE TABLE public\.projects/);
  assert.match(source("database/baselines/core-v1.sql"), /CREATE TABLE public\.generation_dispatch_jobs/);
  assert.match(source("database/baselines/core-v1.sql"), /assets_enqueue_storage_deletion/);
  assert.match(source("database/baselines/core-v1.sql"), /CREATE TABLE public\.audit_events/);
  assert.match(runner, /legacyUrl/);
  assert.match(runner, /streamLedger/);
});

test("R2 and generic S3 browser upload CORS are managed without deleting unrelated rules", () => {
  const storage = source("src/lib/storage.ts");
  const cors = source("scripts/configure-r2-cors.mjs");
  assert.match(cors, /scenelith-browser-media-v1/);
  assert.match(cors, /AllowedMethods: \["GET", "HEAD", "PUT"\]/);
  assert.match(cors, /ExposeHeaders: \["etag", "content-length", "content-range"\]/);
  assert.match(cors, /existing\.filter\(\(rule\) => rule\.ID !== managedRuleId\)/);
  assert.match(cors, /STORAGE_PROVIDER/);
  assert.match(cors, /S3_ENDPOINT/);
  assert.match(cors, /STORAGE_CORS_ORIGINS/);
  assert.match(storage, /endpoint: endpoint \|\| undefined/);
  assert.doesNotMatch(storage, /S3_ENDPOINT is not configured/);
});
