import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const css = readFileSync("src/app/globals.css", "utf8");

for (const hasOutput of [false, true]) {
  test(`generation overlay covers the preview ${hasOutput ? "with an existing variation" : "before the first output"}`, async ({ page }) => {
    await page.setContent(`<style>${css}</style>
      <div class="video-master-generator-stage generator-media-stage is-generating" style="position:relative;width:600px;height:400px;overflow:hidden;border:0">
        <div class="video-master-media-viewport">
        <div class="inline-video-player inline-video-scene controls-external">
          ${hasOutput ? '<video class="inline-video-deck" data-active-deck="true" style="background:green"></video>' : '<img class="inline-video-deck inline-video-poster" data-active-deck="true" alt="Original" />'}
        </div>
        <div class="image-generation-state generator-generation-progress video-master-generation-progress">
          <div class="image-generation-frame"><div class="image-generation-shimmer"></div></div>
        </div>
      </div></div>`);
    const stage = page.locator(".generator-media-stage");
    const overlay = page.locator(".generator-generation-progress");
    await expect(overlay).toHaveCSS("position", "absolute");
    expect(await overlay.boundingBox()).toEqual(await stage.boundingBox());
    expect(await overlay.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);

  });
}
