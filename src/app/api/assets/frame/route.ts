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
export const maxDuration = 120;

const requestSchema = z.object({
  projectId: persistedProjectIdSchema,
  assetId: z.string().uuid(),
  time: z.number().finite().min(0).max(6 * 60 * 60),
});

type AssetRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  storage_path: string;
  mime_type: string;
};

type FrameAsset = { id: string; url: string; time: number; mimeType: "image/png" };

const frameJobs = new Map<string, Promise<FrameAsset>>();

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.stderr.on("data", (chunk) => { errorOutput += String(chunk).slice(-4000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || `Video frame capture failed (${code})`));
    });
  });
}

async function existingFrame(projectId: string, sourceAssetId: string, time: number) {
  const rows = await db.prepare(`
    SELECT id, metadata_json
    FROM assets
    WHERE project_id = ? AND kind = 'video_frame'
    ORDER BY created_at DESC
  `).all(projectId) as Array<{ id: string; metadata_json: string }>;
  for (const row of rows) {
    let metadata: { sourceAssetId?: string; time?: number };
    try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { continue; }
    if (metadata.sourceAssetId === sourceAssetId && Math.abs(Number(metadata.time) - time) < 0.000001) {
      return { id: row.id, url: `/api/assets/${row.id}`, time, mimeType: "image/png" as const };
    }
  }
  return null;
}

async function createFrame(source: AssetRow, projectId: string, workspaceId: string, time: number): Promise<FrameAsset> {
  const existing = await existingFrame(projectId, source.id, time);
  if (existing) return existing;
  const workDir = await mkdtemp(join(tmpdir(), "scenelith-frame-"));
  try {
    const inputPath = join(workDir, "source-video");
    const outputPath = join(workDir, "frame.png");
    await writeFile(inputPath, await readStorageObject(source.storage_path));
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", inputPath,
      "-ss", time.toFixed(6), "-map", "0:v:0", "-frames:v", "1", "-an",
      outputPath,
    ]);
    const id = crypto.randomUUID();
    const timeLabel = time.toFixed(3).replace(".", "-");
    const filename = `frame-${timeLabel}s.png`;
    const stored = await saveBytes(
      await readFile(outputPath),
      `workspaces/${workspaceId}/projects/${projectId}/video-frames`,
      filename,
      "image/png",
    );
    const metadata = { sourceAssetId: source.id, time, mediaType: "image", source: "video_frame" };
    await db.prepare(`
      INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at)
      VALUES (?, ?, ?, 'video_frame', 'reference', ?, ?, ?, ?, ?, ?, ?, 'image/png', ?, ?)
    `).run(id, workspaceId, projectId, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash, JSON.stringify(metadata), new Date().toISOString());
    return { id, url: `/api/assets/${id}`, time, mimeType: "image/png" };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose a valid video frame" }, { status: 400 });
  const { projectId, assetId } = parsed.data;
  const time = Math.round(parsed.data.time * 1_000_000) / 1_000_000;
  if (!await userCanAccessProject(auth.user.id, projectId)) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const source = await db.prepare(`
    SELECT id, workspace_id, project_id, storage_path, mime_type
    FROM assets
    WHERE id = ?
  `).get(assetId) as AssetRow | undefined;
  if (!source || !source.mime_type.startsWith("video/") || !await userCanAccessAsset(auth.user.id, source.id)) {
    return Response.json({ error: "Source video not found" }, { status: 404 });
  }

  const key = `${projectId}:${assetId}:${time.toFixed(6)}`;
  const current = frameJobs.get(key);
  if (current) return Response.json({ asset: await current });
  const job = createFrame(source, projectId, project.workspace_id, time).finally(() => frameJobs.delete(key));
  frameJobs.set(key, job);
  try {
    return Response.json({ asset: await job });
  } catch (error) {
    console.error("Video frame could not be captured", { projectId, assetId, time, error });
    return Response.json({ error: "Could not capture this video frame" }, { status: 500 });
  }
}
