# Durable media pipeline (implementation in progress)

The media worker receives immutable asset identities and an operation specification. It does not call AI providers or payments. Queue admission is a short database transaction; download, probe, FFmpeg and upload run outside transactions. Publishing an asset and completing its job are one fenced transaction.

## Execution

`node --import tsx src/media-worker.ts` runs two independent pools (one light and one transcode slot initially). `media_jobs` holds persisted state. Workers renew every 15 seconds, with a 90-second lease and monotonic fencing token. Stale publication, cancellation and changed/revoked source access are rejected. Retry applies only to transient storage/network failures, at most three attempts. Workspace turns prevent an old, large workspace backlog from indefinitely displacing another workspace.

Admission is `POST /api/media/jobs` with `projectId` (or `workspaceId` for unassigned Library assets), `requestKey`, and `spec`. Operations: `analyze`, `preview`, `frame`, `segment`, `audio`, `export`. Read `GET /api/media/jobs/:id`; cancel `POST /api/media/jobs/:id/cancel`. Reusing a key with different settings is a conflict. Equivalent operations for the same user/scope reuse a job; access is checked again before returning a result.

The worker downloads into bounded temporary files and uploads from file streams. An output destination is registered before upload, so incomplete publication can be collected. The result is not visible until the stored file has been checked and the completion transaction commits. Originals remain unchanged.

## Media rules

Full, unchanged material reuses its original asset. Audio removal/replacement preserves the video bitstream. Concat streamcopy requires full compatible streams, codec initialization data, geometry, pixel/color parameters, orientation and matching time bases. Other cuts re-encode exactly the selected range. Partial-GOP smart cut is not used.

Frame boundaries are nearest actual presentation timestamps (ties choose the earlier timestamp), with an exclusive end. The processing plan records effective boundaries. A single VFR range preserves timestamps; multi-source normalization uses the first source rate and cumulative frame rounding. Audio for consecutive ranges of one original is processed continuously, not independently at each join. HDR transcodes are currently rejected explicitly until their metadata-preserving path is validated; untouched HDR can be reused/copied.

## Rollout gate

`SCENELITH_MEDIA_QUEUE_ENABLED=true` selects compatibility adapters. Older active orders keep their legacy execution version. Do not enable the gate until all call sites below and Cloud orchestration are migrated and the worker is healthy. There is no web-process fallback for queued jobs.

## Implementation acceptance checklist

- [x] Additive schema, durable job admission, idempotency, access recheck and fencing.
- [x] Separate worker entry, independent pools, basic metrics, file streaming.
- [x] Planner, exact segment, continuous audio, render and real-decode tests.
- [x] Async Canvas segment/export client and MCP export/status contract.
- [ ] Cached metadata admission fast path; exhaustive VFR, rotation/color and audio seam proofs.
- [ ] All upload/import/probe/thumbnail/frame/preview/Video Master paths use queue or bounded isolated executor.
- [ ] Dependency handling, quota reservation, crash/temp cleanup, fault/load tests.
- [ ] Cloud durable preparation-before-generation, assembly retry, execution version migration.
- [ ] Remote least-privilege database/storage role and supplied-host isolated deployment.
- [ ] Public CI/review, immutable Cloud sync, test-account validation and coordinated production switch.
- [ ] Supplied-host 100-job measurements, old-data/UI verification, release/rollback evidence.

No production readiness or capacity claim follows from the initial local tests.

## Local verification record (2026-10-11)

The public test runner passed 720 tests using a disposable PostgreSQL instance and real FFmpeg 7.1.1 on macOS. A separate admission suite passed the added atomic handoff/fencing checks. Type checking and a Next production build also passed. This is not a Linux-image or production result.

Media fixtures verify decoded-frame identity for copy paths, exact fractional cuts against numbered source frames, VFR timestamp intervals, 24/30 fps normalization to the first source, SAR/rotation/BT.709, continuous original PCM across six sections, and cumulative duration over twenty fractional sections. Queue tests cover concurrent duplicate admission, conflicting keys, stale ownership, cancellation, revoked access, dependencies, explicit retries, restricted worker database permissions, and ambiguous paid-request reconciliation.

Cloud orchestration, exhaustive fault injection, 100-job supplied-host load measurement and the coordinated release are still required. Do not enable admission based only on this record.
