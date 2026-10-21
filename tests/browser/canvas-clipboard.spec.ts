import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

let fixture: string;
test.beforeAll(async () => {
  fixture = (await build({ entryPoints: ["tests/browser/fixtures/canvas-clipboard.tsx"], absWorkingDir: process.cwd(), tsconfig: path.resolve("tsconfig.json"), bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
});

test("native clipboard images replace an earlier node copy without reloading Canvas", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://scenelith.test" });
  await page.route("https://scenelith.test/clipboard", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("https://scenelith.test/clipboard");
  await page.addScriptTag({ content: fixture });
  const canvas = page.getByRole("button", { name: "Canvas node" });
  const nodes = page.getByLabel("Pasted nodes");
  const images = page.getByLabel("Pasted images").locator("img");
  await canvas.click();
  await page.keyboard.press("ControlOrMeta+c");
  const token = await page.evaluate(() => navigator.clipboard.readText());
  expect(token).toMatch(/^scenelith:canvas-selection:/);
  await page.keyboard.press("ControlOrMeta+v");
  await expect(nodes).toHaveText("1");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(nodes).toHaveText("2");

  // Replace the actual system clipboard, while the old node snapshot remains in memory.
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 3;
    canvas.getContext("2d")!.fillRect(0, 0, 4, 3);
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  });
  await page.keyboard.press("ControlOrMeta+v");
  await expect(images).toHaveCount(1);
  await expect(nodes).toHaveText("2");

  await page.evaluate(() => navigator.clipboard.writeText("External text"));
  await page.keyboard.press("ControlOrMeta+v");
  await expect(nodes).toHaveText("2");
  await expect(images).toHaveCount(1);
  await page.getByRole("textbox", { name: "Node title", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.getByRole("textbox", { name: "Node title", exact: true })).toHaveValue("External text");
  await expect(nodes).toHaveText("2");

  // Even a payload containing an old node marker must prefer its image.
  await canvas.click();
  await canvas.evaluate((element, marker) => {
    const data = new DataTransfer(); data.setData("text/plain", marker);
    data.items.add(new File(["fixture"], "clipboard.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, token);
  await expect(images).toHaveCount(2);
  await expect(nodes).toHaveText("2");

  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(nodes).toHaveText("3");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).getByText("Editable prompt").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Editable prompt");
});
