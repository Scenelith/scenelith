import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let fixture: string;
const css = readFileSync("node_modules/@xyflow/react/dist/style.css", "utf8") + readFileSync("src/app/globals.css", "utf8") + readFileSync("src/app/theme.css", "utf8");
test.beforeAll(async () => {
  const result = await build({ entryPoints: ["tests/browser/fixtures/canvas-static-edges.tsx"], absWorkingDir: process.cwd(), tsconfig: path.resolve("tsconfig.json"), bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  fixture = result.outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  await page.setContent(`<style>${css}:root{--color-mint:#72ddb7}body{margin:0}.react-flow__node{width:150px;height:40px;background:#333}</style><div id="root"></div>`);
  await page.addScriptTag({ content: fixture });
});

test("legacy animated connections stay still, including after highlighting", async ({ page }) => {
  const edge = page.locator(".react-flow__edge-path");
  await expect(edge).toHaveAttribute("d", /C/);
  await expect(edge).toHaveCSS("visibility", "visible");
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSAnimation && a.animationName === "dashdraw").length)).toBe(0);
  // A stationary graph must have identical pixels across different dash phases.
  const graph = page.locator(".react-flow");
  const before = await graph.screenshot();
  await page.waitForTimeout(180);
  expect(await graph.screenshot()).toEqual(before);
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect(edge).toHaveCSS("stroke", "rgb(114, 221, 183)");
  await expect(edge).toHaveCSS("filter", "none");
  const highlighted = await graph.screenshot();
  expect(highlighted).not.toEqual(before);
  await page.waitForTimeout(180);
  expect(await graph.screenshot()).toEqual(highlighted);
});

test("static connections follow node and camera moves and disappear when removed", async ({ page }) => {
  const edge = page.locator(".react-flow__edge-path");
  await expect(edge).toHaveAttribute("d", /C/);
  const previousPath = await edge.getAttribute("d");
  await page.getByRole("button", { name: "Move node", exact: true }).click();
  await expect(edge).not.toHaveAttribute("d", previousPath!);
  await page.getByRole("button", { name: "Move camera", exact: true }).click();
  await expect(page.locator(".react-flow__viewport")).toHaveCSS("transform", "matrix(0.7, 0, 0, 0.7, 40, 30)");
  await expect(edge).toBeVisible();
  await page.getByRole("button", { name: "Remove edges", exact: true }).click();
  await expect(edge).toHaveCount(0);
});
