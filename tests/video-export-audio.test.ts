import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { renderVideoMasterExport, type VideoMasterRenderSource } from "../src/lib/video-master-render";
import { videoMasterExportRequestSchema } from "../src/lib/video-export";

const exec = promisify(execFile);
const id = "11111111-1111-4111-8111-111111111111";

test("export defaults to selected audio and requires valid original ranges only when requested", () => {
  const request = { projectId: "canvas", filename: "export", assets: [{ id, start: 0, end: 1 }] };
  assert.equal(videoMasterExportRequestSchema.parse(request).audioMode, "selected");
  assert.equal(videoMasterExportRequestSchema.safeParse({ ...request, audioMode: "original" }).success, false);
  assert.equal(videoMasterExportRequestSchema.safeParse({ ...request, audioMode: "original", assets: [{ ...request.assets[0], audio: { id, start: 2, end: 1 } }] }).success, false);
  assert.equal(videoMasterExportRequestSchema.safeParse({ ...request, audioMode: "original", assets: [{ ...request.assets[0], audio: { id, start: 1, end: 2 } }] }).success, true);
  assert.equal(videoMasterExportRequestSchema.safeParse({ ...request, audioMode: "none" }).success, true);
});

test("rendered exports replace, trim and align original audio per scene, or remove it", { timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "export-audio-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "output.mp4");
  const original = join(dir, "original.mp4");
  const silent = join(dir, "silent.mp4");
  const videoArgs = ["-f", "lavfi", "-i", "color=c=green:s=96x160:r=30:d=2"];
  await exec("ffmpeg", ["-y", "-v", "error", ...videoArgs, "-f", "lavfi", "-i", "sine=frequency=220:duration=2:sample_rate=48000", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", output]);
  // Different tones before and after the cut expose accidental audio-start=0.
  await exec("ffmpeg", ["-y", "-v", "error", ...videoArgs, "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000", "-f", "lavfi", "-i", "sine=frequency=880:duration=1:sample_rate=48000", "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", original]);
  await exec("ffmpeg", ["-y", "-v", "error", ...videoArgs, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", silent]);
  const source = (path: string, start = 0, end = 1): VideoMasterRenderSource => ({ id, storage_path: path, mime_type: "video/mp4", start, end });
  async function render(name: string, scenes: VideoMasterRenderSource[], mode: "selected" | "original" | "none") {
    const path = join(dir, name + ".mp4");
    await writeFile(path, await renderVideoMasterExport(scenes, name + ".mp4", mode));
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", path]);
    return { path, probe: JSON.parse(stdout) as { streams: { codec_type: string }[]; format: { duration: string } } };
  }
  async function tone(path: string, start: number) {
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", path, "-ss", String(start), "-t", "0.2", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer" });
    const samples = Array.from({ length: stdout.length / 4 }, (_, i) => stdout.readFloatLE(i * 4));
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    const crossings = samples.slice(1).filter((sample, i) => samples[i] <= 0 && sample > 0).length;
    return { rms, frequency: crossings / (samples.length / 48000) };
  }
  function closeTo(actual: number, expected: number, tolerance = 15) { assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`); }

  const selected = await render("selected", [source(output, .5, 1.5)], "selected");
  closeTo((await tone(selected.path, .2)).frequency, 220);
  closeTo(Number(selected.probe.format.duration), 1, .12);
  // Preserve existing full-scene fast path only when audio is unchanged.
  assert.deepEqual(await renderVideoMasterExport([source(output, 0, 2)], "copy.mp4"), new Uint8Array(await readFile(output)));
  const muted = await render("muted", [source(output, 0, 2)], "none");
  assert.deepEqual(muted.probe.streams.map((stream) => stream.codec_type), ["video"]);
  const mutedTimeline = await render("muted-timeline", [source(output), source(output)], "none");
  assert.deepEqual(mutedTimeline.probe.streams.map((stream) => stream.codec_type), ["video"]);
  closeTo(Number(mutedTimeline.probe.format.duration), 2, .12);

  const single = await render("original-scene", [{ ...source(output), audio: source(original, 1, 2) }], "original");
  closeTo((await tone(single.path, .2)).frequency, 880);
  const timeline = await render("original-timeline", [
    { ...source(output), audio: source(original, 1, 1.5) },
    { ...source(output), audio: source(original, 0, 1) },
    { ...source(output), audio: source(silent) },
  ], "original");
  closeTo(Number(timeline.probe.format.duration), 3, .12);
  closeTo((await tone(timeline.path, .2)).frequency, 880);
  assert.ok((await tone(timeline.path, .75)).rms < .001, "short original audio is padded with silence");
  closeTo((await tone(timeline.path, 1.2)).frequency, 440);
  assert.ok((await tone(timeline.path, 2.2)).rms < .001, "silent original does not keep output audio");
  await assert.rejects(renderVideoMasterExport([source(output)], "missing.mp4", "original"), /Original audio is missing/);
});
