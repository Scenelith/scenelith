import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

test("Text overlay settings accept fractional values and expose optional image/text ports", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture = (await build({ entryPoints: ["tests/browser/fixtures/text-overlay-editor.tsx"], absWorkingDir: process.cwd(), tsconfig: path.resolve("tsconfig.json"), bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.setContent(`<style>${readFileSync("node_modules/@xyflow/react/dist/style.css", "utf8")}${readFileSync("src/app/globals.css", "utf8")}${readFileSync("src/app/theme.css", "utf8")}</style><div id="root"></div>`);
  await page.addScriptTag({ content: fixture });
  const position = page.locator("label").filter({ hasText: "Vertical position (%)" }).locator("input");
  await expect(position).toHaveValue("50");
  await position.fill("67.5");
  await expect(position).toHaveValue("67.5");
  expect(await position.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(true);
  const spacing = page.locator("label").filter({ hasText: "Line spacing" }).locator("input");
  expect(await spacing.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(true);
  await expect(page.getByRole("button", { name: "Apply text overlay", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Guide", exact: true }).click();
  await expect(page.getByText("Rewritten slide text (optional)", {exact:true}).first()).toBeAttached();
  await expect(page.locator("html")).toHaveAttribute("data-saved-overlay-y", "67.5");
  expect(errors).toEqual([]);
  await page.screenshot({ path: "/tmp/overlay-editor-verified.png" });
});
