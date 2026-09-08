import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

let fixture: string;
test.beforeAll(async () => {
  fixture = (await build({ entryPoints: ["tests/browser/fixtures/node-placement.tsx"], absWorkingDir: process.cwd(), tsconfig: path.resolve("tsconfig.json"), bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
});

test("actual generator cards stay separated after create, portrait configuration and first result", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1500 });
  await page.setContent(`<style>${readFileSync("node_modules/@xyflow/react/dist/style.css", "utf8")}${readFileSync("src/app/globals.css", "utf8")}${readFileSync("src/app/theme.css", "utf8")} body{margin:0}</style><div id="root"></div>`);
  await page.addScriptTag({ content: fixture });
  await page.getByRole("button", { name: "Create column" }).click();
  const cards = page.locator(".frame-node--generator");
  await expect(cards).toHaveCount(4);
  const assertSeparated = async () => {
    const bounds = await cards.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      const history = element.querySelector(".generator-output-history")?.getBoundingClientRect();
      return { x: box.x - 8, right: box.right + 8, y: box.y - 24, bottom: Math.max(box.bottom + 16, history?.bottom || 0) };
    }));
    for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) {
      const a = bounds[i], b = bounds[j];
      expect(a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y, `cards ${i},${j} overlap`).toBe(false);
    }
  };
  await assertSeparated();
  const firstBefore = await cards.first().boundingBox();
  await page.getByRole("button", { name: "Make portrait" }).click();
  await expect.poll(async () => (await cards.nth(1).boundingBox())?.height).toBeGreaterThan(390);
  await assertSeparated();
  expect(await cards.first().boundingBox()).toEqual(firstBefore);
  await page.getByRole("button", { name: "Add result" }).click();
  await expect(page.locator(".generator-output-history")).toBeVisible();
  await assertSeparated();
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("placed-nodes.png"), fullPage: true });
});
