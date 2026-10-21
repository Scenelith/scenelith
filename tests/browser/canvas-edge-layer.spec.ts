import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import sharp from "sharp";

let fixture: string;
const css = readFileSync("node_modules/@xyflow/react/dist/style.css", "utf8") + readFileSync("src/app/globals.css", "utf8") + readFileSync("src/app/theme.css", "utf8");
test.beforeAll(async () => {
  const result = await build({ entryPoints: ["tests/browser/fixtures/canvas-edge-layer.tsx"], absWorkingDir: process.cwd(), tsconfig: path.resolve("tsconfig.json"), bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  fixture = result.outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  await page.setContent(`<style>${css}:root{--color-mint:#72ddb7}body{margin:0}.react-flow__node{width:150px;height:40px;background:#333}</style><div id="root"></div>`);
  await page.evaluate(() => {
    const original = WebGL2RenderingContext.prototype.drawArrays;
    (window as Window & { edgeDraws: number }).edgeDraws = 0;
    WebGL2RenderingContext.prototype.drawArrays = function(...args) {
      (window as Window & { edgeDraws: number }).edgeDraws++;
      return original.apply(this, args);
    };
  });
  await page.addScriptTag({ content: fixture });
});

test("moving dashes use one GPU surface, retain visible ink, and follow camera and highlight changes", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".react-flow")).toHaveClass(/canvas-gpu-edges/);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSAnimation && a.animationName === "dashdraw").length)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { edgeDraws: number }).edgeDraws)).toBeGreaterThan(2);
  // A transparent/empty GPU layer must not be accepted as a performance fix.
  const before = await sharp(await page.locator(".react-flow").screenshot()).raw().toBuffer();
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await page.getByRole("button", { name: "Move camera", exact: true }).click();
  await page.waitForTimeout(150);
  const after = await sharp(await page.locator(".react-flow").screenshot()).raw().toBuffer();
  const mintPixels = (buffer: Buffer) => { let n = 0; for (let i = 0; i < buffer.length; i += 3) if (buffer[i + 1] > buffer[i] * 1.3 && buffer[i + 2] > buffer[i] * 1.2 && buffer[i + 1] > 65) n++; return n; };
  expect(mintPixels(after)).toBeGreaterThan(mintPixels(before) + 200);
  expect(errors).toEqual([]);
});

test("hidden tabs and empty graphs stop drawing and SVG survives context loss", async ({ page }) => {
  await expect(page.locator(".react-flow")).toHaveClass(/canvas-gpu-edges/);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const draws = await page.evaluate(() => (window as Window & { edgeDraws: number }).edgeDraws);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as Window & { edgeDraws: number }).edgeDraws)).toBe(draws);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.getByRole("button", { name: "Remove edges", exact: true }).click();
  await page.waitForTimeout(100);
  const emptyDraws = await page.evaluate(() => (window as Window & { edgeDraws: number }).edgeDraws);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as Window & { edgeDraws: number }).edgeDraws)).toBe(emptyDraws);
  await page.getByRole("button", { name: "Remove edges", exact: true }).click();
  await page.locator(".canvas-edge-layer").evaluate((canvas: HTMLCanvasElement) => canvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!.loseContext());
  await expect(page.locator(".react-flow")).not.toHaveClass(/canvas-gpu-edges/);
  await expect(page.locator(".react-flow__edge-path")).toHaveCSS("visibility", "visible");
});

test("GPU curve and color agree with the native SVG at a fixed animation phase", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".react-flow")).toHaveClass(/canvas-gpu-edges/);
  await page.waitForTimeout(100);
  const gpu = await sharp(await page.locator(".react-flow").screenshot()).removeAlpha().raw().toBuffer();
  await page.addStyleTag({ content: ".canvas-edge-layer{visibility:hidden!important}.canvas-gpu-edges .react-flow__edge-disconnectable > .react-flow__edge-path{visibility:visible!important}.react-flow__edge.animated path{animation:none!important;stroke-dashoffset:0!important}" });
  const svg = await sharp(await page.locator(".react-flow").screenshot()).removeAlpha().raw().toBuffer();
  let ink = 0, mismatch = 0;
  // Exclude node boxes; compare the curve through the otherwise empty middle.
  for (let y = 130; y < 450; y++) for (let x = 240; x < 780; x++) {
    const i = (y * 1100 + x) * 3;
    if (gpu[i] > 20 || svg[i] > 20) { ink++; if (Math.abs(gpu[i] - svg[i]) > 24) mismatch++; }
  }
  expect(ink).toBeGreaterThan(150);
  expect(mismatch / ink).toBeLessThan(.18);
});
