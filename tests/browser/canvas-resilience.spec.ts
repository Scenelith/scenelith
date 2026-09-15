import { readFileSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";

type SeedState = {
  cookie: string;
  projectId: string;
  projectName: string;
  graphMarker: string;
};

function seedState(): SeedState {
  const path = process.env.SCENELITH_E2E_STATE;
  if (!path) throw new Error("SCENELITH_E2E_STATE must point to the state created by selfhost:e2e");
  return JSON.parse(readFileSync(path, "utf8")) as SeedState;
}

async function authenticatedContext(browser: Browser, state: SeedState): Promise<BrowserContext> {
  const baseURL = process.env.SCENELITH_E2E_BASE_URL || "http://localhost";
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets = new Set<WebSocket>();
    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.add(this);
        this.addEventListener("close", () => sockets.delete(this));
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: TrackedWebSocket });
    Object.defineProperty(window, "__scenelithDisconnectSockets", {
      configurable: true,
      value: () => sockets.forEach((socket) => socket.close(4001, "browser resilience test")),
    });
  });
  const session = state.cookie.match(/^frameflow_session=([^;]+)$/)?.[1];
  if (!session) throw new Error("Self-hosted E2E state has no valid session cookie");
  await context.addCookies([{ name: "frameflow_session", value: session, url: baseURL }]);
  return context;
}

async function waitForLiveCanvas(context: BrowserContext, projectId: string) {
  const page = await context.newPage();
  await page.goto(`/canvas?project=${encodeURIComponent(projectId)}`);
  await expect(page.getByTestId("collaboration-status")).toHaveAttribute("data-status", "synced");
  return page;
}

async function expectPersistedSource(context: BrowserContext, state: SeedState) {
  const response = await context.request.get(`/api/projects/${encodeURIComponent(state.projectId)}`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.project?.sourceUrl).toBe(`https://example.test/${state.graphMarker}`);
}

test("saved pan and zoom survive reload when the shared graph has no viewport", async ({ browser }) => {
  const context = await authenticatedContext(browser, seedState());
  try {
    const headers = { origin: process.env.SCENELITH_E2E_BASE_URL || "http://localhost" };
    const created = await context.request.post("/api/projects", { headers, data: { name: `Camera reload ${crypto.randomUUID()}` } });
    expect(created.ok()).toBeTruthy();
    const project = (await created.json()).project;
    const updated = await context.request.patch(`/api/projects/${project.id}`, { headers, data: {
      revision: project.revision,
      graph: { nodes: [{ id: "camera-note", type: "frameNode", position: { x: 400, y: 9000 }, data: { kind: "note", title: "Camera test", noteText: "Keep my place" } }], edges: [] },
    } });
    expect(updated.ok()).toBeTruthy();
    expect((await updated.json()).project.graph.viewport).toBeUndefined();
    const page = await waitForLiveCanvas(context, project.id);
    const viewport = page.locator(".canvas-stage .react-flow__viewport");
    await page.getByRole("button", { name: /zoom out/i }).click();
    const pane = (await page.locator(".canvas-stage .react-flow__pane").boundingBox())!;
    await page.mouse.move(pane.x + pane.width - 120, pane.y + 180);
    const before = await viewport.evaluate((element) => (element as HTMLElement).style.transform);
    await page.mouse.wheel(600, 1000);
    await expect.poll(() => viewport.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(before);
    await expect.poll(() => page.evaluate((id) => sessionStorage.getItem(`scenelith:canvas-viewport:v1:${id}`), project.id)).not.toBeNull();
    const saved = await viewport.evaluate((element) => (element as HTMLElement).style.transform);
    await page.reload();
    await expect(page.getByTestId("collaboration-status")).toHaveAttribute("data-status", "synced");
    await expect.poll(() => viewport.evaluate((element) => (element as HTMLElement).style.transform)).toBe(saved);
    await page.getByTestId("project-switcher").click();
    await expect.poll(() => viewport.evaluate((element) => (element as HTMLElement).style.transform)).toBe(saved);
  } finally { await context.close(); }
});

test("real browser preserves canvas state across reload, switching, concurrent sessions, and reconnect", async ({ browser }) => {
  const state = seedState();
  const primaryContext = await authenticatedContext(browser, state);
  const peerContext = await authenticatedContext(browser, state);
  try {
    const page = await waitForLiveCanvas(primaryContext, state.projectId);
    await expect(page).toHaveURL(new RegExp(`project=${state.projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(page.getByTestId("project-switcher")).toContainText(state.projectName);
    await expectPersistedSource(primaryContext, state);

    const viewport = page.locator(".canvas-stage .react-flow__viewport");
    const initialCamera = await viewport.evaluate((element) => (element as HTMLElement).style.transform);
    const pane = await page.locator(".canvas-stage .react-flow__pane").boundingBox();
    expect(pane).not.toBeNull();
    await page.mouse.move(pane!.x + pane!.width / 2, pane!.y + pane!.height / 2);
    await page.mouse.wheel(650, 1400);
    await expect.poll(() => viewport.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(initialCamera);
    await page.getByRole("button", { name: /zoom out/i }).click();
    await expect.poll(() => page.evaluate((id) => {
      const raw = sessionStorage.getItem(`scenelith:canvas-viewport:v1:${id}`);
      return raw ? JSON.parse(raw).y : 0;
    }, state.projectId)).not.toBe(0);
    const savedCamera = await viewport.evaluate((element) => (element as HTMLElement).style.transform);

    await page.reload();
    await expect(page.getByTestId("collaboration-status")).toHaveAttribute("data-status", "synced");
    await expect(page.getByTestId("project-switcher")).toContainText(state.projectName);
    await expectPersistedSource(primaryContext, state);
    await expect.poll(() => viewport.evaluate((element) => (element as HTMLElement).style.transform)).toBe(savedCamera);

    const secondName = `Browser switch ${crypto.randomUUID()}`;
    const created = await primaryContext.request.post("/api/projects", {
      headers: { origin: process.env.SCENELITH_E2E_BASE_URL || "http://localhost" },
      data: { name: secondName },
    });
    expect(created.ok()).toBeTruthy();
    const secondId = String((await created.json()).project?.id || "");
    expect(secondId).not.toBe("");
    await page.reload();

    for (const [projectId, projectName] of [[secondId, secondName], [state.projectId, state.projectName], [secondId, secondName]] as const) {
      await page.getByTestId("project-switcher").click();
      await page.getByTestId("project-card").filter({ hasText: projectName }).click();
      await expect(page).toHaveURL(new RegExp(`project=${projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      await expect(page.getByTestId("collaboration-status")).toHaveAttribute("data-status", "synced");
      if (projectId === state.projectId) await expect.poll(() => viewport.evaluate((element) => (element as HTMLElement).style.transform)).toBe(savedCamera);
    }

    const peer = await waitForLiveCanvas(peerContext, secondId);
    await expect(page.getByTestId("collaboration-status")).toHaveAttribute("data-peer-count", "1");
    await expect(peer.getByTestId("collaboration-status")).toHaveAttribute("data-peer-count", "1");

    await page.evaluate(() => (window as Window & { __scenelithDisconnectSockets?: () => void }).__scenelithDisconnectSockets?.());
    await expect(page.getByTestId("collaboration-status")).toHaveAttribute("data-status", /offline|error/);
    await expect(page.getByTestId("collaboration-status")).toHaveAttribute("data-status", "synced", { timeout: 30_000 });
    await expect(page.getByTestId("source-url")).toBeVisible();
  } finally {
    await Promise.all([primaryContext.close(), peerContext.close()]);
  }
});

test("automation uses the selected TikTok across opening, workflow switches, and submission", async ({ browser }) => {
  const context = await authenticatedContext(browser, seedState());
  try {
    const headers = { origin: process.env.SCENELITH_E2E_BASE_URL || "http://localhost" };
    const created = await context.request.post("/api/projects", { headers, data: { name: `Source selection ${crypto.randomUUID()}` } });
    expect(created.ok()).toBeTruthy();
    const project = (await created.json()).project;
    const nodes = ["a", "b"].flatMap((key, index) => [
      { id: `source-${key}`, type: "frameNode", position: { x: 100 + index * 600, y: 100 }, data: { kind: "source", title: `TikTok ${key.toUpperCase()}`, postId: key, tiktokMediaType: "slideshow" } },
      { id: `slide-${key}`, type: "frameNode", position: { x: 100 + index * 600, y: 400 }, data: { kind: "scene", title: "Screen 01", assetId: `asset-${key}`, tiktokSourceNodeId: `source-${key}` } },
    ]);
    const updated = await context.request.patch(`/api/projects/${project.id}`, { headers, data: { revision: project.revision, graph: { nodes, edges: [] } } });
    expect(updated.ok()).toBeTruthy();
    const workflows = ["one", "two"].map((id) => ({ id, name: `Workflow ${id}`, status: "published", publishedVersionId: `version-${id}` }));
    const capabilities = { run: true, edit: true, publish: true };
    await context.route("**/api/automation-workflows?*", (route) => route.fulfill({ json: { workflows, capabilities } }));
    await context.route(/\/api\/automation-workflows\/(one|two)$/, (route) => {
      const id = route.request().url().split("/").pop()!;
      return route.fulfill({ json: { workflow: workflows.find((w) => w.id === id), capabilities,
        runInputs: [{ key: `${id}.source`, nodeId: id, valueType: "tiktok-source", label: "Source slideshow", required: true, value: "source-a" }],
      } });
    });
    const page = await waitForLiveCanvas(context, project.id);
    await page.locator('.react-flow__node[data-id="source-b"]').click();
    await page.getByRole("button", { name: "Open automation", exact: true }).click();
    const panel = page.locator(".tiktok-automation-panel");
    await expect(panel.getByRole("button", { name: "Source slideshow", exact: true })).toContainText("TikTok B");
    await panel.getByRole("button", { name: "Workflow", exact: true }).click();
    await page.getByRole("option", { name: /Workflow two/ }).click();
    await expect(panel.getByRole("button", { name: "Source slideshow", exact: true })).toContainText("TikTok B");
    await expect(panel.getByRole("button", { name: "Run automation", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Close automation", exact: true }).click();
    await page.getByRole("button", { name: "Open automation", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Source slideshow", exact: true })).toContainText("TikTok B");
    let submitted: unknown;
    await context.route("**/api/automation-runs", async (route) => {
      submitted = route.request().postDataJSON();
      await route.fulfill({ status: 400, json: { error: "Submission captured without running generation" } });
    });
    await panel.getByRole("button", { name: "Run automation", exact: true }).click();
    await expect.poll(() => submitted).toMatchObject({ inputs: { "two.source": "source-b" } });
    await panel.getByRole("button", { name: "Source slideshow", exact: true }).click();
    await page.getByRole("option", { name: /TikTok A/ }).click();
    await expect(panel.getByRole("button", { name: "Source slideshow", exact: true })).toContainText("TikTok A");
    await expect(page.locator('.react-flow__node[data-id="source-a"]')).toHaveClass(/selected/);
  } finally { await context.close(); }
});
