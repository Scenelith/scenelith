import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

let fixture: string;
const css = readFileSync("src/app/globals.css", "utf8");

test.beforeAll(async () => {
  const result = await build({
    entryPoints: ["tests/browser/fixtures/generation-performance.tsx"],
    absWorkingDir: process.cwd(), tsconfig: path.resolve("tsconfig.json"),
    bundle: true, write: false, platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  fixture = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route("https://fixture.test/playback.mp4", (route) => route.fulfill({
    contentType: "video/mp4", body: readFileSync("tests/browser/fixtures/playback.mp4"),
  }));
  await page.setContent(`<style>${css}
          :root { --color-mint:#72ddb7; }
    body{margin:0;min-height:3000px}.stage{position:relative;width:640px;height:430px}
    .image-generation-state{pointer-events:none}
  </style><div id="root"></div>`);
  await page.addScriptTag({ content: fixture });
});

test("a remotely covered preview stops without losing its frame or restarting on completion", async ({ page }) => {
  const video = page.locator("video[data-active-deck='true']");
  await page.getByRole("button", { name: "Play video", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.25);
  await page.getByRole("button", { name: "Toggle generation" }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  const stoppedAt = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
  expect(stoppedAt).toBeGreaterThan(0);
  expect(await video.getAttribute("src")).toContain("playback.mp4");
  await page.waitForTimeout(350);
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(stoppedAt);
  await page.getByRole("button", { name: "Toggle generation" }).click();
  await page.waitForTimeout(250);
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(stoppedAt);
  await page.getByRole("button", { name: "Play video", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(stoppedAt + .1);
});

test("outline and shimmer suspend outside the viewport and resume when visible", async ({ page }) => {
  const runner = page.locator(".generator-running-runner");
  await expect(runner).toHaveCSS("animation-play-state", "running");
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect(runner).toHaveCSS("animation-play-state", "paused");
  await expect.poll(() => page.locator(".image-generation-shimmer").evaluate((element) => element.getAnimations().filter((animation) => animation.playState === "running").length)).toBe(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(runner).toHaveCSS("animation-play-state", "running");
});

test("hidden-page notifications pause the outline; reduced motion still disables it", async ({ page }) => {
  const runner = page.locator(".generator-running-runner");
  await expect(runner).toHaveCSS("animation-play-state", "running");
  // Exercise the real visibility subscription without relying on OS focus in CI.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(runner).toHaveCSS("animation-play-state", "paused");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(runner).toHaveCSS("animation-play-state", "running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(runner).toHaveCSS("animation-name", "none");
});

test("covering this Master does not pause playback owned by another node", async ({ page }) => {
  await page.getByRole("button", { name: "Play other node" }).click();
  await expect(page.getByLabel("Playback owner")).toHaveText("other-node:play");
  await page.getByRole("button", { name: "Toggle generation" }).click();
  await expect(page.getByLabel("Playback owner")).toHaveText("other-node:play");
});
