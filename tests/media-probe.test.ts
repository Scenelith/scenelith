import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mp4HasFastStart, optimizeMp4ForStreaming, probeVideoMetadata } from "../src/lib/media-probe";

test("generated MP4 files move metadata before media data without re-encoding", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scenelith-faststart-test-"));
  const source = join(workDir, "source.mp4");
  try {
    const generated = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const input = await readFile(source);
    assert.equal(mp4HasFastStart(input), false);
    const output = await optimizeMp4ForStreaming(input);
    assert.equal(mp4HasFastStart(output), true);
    const metadata = await probeVideoMetadata(output);
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 32);
    assert.ok(Number(metadata.durationSeconds) > 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
