import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

test("the real card drops old failure after success but shows a newer failure", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = (await build({ entryPoints: ["tests/browser/fixtures/generator-status.tsx"], absWorkingDir: process.cwd(), tsconfig: path.resolve("tsconfig.json"), bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  await page.setContent(`<style>${readFileSync("node_modules/@xyflow/react/dist/style.css", "utf8")}${readFileSync("src/app/globals.css", "utf8")}${readFileSync("src/app/theme.css", "utf8")}</style><div id="root"></div>`);
  await page.addScriptTag({ content: fixture });
  const card = page.locator(".frame-node--generator"), failed = page.locator(".generator-failed-label");
  await page.getByRole("button", { name: "Old failure", exact: true }).click();
  await expect(failed).toBeVisible(); await expect(card).toHaveClass(/is-failed/);
  await page.getByRole("button", { name: "New success", exact: true }).click();
  await expect(failed).toHaveCount(0); await expect(card).not.toHaveClass(/is-failed/);
  await expect(page.locator(".generator-output-image")).toBeVisible();
  await page.getByRole("button", { name: "Old failure", exact: true }).click();
  await expect(failed).toHaveCount(0); await expect(card).not.toHaveClass(/is-failed/);
  await page.getByRole("button", { name: "New attempt", exact: true }).click();
  await expect(page.locator(".generator-media-stage")).toHaveClass(/is-queued/);
  await page.getByRole("button", { name: "New failure", exact: true }).click();
  await expect(failed).toBeVisible(); await expect(card).toHaveClass(/is-failed/);
  await page.getByRole("button", { name: "New success", exact: true }).click();
  await expect(failed).toBeVisible();
  expect(errors).toEqual([]);
});
