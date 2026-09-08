import sharp from "sharp";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const css = readFileSync("src/app/globals.css", "utf8");

for (const radius of [2, 15, 26]) {
  for (const zoom of [0.5, 1, 1.5]) {
    test(`isolated generation outline preserves pixels at radius ${radius}, zoom ${zoom}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      const original = `<svg class="generator-running-outline" aria-hidden="true"><rect class="generator-running-runner" x="2" y="2" width="calc(100% - 4px)" height="calc(100% - 4px)" rx="${radius}" pathLength="100" /></svg>`;
      const isolated = `<div class="generator-running-outline" aria-hidden="true"><svg class="generator-running-outline-svg"><rect class="generator-running-runner" x="2" y="2" width="calc(100% - 4px)" height="calc(100% - 4px)" rx="${radius}" pathLength="100" /></svg></div>`;
      const show = async (markup: string, original: boolean, offset: number) => {
        await page.setContent(`<style>${css}
          :root { --color-mint:#72ddb7; }
          body { margin:0; background:#151719; }
          .stage { position:absolute;left:12px;top:12px;width:640px;height:430px;transform:scale(${zoom});transform-origin:top left;background:linear-gradient(120deg,#786b7c,#182f25); }
          .generator-running-runner { animation:none; stroke-dashoffset:${offset}; }
          ${original ? ".generator-running-outline{contain:none;transform:none;overflow:visible}" : ""}
        </style><div class="stage">${markup}</div>`);
      };
      // Include straight sections, wrapped dashes, and the corner turns.
      for (const offset of [0, -22, -38, -61, -95]) {
        await show(original, true, offset);
        const before = await page.screenshot();
        await show(isolated, false, offset);
        const after = await page.screenshot();
        // Compositing can round a gradient channel by one 8-bit level at
        // fractional zoom. Reject larger changes, including stroke geometry.
        const a = await sharp(before).raw().toBuffer();
        const b = await sharp(after).raw().toBuffer();
        let maxDifference = 0;
        for (let index = 0; index < a.length; index += 1) {
          maxDifference = Math.max(maxDifference, Math.abs(a[index] - b[index]));
        }
        if (maxDifference > 1) {
          await testInfo.attach("before", { body: before, contentType: "image/png" });
          await testInfo.attach("after", { body: after, contentType: "image/png" });
        }
        expect(maxDifference, `Different pixels at dash offset ${offset}`).toBeLessThanOrEqual(1);
      }
    });
  }
}
