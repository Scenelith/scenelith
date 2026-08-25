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

test("real browser preserves canvas state across reload, switching, concurrent sessions, and reconnect", async ({ browser }) => {
  const state = seedState();
  const primaryContext = await authenticatedContext(browser, state);
  const peerContext = await authenticatedContext(browser, state);
  try {
    const page = await waitForLiveCanvas(primaryContext, state.projectId);
    await expect(page).toHaveURL(new RegExp(`project=${state.projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(page.getByTestId("project-switcher")).toContainText(state.projectName);
    await expectPersistedSource(primaryContext, state);

    await page.reload();
    await expect(page.getByTestId("collaboration-status")).toHaveAttribute("data-status", "synced");
    await expect(page.getByTestId("project-switcher")).toContainText(state.projectName);
    await expectPersistedSource(primaryContext, state);

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
