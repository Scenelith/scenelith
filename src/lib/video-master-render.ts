import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStorageObject } from "@/lib/storage";

export type VideoMasterRenderSource = {
  id: string;
  storage_path: string;
  mime_type: string;
  start: number;
  end: number;
};

type MediaProbe = {
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  format?: { duration?: string };
};

function runProcess(command: string, args: string[], timeoutMs = 600_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${String(chunk)}`.slice(-8000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error(errorOutput.trim() || `${command} failed (${code})`));
    });
  });
}

async function probeMedia(inputPath: string) {
  const output = await runProcess("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", inputPath,
  ], 30_000);
  const probe = JSON.parse(output || "{}") as MediaProbe;
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  return {
    width: Math.max(2, Math.floor(Number(video?.width || 720) / 2) * 2),
    height: Math.max(2, Math.floor(Number(video?.height || 1280) / 2) * 2),
    duration: Math.max(.1, Number(probe.format?.duration || 0)),
    hasAudio: Boolean(probe.streams?.some((stream) => stream.codec_type === "audio")),
  };
}

function time(value: number) {
  return Math.max(0, value).toFixed(6);
}

export async function renderVideoMasterExport(sources: VideoMasterRenderSource[], filename: string) {
  if (!sources.length) throw new Error("Choose at least one video scene");
  const workDir = await mkdtemp(join(tmpdir(), "scenelith-export-"));
  try {
    const inputs = [] as Array<{ path: string; source: VideoMasterRenderSource; probe: Awaited<ReturnType<typeof probeMedia>>; start: number; end: number; duration: number }>;
    for (let index = 0; index < sources.length; index += 1) {
      const path = join(workDir, `${String(index).padStart(2, "0")}.source`);
      await writeFile(path, await readStorageObject(sources[index].storage_path));
      const probe = await probeMedia(path);
      const start = Math.min(probe.duration, Math.max(0, sources[index].start));
      const end = Math.min(probe.duration, Math.max(start + .001, sources[index].end));
      inputs.push({ path, source: sources[index], probe, start, end, duration: Math.max(.001, end - start) });
    }

    const only = inputs[0];
    if (inputs.length === 1 && only.source.mime_type === "video/mp4" && only.start <= .001 && only.end >= only.probe.duration - .03) {
      return new Uint8Array(await readFile(only.path));
    }

    const outputPath = join(workDir, filename);
    const canvas = inputs[0].probe;
    const filters: string[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      filters.push(`[${index}:v:0]trim=start=${time(input.start)}:duration=${time(input.duration)},setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${index}]`);
      filters.push(input.probe.hasAudio
        ? `[${index}:a:0]atrim=start=${time(input.start)}:duration=${time(input.duration)},asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,apad,atrim=duration=${time(input.duration)}[a${index}]`
        : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${time(input.duration)},asetpts=PTS-STARTPTS[a${index}]`);
    }
    if (inputs.length === 1) filters.push("[v0]null[vout]", "[a0]anull[aout]");
    else filters.push(`${inputs.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);

    await runProcess("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts",
      ...inputs.flatMap((input) => ["-i", input.path]),
      "-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k",
      "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", "-max_muxing_queue_size", "1024", outputPath,
    ]);
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
