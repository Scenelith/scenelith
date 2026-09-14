import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { renderTextOverlay, textOverlaySettingsSchema } from "../src/lib/text-overlay/render";

const settings = textOverlaySettingsSchema.parse({ transparent: true, fontSize: 34 });
test("text renderer preserves dimensions, manual breaks, Cyrillic and pixels outside the text", async () => {
  const original = await sharp({ create: { width: 600, height: 800, channels: 4, background: "#709080" } }).png().toBuffer();
  const result = await renderTextOverlay(original, "Первая строка\\nSecond line", settings);
  assert.deepEqual(result.layout.lines, ["Первая строка", "Second line"]);
  assert.deepEqual([result.layout.width, result.layout.height], [600, 800]);
  const [before, after, overlay] = await Promise.all([sharp(original).raw().toBuffer(), sharp(result.image).raw().toBuffer(), sharp(result.overlay!).raw().toBuffer()]);
  const [left, top, right, bottom] = result.layout.bounds;
  let changed = 0;
  for (let y = 0; y < 800; y++) for (let x = 0; x < 600; x++) {
    const offset = (y * 600 + x) * 4;
    if (x < left || x >= right || y < top || y >= bottom) {
      assert.ok(before.subarray(offset, offset + 4).equals(after.subarray(offset, offset + 4)));
      assert.equal(overlay[offset + 3], 0);
    } else if (!before.subarray(offset, offset + 4).equals(after.subarray(offset, offset + 4))) changed++;
  }
  assert.ok(changed > 100);
});
test("text renderer wraps and rejects cropped text, invalid numbers and cancelled jobs", async () => {
  const bytes = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#808080" } }).png().toBuffer();
  const wrapped = await renderTextOverlay(bytes, "A long sentence with several words that must wrap", settings);
  assert.ok(wrapped.layout.lines.length > 1);
  await assert.rejects(renderTextOverlay(bytes, "Too close to the top", { ...settings, y: 0 }), /края/);
  await assert.rejects(renderTextOverlay(bytes, "a".repeat(2001), settings), /2000/);
  assert.throws(() => textOverlaySettingsSchema.parse({ x: NaN }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(renderTextOverlay(bytes, "Cancelled", settings, controller.signal));
});
