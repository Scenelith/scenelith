import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { renderVideoMasterExport, type VideoMasterRenderSource } from "../src/lib/video-master-render";

const exec = promisify(execFile);
const source = (path: string, start: number, end: number): VideoMasterRenderSource => ({ id: path, storage_path: path, mime_type: "video/mp4", start, end });

async function pcm(path: string) {
  const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  return Array.from({ length: stdout.length / 4 }, (_, index) => stdout.readFloatLE(index * 4));
}

async function videoFrames(path: string) {
  const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", path, "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
  return Array.from({ length: stdout.length / 3 }, (_, index) => [...stdout.subarray(index * 3, index * 3 + 3)]);
}

test("mixed-rate scenes cut on the planned frame and keep contiguous original sound uninterrupted", { timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "export-seam-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const red = join(dir, "red.mp4"), blue = join(dir, "blue.mp4"), original = join(dir, "original.mp4");
  for (const [path, color, duration] of [[red, "red", "6"], [blue, "blue", "4"]]) {
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=96x160:r=24:d=${duration}`, "-c:v", "libx264", "-output_ts_offset", "0.041667", path]);
  }
  // A continuous chirp exposes timing jumps that constant-tone checks miss.
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=96x160:r=30:d=8.933333", "-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*(180*t+31*t*t)):s=44100:d=8.934", "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", original]);
  const clips = [
    { ...source(red, 0, 5.3), audio: source(original, 0, 5.3) },
    { ...source(blue, 0, 3.634), audio: source(original, 5.3, 8.934) },
  ];
  const output = join(dir, "joined.mp4");
  await writeFile(output, await renderVideoMasterExport(clips, "joined.mp4", "original"));
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time,duration,nb_frames:format=duration", "-of", "json", output]);
  const probe = JSON.parse(stdout) as { streams: { codec_type: string; start_time: string; duration: string; nb_frames: string }[]; format: { duration: string } };
  const video = probe.streams.find((stream) => stream.codec_type === "video")!;
  assert.equal(Number(video.nb_frames), 268);
  assert.equal(Number(video.start_time), 0);
  assert.ok(Math.abs(Number(video.duration) - 268 / 30) < .001);
  assert.ok(Math.abs(Number(probe.format.duration) - 268 / 30) < .001);
  const frames = await videoFrames(output);
  assert.equal(frames.length, 268);
  assert.ok(frames[158][0] > 200 && frames[158][2] < 20, "last first-scene frame is red");
  assert.ok(frames[159][2] > 200 && frames[159][0] < 20, "second scene starts at exactly 5.3 seconds");
  const expected = await pcm(original), actual = await pcm(output);
  for (const seconds of [1, 5.15, 5.28, 5.31, 5.4, 7]) {
    const offset = Math.round(seconds * 48000), length = 4800;
    let dot = 0, expectedPower = 0, actualPower = 0;
    for (let i = offset; i < offset + length; i++) {
      dot += expected[i] * actual[i];
      expectedPower += expected[i] ** 2;
      actualPower += actual[i] ** 2;
    }
    const correlation = dot / Math.sqrt(expectedPower * actualPower);
    assert.ok(correlation > .98, `original audio must keep the same position across the cut at ${seconds}s (correlation ${correlation})`);
  }

  const hashes = async (path: string) => {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=data_hash", "-of", "json", path]);
    return (JSON.parse(stdout).packets as { data_hash: string }[]).map((packet) => packet.data_hash);
  };
  assert.deepEqual(await hashes(output), await hashes(original), "a full original AAC track is preserved byte for byte");

  const excerpt = join(dir, "excerpt.mp4");
  await writeFile(excerpt, await renderVideoMasterExport([
    { ...source(red, 0, 1.3), audio: source(original, .5, 1.8) },
    { ...source(blue, 0, 1.7), audio: source(original, 1.8, 3.5) },
  ], "excerpt.mp4", "original"));
  const excerptAudio = await pcm(excerpt);
  for (const seconds of [1.2, 1.28, 1.31, 1.4]) {
    const offset = Math.round(seconds * 48000);
    let dot = 0, expectedPower = 0, actualPower = 0;
    for (let i = offset; i < offset + 4800; i++) {
      dot += expected[i + 24000] * excerptAudio[i];
      expectedPower += expected[i + 24000] ** 2;
      actualPower += excerptAudio[i] ** 2;
    }
    assert.ok(dot / Math.sqrt(expectedPower * actualPower) > .98, `trimmed original stays continuous at ${seconds}s`);
  }

  // Cumulative quantization retains the frame carried across fractional cuts.
  const fractional = join(dir, "fractional.mp4");
  await writeFile(fractional, await renderVideoMasterExport([source(red, 0, .11), source(blue, 0, .11), source(red, 0, .11)], "fractional.mp4", "none"));
  const fractionalFrames = await videoFrames(fractional);
  assert.equal(fractionalFrames.length, 10);
  assert.ok(fractionalFrames[2][0] > 200 && fractionalFrames[3][2] > 200);
  assert.ok(fractionalFrames[6][2] > 200 && fractionalFrames[7][0] > 200);
});
