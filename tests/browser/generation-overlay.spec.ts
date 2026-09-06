import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const css = readFileSync("src/app/globals.css", "utf8");

for (const hasOutput of [false, true]) {
  test(`generation overlay covers the preview ${hasOutput ? "with an existing variation" : "before the first output"}`, async ({ page }) => {
    await page.setContent(`<style>${css}</style>
      <div class="video-master-generator-stage generator-media-stage" style="position:relative;width:600px;height:400px;overflow:hidden;border:0">
        ${hasOutput ? '<video style="display:block;width:600px;height:400px"></video>' : ""}
        <div class="image-generation-state generator-generation-progress video-master-generation-progress">
          <div class="image-generation-frame"><div class="image-generation-shimmer"></div></div>
        </div>
      </div>`);
    const stage = page.locator(".generator-media-stage");
    const overlay = page.locator(".generator-generation-progress");
    await expect(overlay).toHaveCSS("position", "absolute");
    expect(await overlay.boundingBox()).toEqual(await stage.boundingBox());
  });
}
