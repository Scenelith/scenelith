import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "./postgres-db";
import { readStorageObject, saveBytes } from "./storage";

export type VideoDerivativeSource = {
  id: string;
  storage_path: string;
  mime_type: string;
};

export type CapturedFrameAsset = { id: string; url: string; time: number; mimeType: "image/png" };
export type MaterializedSegmentAsset = { id: string; url: string; durationSeconds: number };

const frameJobs = new Map<string, Promise<CapturedFrameAsset>>();
const segmentJobs = new Map<string, Promise<MaterializedSegmentAsset>>();

function runFfmpeg(args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", (chunk) => { errorOutput += String(chunk).slice(-4_000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || `Video derivative failed (${code})`));
    });
  });
}

async function existingFrame(projectId: string, sourceAssetId: string, time: number) {
  const rows = await db.prepare("SELECT id, metadata_json FROM assets WHERE project_id = ? AND kind = 'video_frame' ORDER BY created_at DESC").all(projectId) as Array<{ id: string; metadata_json: string }>;
  for (const row of rows) {
    try {
      const metadata = JSON.parse(row.metadata_json || "{}") as { sourceAssetId?: string; time?: number };
      if (metadata.sourceAssetId === sourceAssetId && Math.abs(Number(metadata.time) - time) < .000001) return { id: row.id, url: `/api/assets/${row.id}`, time, mimeType: "image/png" as const };
    } catch {}
  }
  return null;
}

export async function captureVideoFrameAsset(input: { source: VideoDerivativeSource; projectId: string; workspaceId: string; time: number }) {
  const time = Math.round(input.time * 1_000_000) / 1_000_000;
  const key = `${input.projectId}:${input.source.id}:${time.toFixed(6)}`;
  const running = frameJobs.get(key);
  if (running) return await running;
  const job = (async () => {
    const existing = await existingFrame(input.projectId, input.source.id, time);
    if (existing) return existing;
    const workDir = await mkdtemp(join(tmpdir(), "scenelith-frame-"));
    try {
      const sourcePath = join(workDir, "source-video");
      const outputPath = join(workDir, "frame.png");
      await writeFile(sourcePath, await readStorageObject(input.source.storage_path));
      await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", sourcePath, "-ss", time.toFixed(6), "-map", "0:v:0", "-frames:v", "1", "-an", outputPath], 90_000);
      const id = crypto.randomUUID();
      const filename = `frame-${time.toFixed(3).replace(".", "-")}s.png`;
      const stored = await saveBytes(await readFile(outputPath), `workspaces/${input.workspaceId}/projects/${input.projectId}/video-frames`, filename, "image/png");
      await db.prepare("INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at) VALUES (?, ?, ?, 'video_frame', 'reference', ?, ?, ?, ?, ?, ?, ?, 'image/png', ?, ?)")
        .run(id, input.workspaceId, input.projectId, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash, JSON.stringify({ sourceAssetId: input.source.id, time, mediaType: "image", source: "video_frame" }), new Date().toISOString());
      return { id, url: `/api/assets/${id}`, time, mimeType: "image/png" as const };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  })().finally(() => frameJobs.delete(key));
  frameJobs.set(key, job);
  return await job;
}

async function existingSegment(projectId: string, sourceAssetId: string, start: number, end: number) {
  const rows = await db.prepare("SELECT id, metadata_json FROM assets WHERE project_id = ? AND kind = 'video_segment' ORDER BY created_at DESC").all(projectId) as Array<{ id: string; metadata_json: string }>;
  for (const row of rows) {
    try {
      const metadata = JSON.parse(row.metadata_json || "{}") as { sourceAssetId?: string; start?: number; end?: number };
      if (metadata.sourceAssetId === sourceAssetId && Math.abs(Number(metadata.start) - start) < .000001 && Math.abs(Number(metadata.end) - end) < .000001) return { id: row.id, url: `/api/assets/${row.id}`, durationSeconds: end - start };
    } catch {}
  }
  return null;
}

export async function materializeVideoSegmentAsset(input: { source: VideoDerivativeSource; projectId: string; workspaceId: string; segmentId: string; start: number; end: number }) {
  const start = Math.round(input.start * 1_000_000) / 1_000_000;
  const end = Math.round(input.end * 1_000_000) / 1_000_000;
  if (start < 0 || end <= start || end - start > 30) throw new Error("Choose a video segment between 0 and 30 seconds");
  const key = `${input.projectId}:${input.source.id}:${start.toFixed(6)}:${end.toFixed(6)}`;
  const running = segmentJobs.get(key);
  if (running) return await running;
  const job = (async () => {
    const existing = await existingSegment(input.projectId, input.source.id, start, end);
    if (existing) return existing;
    const workDir = await mkdtemp(join(tmpdir(), "scenelith-segment-"));
    try {
      const sourcePath = join(workDir, "source-video");
      const outputPath = join(workDir, "segment.mp4");
      await writeFile(sourcePath, await readStorageObject(input.source.storage_path));
      await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", sourcePath, "-ss", start.toFixed(6), "-t", (end - start).toFixed(6), "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", outputPath], 120_000);
      const id = crypto.randomUUID();
      const filename = `segment-${start.toFixed(6)}-${end.toFixed(6)}.mp4`;
      const stored = await saveBytes(await readFile(outputPath), `workspaces/${input.workspaceId}/projects/${input.projectId}/video-segments`, filename, "video/mp4");
      await db.prepare("INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at) VALUES (?, ?, ?, 'video_segment', 'reference_video', ?, ?, ?, ?, ?, ?, ?, 'video/mp4', ?, ?)")
        .run(id, input.workspaceId, input.projectId, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash, JSON.stringify({ sourceAssetId: input.source.id, segmentId: input.segmentId, start, end, duration: end - start, mediaType: "video" }), new Date().toISOString());
      return { id, url: `/api/assets/${id}`, durationSeconds: end - start };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  })().finally(() => segmentJobs.delete(key));
  segmentJobs.set(key, job);
  return await job;
}
