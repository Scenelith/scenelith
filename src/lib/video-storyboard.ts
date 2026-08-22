import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStorageObject } from "./storage";

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg failed (${code})`));
    });
  });
}

export async function extractPromptStoryboard(input: { path: string; mimeType: string; durationSeconds?: number; frameCount?: number }) {
  const duration = Math.max(.1, Number(input.durationSeconds || 0));
  const frameCount = Math.min(6, Math.max(3, input.frameCount || 5));
  const extension = input.mimeType.includes("webm") ? ".webm" : input.mimeType.includes("quicktime") ? ".mov" : ".mp4";
  const directory = await mkdtemp(join(tmpdir(), "scenelith-prompt-storyboard-"));
  const sourcePath = join(directory, `source${extension}`);
  try {
    await writeFile(sourcePath, await readStorageObject(input.path));
    const positions = Array.from({ length: frameCount }, (_, index) => duration > .1
      ? Math.min(Math.max(0, duration - .04), duration * (.06 + (.88 * index) / Math.max(1, frameCount - 1)))
      : index * .15);
    const frames: Array<{ timeSeconds: number; dataUrl: string }> = [];
    for (const [index, timeSeconds] of positions.entries()) {
      const outputPath = join(directory, `frame-${index + 1}.jpg`);
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-ss", timeSeconds.toFixed(3), "-i", sourcePath,
        "-frames:v", "1", "-vf", "scale=640:-2:force_original_aspect_ratio=decrease", "-q:v", "3", "-y", outputPath,
      ]);
      const bytes = await readFile(outputPath);
      frames.push({ timeSeconds, dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` });
    }
    return frames;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
