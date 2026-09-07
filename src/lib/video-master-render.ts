import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStorageObject } from "@/lib/storage";
import type { VideoMasterExportAudioMode } from "@/lib/video-export";

export type VideoMasterRenderSource = {
  id: string;
  storage_path: string;
  mime_type: string;
  start: number;
  end: number;
  audio?: Omit<VideoMasterRenderSource, "audio">;
};

type MediaProbe = {
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
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
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", inputPath,
  ], 30_000);
  const probe = JSON.parse(output || "{}") as MediaProbe;
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  return {
    width: Math.max(2, Math.floor(Number(video?.width || 720) / 2) * 2),
    height: Math.max(2, Math.floor(Number(video?.height || 1280) / 2) * 2),
    duration: Math.max(.1, Number(probe.format?.duration || 0)),
    hasAudio: Boolean(probe.streams?.some((stream) => stream.codec_type === "audio")),
    audioCodec: probe.streams?.find((stream) => stream.codec_type === "audio")?.codec_name,
  };
}

function time(value: number) {
  return Math.max(0, value).toFixed(6);
}

export async function renderVideoMasterExport(sources: VideoMasterRenderSource[], filename: string, audioMode: VideoMasterExportAudioMode = "selected") {
  if (!sources.length) throw new Error("Choose at least one video scene");
  if (audioMode === "original" && sources.some((source) => !source.audio)) throw new Error("Original audio is missing for a scene");
  const workDir = await mkdtemp(join(tmpdir(), "scenelith-export-"));
  try {
    const media: Array<{ path: string; probe: Awaited<ReturnType<typeof probeMedia>> }> = [];
    const mediaIndexes = new Map<string, number>();
    async function loadMedia(source: VideoMasterRenderSource) {
      const cached = mediaIndexes.get(source.storage_path);
      if (cached !== undefined) return cached;
      const index = media.length;
      const path = join(workDir, `${index}.source`);
      await writeFile(path, await readStorageObject(source.storage_path));
      media.push({ path, probe: await probeMedia(path) });
      mediaIndexes.set(source.storage_path, index);
      return index;
    }
    const inputs = [];
    let requestedDuration = 0;
    let timelineFrames = 0;
    for (const source of sources) {
      const videoIndex = await loadMedia(source);
      const { path, probe } = media[videoIndex];
      const start = Math.min(probe.duration, Math.max(0, source.start));
      const end = Math.min(probe.duration, Math.max(start + .001, source.end));
      const audioSource = audioMode === "original" ? source.audio! : source;
      const audioIndex = audioMode === "none" ? videoIndex : await loadMedia(audioSource);
      const audioProbe = media[audioIndex].probe;
      const audioStart = Math.min(audioProbe.duration, Math.max(0, audioSource.start));
      const audioDuration = Math.max(0, Math.min(audioProbe.duration, audioSource.end) - audioStart);
      const sourceDuration = Math.max(.001, end - start);
      requestedDuration += sourceDuration;
      const nextFrame = Math.max(timelineFrames + 1, Math.round(requestedDuration * 30));
      const frameCount = nextFrame - timelineFrames;
      timelineFrames = nextFrame;
      inputs.push({ path, source, probe, videoIndex, audioIndex, audioStart, audioDuration,
        hasAudio: audioProbe.hasAudio && audioDuration > 0, start, end, sourceDuration,
        frameCount, duration: frameCount / 30 });
    }

    const only = inputs[0];
    if (audioMode === "selected" && inputs.length === 1 && only.source.mime_type === "video/mp4" && only.start <= .001 && only.end >= only.probe.duration - .03) {
      return new Uint8Array(await readFile(only.path));
    }

    const outputPath = join(workDir, filename);
    const canvas = inputs[0].probe;
    const filters: string[] = [];
    // Quantize cumulative boundaries, not each clip independently. Otherwise
    // mixed source frame rates can add a frame and move the sound at every cut.
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      filters.push(`[${input.videoIndex}:v:0]trim=start=${time(input.start)}:duration=${time(input.sourceDuration)},setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30:start_time=0,tpad=stop_mode=clone:stop_duration=${time(input.duration)},trim=end_frame=${input.frameCount},setpts=N/(30*TB),format=yuv420p[v${index}]`);
    }
    if (inputs.length === 1) filters.push("[v0]null[vout]");
    else filters.push(`${inputs.map((_, index) => `[v${index}]`).join("")}concat=n=${inputs.length}:v=1:a=0[vout]`);

    const withAudio = audioMode !== "none";
    let copyAudioIndex: number | undefined;
    if (withAudio) {
      const groups: Array<{ audioIndex: number; start: number; end: number; samples: number; hasAudio: boolean; followsSource: boolean }> = [];
      for (const input of inputs) {
        const followsSource = Math.abs(input.audioDuration - input.sourceDuration) <= 1 / 30;
        const previous = groups.at(-1);
        // Adjacent scenes from one original must share one resample/trim path.
        // Keep separate groups for reordered cuts and intentional silence pads.
        if (audioMode === "original" && previous?.hasAudio && input.hasAudio
          && previous.audioIndex === input.audioIndex && previous.followsSource && followsSource
          && Math.abs(previous.end - input.audioStart) <= 1 / 48000) {
          previous.end = input.audioStart + input.audioDuration;
          previous.samples += input.frameCount * 1600;
        } else {
          groups.push({ audioIndex: input.audioIndex, start: input.audioStart,
            end: input.audioStart + input.audioDuration, samples: input.frameCount * 1600,
            hasAudio: input.hasAudio, followsSource });
        }
      }
      const onlyAudio = groups[0];
      const originalProbe = media[onlyAudio.audioIndex].probe;
      if (audioMode === "original" && groups.length === 1 && onlyAudio.hasAudio
        && originalProbe.audioCodec === "aac" && onlyAudio.start <= .001
        && onlyAudio.end >= originalProbe.duration - .001
        && Math.abs(timelineFrames / 30 - originalProbe.duration) <= 1 / 30) {
        // A complete original AAC track already has its timing and encoder
        // priming metadata. Keep it intact instead of decoding at scene cuts.
        copyAudioIndex = onlyAudio.audioIndex;
      } else {
        groups.forEach((group, index) => {
          filters.push(group.hasAudio
            ? `[${group.audioIndex}:a:0]aresample=48000:async=1:first_pts=0,atrim=start_sample=${Math.round(group.start * 48000)}:end_sample=${Math.round(group.end * 48000)},asetpts=N/SR/TB,apad=whole_len=${group.samples},atrim=end_sample=${group.samples}[a${index}]`
            : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=${group.samples},asetpts=N/SR/TB[a${index}]`);
        });
        if (groups.length === 1) filters.push("[a0]anull[aout]");
        else filters.push(`${groups.map((_, index) => `[a${index}]`).join("")}concat=n=${groups.length}:v=0:a=1[aout]`);
      }
    }

    await runProcess("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      ...media.flatMap((input) => ["-i", input.path]),
      "-filter_complex", filters.join(";"), "-map", "[vout]",
      ...(copyAudioIndex !== undefined
        ? ["-map", `${copyAudioIndex}:a:0`, "-c:a", "copy"]
        : withAudio ? ["-map", "[aout]", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k"] : ["-an"]),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", "30", "-fps_mode", "cfr",
      "-movflags", "+faststart", "-max_muxing_queue_size", "1024", outputPath,
    ]);
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
