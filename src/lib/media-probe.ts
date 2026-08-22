import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VideoMetadata = {
  durationSeconds?: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
};

function topLevelMp4Atoms(bytes: Buffer) {
  const atoms = new Map<string, number>();
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    let size = Number(bytes.readUInt32BE(offset));
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) break;
      const extendedSize = bytes.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }
    if (size < headerSize || offset + size > bytes.byteLength) break;
    if (!atoms.has(type)) atoms.set(type, offset);
    offset += size;
  }
  return atoms;
}

export function mp4HasFastStart(bytes: ArrayBuffer | Buffer) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(new Uint8Array(bytes));
  const atoms = topLevelMp4Atoms(buffer);
  const moov = atoms.get("moov");
  const mdat = atoms.get("mdat");
  return moov !== undefined && (mdat === undefined || moov < mdat);
}

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg failed (${code})`));
    });
  });
}

export async function optimizeMp4ForStreaming(bytes: ArrayBuffer | Buffer) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(new Uint8Array(bytes));
  if (mp4HasFastStart(input)) return input;
  const workDir = await mkdtemp(join(tmpdir(), "scenelith-video-faststart-"));
  const inputPath = join(workDir, "input.mp4");
  const outputPath = join(workDir, "output.mp4");
  try {
    await writeFile(inputPath, input);
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", inputPath,
      "-map", "0", "-c", "copy", "-movflags", "+faststart", outputPath,
    ]);
    const output = await readFile(outputPath);
    if (!mp4HasFastStart(output)) throw new Error("MP4 metadata could not be moved before media data");
    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runVideoProbe(input: string): Promise<VideoMetadata> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "format=duration:stream=width,height",
      "-of", "json",
      input,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `ffprobe failed (${code})`));
    });
  });
  const parsed = JSON.parse(output) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number }> };
  const durationSeconds = Number(parsed.format?.duration);
  const width = Number(parsed.streams?.[0]?.width);
  const height = Number(parsed.streams?.[0]?.height);
  return {
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : undefined,
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    aspectRatio: Number.isFinite(width / height) && width > 0 && height > 0 ? width / height : undefined,
  };
}

export function probeVideoMetadataUrl(url: string) {
  return runVideoProbe(url);
}

export async function probeVideoMetadata(bytes: ArrayBuffer | Buffer, extension = ".mp4"): Promise<VideoMetadata> {
  const workDir = await mkdtemp(join(tmpdir(), "scenelith-video-probe-"));
  const inputPath = join(workDir, `video${extension || ".mp4"}`);
  try {
    await writeFile(inputPath, Buffer.isBuffer(bytes) ? bytes : Buffer.from(new Uint8Array(bytes)));
    return await runVideoProbe(inputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
