import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const textOverlaySettingsSchema = z.object({
  x: z.number().finite().min(0).max(100).default(50),
  y: z.number().finite().min(0).max(100).default(50),
  fontSize: z.number().finite().min(0).max(300).default(0),
  sizeScale: z.number().finite().min(0.25).max(3).default(1),
  maxWidth: z.number().finite().min(10).max(100).default(90),
  lineHeight: z.number().finite().min(1).max(3).default(80 / 66.37931561026407),
  stroke: z.number().finite().min(0).max(20).default(4.5),
  transparent: z.boolean().default(false),
}).strict();
export type TextOverlaySettings = z.infer<typeof textOverlaySettingsSchema>;

export async function renderTextOverlay(bytes: Buffer, text: string, settings: TextOverlaySettings, signal?: AbortSignal) {
  if (!text.trim() || text.length > 2_000) throw new Error("Overlay text must contain 1–2000 characters");
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Overlay input must be at most 32 MB");
  const config = textOverlaySettingsSchema.parse(settings);
  signal?.throwIfAborted();
  const folder = await mkdtemp(join(tmpdir(), "scenelith-overlay-"));
  try {
    const input = join(folder, "input"), output = join(folder, "result.png"), overlay = join(folder, "overlay.png");
    const job = join(folder, "job.json");
    await writeFile(input, bytes);
    await writeFile(job, JSON.stringify({ input, output, overlay: config.transparent ? overlay : null, text,
      options: { x: config.x, y: config.y, font_size: config.fontSize || null, size_scale: config.sizeScale,
        max_width: config.maxWidth, line_height: config.lineHeight, stroke: config.stroke } }));
    const script = join(/* turbopackIgnore: true */ process.cwd(), "src/lib/text-overlay/render.py");
    const result = await new Promise<string>((resolve, reject) => {
      execFile(/* turbopackIgnore: true */ process.env.SCENELITH_PYTHON || "python3", [script, job], { timeout: 30_000, maxBuffer: 64 * 1024, signal }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Text overlay failed: ${stderr.trim().split("\n").at(-1) || error.message}`));
        else resolve(stdout);
      });
    });
    signal?.throwIfAborted();
    return { image: await readFile(output), overlay: config.transparent ? await readFile(overlay) : null,
      layout: JSON.parse(result) as { width: number; height: number; lines: string[]; bounds: number[]; font_size_px: number } };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
