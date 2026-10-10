import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Keep the video bitstream; normalize AAC/SBR audio for browser decoders. */
export async function normalizeVideoPlayback(bytes: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'scenelith-playback-'));
  try {
    const input = join(dir, 'input'), output = join(dir, 'preview.mp4');
    await writeFile(input, bytes);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input,
        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac',
        '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '128k',
        '-movflags', '+faststart', output], {stdio:['ignore','ignore','pipe']});
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr || 'Video playback preparation failed')); });
    });
    return await readFile(output);
  } finally { await rm(dir, {recursive:true, force:true}); }
}
