import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { db, userCanAccessAsset, userCanAccessProject } from "@/lib/postgres-db";
import { persistedProjectIdSchema } from "@/lib/project-id";
import { readStorageObject, saveBytes } from "@/lib/storage";

export const runtime = "nodejs";

const requestSchema = z.object({
  projectId: persistedProjectIdSchema,
  assetId: z.string().uuid(),
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
  segmentId: z.string().min(1).max(180),
});

type AssetRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  filename: string;
  storage_path: string;
  mime_type: string;
  metadata_json: string;
};

type SegmentAsset = { id: string; url: string; durationSeconds: number };

const segmentJobs = new Map<string, Promise<SegmentAsset>>();

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stderr.on("data", (chunk) => { errorOutput += String(chunk).slice(-4000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || `Video segment export failed (${code})`));
    });
  });
}

async function existingSegment(projectId: string, sourceAssetId: string, start: number, end: number) {
  const rows = await db.prepare(`
    SELECT id, metadata_json
    FROM assets
    WHERE project_id = ? AND kind = 'video_segment'
    ORDER BY created_at DESC
  `).all(projectId) as Array<{ id: string; metadata_json: string }>;
  for (const row of rows) {
    let metadata: { sourceAssetId?: string; start?: number; end?: number };
    try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { continue; }
    if (metadata.sourceAssetId === sourceAssetId
      && Math.abs(Number(metadata.start) - start) < 0.000001
      && Math.abs(Number(metadata.end) - end) < 0.000001) {
      return { id: row.id, url: `/api/assets/${row.id}`, durationSeconds: end - start };
    }
  }
  return null;
}

async function createSegment(source: AssetRow, projectId: string, workspaceId: string, segmentId: string, start: number, end: number): Promise<SegmentAsset> {
  const existing = await existingSegment(projectId, source.id, start, end);
  if (existing) return existing;
  const workDir = await mkdtemp(join(tmpdir(), "scenelith-segment-"));
  try {
    const inputPath = join(workDir, "source-video");
    const outputPath = join(workDir, "segment.mp4");
    await writeFile(inputPath, await readStorageObject(source.storage_path));
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", inputPath,
      "-ss", start.toFixed(6), "-t", (end - start).toFixed(6),
      "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero",
      outputPath,
    ]);
    const id = crypto.randomUUID();
    const filename = `segment-${start.toFixed(6)}-${end.toFixed(6)}.mp4`;
    const stored = await saveBytes(
      await readFile(outputPath),
      `workspaces/${workspaceId}/projects/${projectId}/video-segments`,
      filename,
      "video/mp4",
    );
    const metadata = { sourceAssetId: source.id, segmentId, start, end, duration: end - start, mediaType: "video" };
    await db.prepare(`
      INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at)
      VALUES (?, ?, ?, 'video_segment', 'reference_video', ?, ?, ?, ?, ?, ?, ?, 'video/mp4', ?, ?)
    `).run(id, workspaceId, projectId, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash, JSON.stringify(metadata), new Date().toISOString());
    return { id, url: `/api/assets/${id}`, durationSeconds: end - start };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.end <= parsed.data.start || parsed.data.end - parsed.data.start > 30) {
    return Response.json({ error: "Choose a video segment between 0 and 30 seconds" }, { status: 400 });
  }
  const { projectId, assetId, segmentId } = parsed.data;
  const start = Math.round(parsed.data.start * 1_000_000) / 1_000_000;
  const end = Math.round(parsed.data.end * 1_000_000) / 1_000_000;
  if (!await userCanAccessProject(auth.user.id, projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const source = await db.prepare(`
    SELECT id, workspace_id, project_id, filename, storage_path, mime_type, metadata_json
    FROM assets
    WHERE id = ?
  `).get(assetId) as AssetRow | undefined;
  if (!source || !source.mime_type.startsWith("video/") || !await userCanAccessAsset(auth.user.id, source.id)) {
    return Response.json({ error: "Source video not found" }, { status: 404 });
  }

  const key = `${projectId}:${assetId}:${start.toFixed(6)}:${end.toFixed(6)}`;
  const current = segmentJobs.get(key);
  if (current) return Response.json({ asset: await current });
  const job = createSegment(source, projectId, project.workspace_id, segmentId, start, end).finally(() => segmentJobs.delete(key));
  segmentJobs.set(key, job);
  try {
    return Response.json({ asset: await job });
  } catch (error) {
    console.error("Video segment could not be prepared", { projectId, assetId, start, end, error });
    return Response.json({ error: "Could not prepare this video segment" }, { status: 500 });
  }
}
