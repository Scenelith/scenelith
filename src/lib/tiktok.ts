import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { db } from "./postgres-db";
import { downloadToStorage, putStorageObject, readStorageObject, statStorageObject, type StoredObject } from "./storage";
import { concurrencyGate } from "./concurrency-gate";
import { DEFAULT_VIDEO_SCENE_SCORE, normalizeVideoSceneBoundaries, type VideoSceneCandidate } from "./video-scenes";

const runVideoSceneAnalysis = concurrencyGate(
  "tiktok-video-scene-analysis",
  Number(process.env.VIDEO_SCENE_ANALYSIS_CONCURRENCY || 2),
);

type TikwmData = {
  id?: string;
  title?: string;
  duration?: number;
  cover?: string;
  play?: string;
  wmplay?: string;
  images?: string[];
  author?: { unique_id?: string; nickname?: string };
  play_count?: number;
  digg_count?: number;
  comment_count?: number;
  share_count?: number;
  collect_count?: number;
  create_time?: number;
};

async function resolveTikTok(url: string) {
  const response = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
    headers: { "user-agent": "Mozilla/5.0 Frameflow/1.0" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`TikTok resolver returned ${response.status}`);
  const payload = (await response.json()) as { code?: number; msg?: string; data?: TikwmData };
  if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || "Could not resolve this TikTok post");
  return payload.data;
}

function postDetails(data: TikwmData, url: string) {
  return {
    id: data.id || null,
    title: data.title || "TikTok study",
    author: data.author?.unique_id || data.author?.nickname || "unknown",
    sourceUrl: url,
    publishedAt: data.create_time ? new Date(data.create_time * 1000).toISOString() : null,
    stats: {
      views: Number(data.play_count || 0),
      likes: Number(data.digg_count || 0),
      comments: Number(data.comment_count || 0),
      shares: Number(data.share_count || 0),
      saves: Number(data.collect_count || 0),
    },
  };
}

export async function fetchTikTokStats(url: string) {
  return postDetails(await resolveTikTok(url), url);
}

function runProcess(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => (errorText += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(errorText.slice(-1200) || `${command} exited with ${code}`)),
    );
  });
}

function runProcessOutput(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(stderr.slice(-1600) || `${command} exited with ${code}`)));
  });
}

export type ImportedAsset = {
  id: string;
  kind: "slide" | "scene" | "video";
  role: string;
  url: string;
  filename: string;
  metadata: Record<string, unknown>;
};

function parseSceneMetadata(output: string) {
  const candidates: VideoSceneCandidate[] = [];
  const blocks = output.split(/(?=frame:\d+\s)/g);
  for (const block of blocks) {
    const frame = Number(block.match(/frame:(\d+)/)?.[1]);
    const time = Number(block.match(/pts_time:([\d.]+)/)?.[1]);
    const score = Number(block.match(/lavfi\.scene_score=([\d.]+)/)?.[1] || 0);
    if (Number.isFinite(frame) && Number.isFinite(time) && time > 0) candidates.push({ frame, time, score });
  }
  return candidates;
}

async function insertAsset(input: {
  projectId: string;
  kind: ImportedAsset["kind"];
  role: string;
  filename: string;
  stored: StoredObject;
  mime: string;
  metadata?: Record<string, unknown>;
}): Promise<ImportedAsset> {
  const id = crypto.randomUUID();
  const metadata = input.metadata || {};
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(input.projectId) as { workspace_id: string } | undefined;
  if (!project?.workspace_id) throw new Error("Imported asset project has no workspace");
  await db.prepare(
    `INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project.workspace_id,
    input.projectId,
    input.kind,
    input.role,
    input.filename,
    input.stored.reference,
    input.stored.provider,
    input.stored.bucket,
    input.stored.key,
    input.stored.size,
    input.stored.contentHash,
    input.mime,
    JSON.stringify(metadata),
    new Date().toISOString(),
  );
  return { id, kind: input.kind, role: input.role, url: `/api/assets/${id}`, filename: input.filename, metadata };
}

async function extractScenes(videoPath: string, projectId: string, importGroup: string, sceneDir: string, hintedDuration = 0) {
  await mkdir(sceneDir, { recursive: true });
  const pattern = join(sceneDir, "scene-%03d.jpg");
  const durationProbe = await runProcessOutput("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
  ]).catch(() => ({ stdout: String(hintedDuration || 0), stderr: "" }));
  const duration = Math.max(0.04, Number(durationProbe.stdout.trim()) || hintedDuration || 0.04);
  // First inspect every decoded presentation frame. Keeping the full score
  // stream lets the normalizer choose the strongest exact frame around a cut
  // instead of inheriting an approximate thumbnail timestamp.
  const detected = await runProcessOutput("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-vf",
    "select='gte(scene,0)',metadata=print:file=-",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const segments = normalizeVideoSceneBoundaries(parseSceneMetadata(detected.stdout), duration, {
    minimumScore: DEFAULT_VIDEO_SCENE_SCORE,
    maximumScenes: 80,
  });
  const selectedFrames = segments.map((segment) => Math.max(0, Number(segment.frame || 0)));
  const frameExpression = selectedFrames.map((frame) => `eq(n\\,${frame})`).join("+") || "eq(n\\,0)";
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", videoPath,
    "-vf", `select='${frameExpression}',scale=720:-2`,
    "-fps_mode", "vfr", "-frames:v", String(Math.max(1, segments.length)), "-q:v", "2", pattern,
  ]);
  let files = (await readdir(sceneDir)).filter((file) => file.endsWith(".jpg")).sort().slice(0, segments.length);
  if (!files.length) {
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0", "-i", videoPath, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "2", pattern]);
    files = (await readdir(sceneDir)).filter((file) => file.endsWith(".jpg")).sort().slice(0, 1);
  }
  const imported: ImportedAsset[] = [];
  for (const [index, filename] of files.entries()) {
    const segment = segments[index] || {
      index: index + 1,
      start: index ? Math.min(duration, index / files.length * duration) : 0,
      end: Math.min(duration, (index + 1) / files.length * duration),
      confidence: 0,
    };
    const stored = await putStorageObject(await readFile(join(sceneDir, filename)), join(importGroup, "scenes", filename), { contentType: "image/jpeg" });
    imported.push(await insertAsset({
      projectId,
      kind: "scene",
      role: index === 0 ? "hook" : index === files.length - 1 ? "cta" : "scene",
      filename,
      stored,
      mime: "image/jpeg",
      metadata: { ...segment, duration },
    }));
  }
  // A tiled dense contact sheet stays small on disk but remains temporally
  // useful when the browser timeline is zoomed in for frame-level adjustment.
  const timelineFrameCount = Math.max(24, Math.min(600, Math.ceil(duration * 15)));
  const timelineColumns = Math.min(30, timelineFrameCount);
  const timelineRows = Math.ceil(timelineFrameCount / timelineColumns);
  const timelineDir = join(sceneDir, "timeline");
  const timelinePath = join(timelineDir, "timeline-sprite.jpg");
  await mkdir(timelineDir, { recursive: true });
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", videoPath,
    "-vf", `fps=${timelineFrameCount / duration},scale=-2:72,tile=${timelineColumns}x${timelineRows}:padding=0:margin=0`,
    "-frames:v", "1", "-q:v", "3", timelinePath,
  ]);
  const timelineStored = await putStorageObject(await readFile(timelinePath), join(importGroup, "timeline", "timeline-sprite.jpg"), { contentType: "image/jpeg" });
  const timelineAsset = await insertAsset({
    projectId,
    kind: "scene",
    role: "timeline",
    filename: "timeline-sprite.jpg",
    stored: timelineStored,
    mime: "image/jpeg",
    metadata: { timelineSprite: true, frameCount: timelineFrameCount, columns: timelineColumns, rows: timelineRows, duration },
  });
  return { assets: imported, timelineAsset, duration };
}

export async function importTikTok(url: string, projectId: string) {
  const data = await resolveTikTok(url);
  const images = data.images || [];
  const assets: ImportedAsset[] = [];
  // Every post gets its own directory so a later import can never overwrite
  // slide-01.jpg, source.mp4, or extracted scene names from an earlier post.
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project?.workspace_id) throw new Error("Import project has no workspace");
  const importGroup = join("workspaces", project.workspace_id, "projects", projectId, "imports", crypto.randomUUID());

  if (images.length) {
    for (const [index, imageUrl] of images.entries()) {
      const filename = `slide-${String(index + 1).padStart(2, "0")}.jpg`;
      const downloaded = await downloadToStorage(imageUrl, importGroup, filename);
      assets.push(
        await insertAsset({
          projectId,
          kind: "slide",
          role: index === 0 ? "hook" : index === images.length - 1 ? "cta" : "slide",
          filename,
          stored: downloaded.stored,
          mime: downloaded.contentType,
          metadata: { index: index + 1, sourceImageUrl: imageUrl },
        }),
      );
    }
  } else {
    const videoUrl = data.play || data.wmplay;
    if (!videoUrl) throw new Error("Resolver returned no slideshow images or playable video");
    const downloaded = await downloadToStorage(videoUrl, importGroup, "source.mp4");
    const videoAsset = await insertAsset({
      projectId,
      kind: "video",
      role: "source",
      filename: "source.mp4",
      stored: downloaded.stored,
      mime: downloaded.contentType.startsWith("video/") ? downloaded.contentType : "video/mp4",
      metadata: { duration: data.duration || 0 },
    });
    assets.push(videoAsset);
    const extracted = await runVideoSceneAnalysis(async () => {
      const workDir = await mkdtemp(join(tmpdir(), "scenelith-import-"));
      try {
        const localVideo = join(workDir, "source.mp4");
        await writeFile(localVideo, await readStorageObject(downloaded.path));
        return await extractScenes(localVideo, projectId, importGroup, join(workDir, "scenes"), data.duration || 0);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
    videoAsset.metadata = { ...videoAsset.metadata, duration: extracted.duration, sceneCount: extracted.assets.length };
    await db.prepare("UPDATE assets SET metadata_json = ? WHERE id = ?").run(JSON.stringify(videoAsset.metadata), videoAsset.id);
    assets.push(...extracted.assets, extracted.timelineAsset);
  }

  const size = await Promise.all(assets.map(async (asset) => {
    const row = await db.prepare("SELECT storage_path FROM assets WHERE id = ?").get(asset.id) as { storage_path: string };
    return (await statStorageObject(row.storage_path)).size;
  }));

  return {
    post: {
      ...postDetails(data, url),
      mediaType: images.length ? "slideshow" : "video",
      totalBytes: size.reduce((sum, item) => sum + item, 0),
    },
    assets,
  };
}
