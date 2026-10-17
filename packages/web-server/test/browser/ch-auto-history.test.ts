import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "loads short history on an upward touch, keeps failed pages retryable, and does not retry in a loop",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    const row = host.add("short", "/computer/project", "Short mobile history");
    row.turns = Array.from({ length: 6 }, (_, i) => ({
      id: `turn-${i}`,
      status: "completed",
      items: [
        {
          id: `u-${i}`,
          type: "userMessage",
          content: [{ type: "text", text: `Short question ${i}` }],
        },
        { id: `a-${i}`, type: "agentMessage", text: `Short answer ${i}` },
      ],
    }));
    let failing = true;
    let olderAttempts = 0;
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "thread/turns/list" && params.cursor) {
        olderAttempts++;
        if (failing) throw new Error("Temporary older history failure");
      }
      return request<T>(method, params);
    };
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    // Set up the selected Thread on a wide layout, then test touch interaction on
    // a narrow viewport. No synthetic app state or scroll offsets are injected.
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1600 },
      hasTouch: true,
      isMobile: true,
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let pageRequests = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/session/page") pageRequests++;
    });
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/ });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Short mobile history" }).click();
    await page.getByText("Short question 5", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 1600 });
    await page.waitForTimeout(500); // responsive drawer animation/setup
    const newSession = page
      .getByRole("button", { name: "New session", exact: true })
      .filter({ hasText: "New Session" });
    if (await newSession.isVisible()) {
      await page.getByRole("treeitem").filter({ hasText: "Short mobile history" }).click();
      await newSession.waitFor({ state: "hidden" });
    }
    await page.waitForTimeout(600);
    assert.equal(pageRequests, 0, "startup and resize must not drain older history");
    assert.equal(await page.getByRole("button", { name: "Load earlier", exact: true }).count(), 0);
    const metrics = await page
      .locator("[data-conversation-scroll]")
      .evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    assert.equal(
      metrics.max,
      0,
      "the short loaded page fits the viewport; touch intent must work without a scroll event",
    );
    const cdp = await page.context().newCDPSession(page);
    const swipe = async () => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 200, y: 450 }],
      });
      for (const y of [500, 550, 600, 650, 700])
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: 200, y }],
        });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await swipe();
    await page.getByRole("alert").filter({ hasText: "Temporary older history failure" }).waitFor();
    assert.equal(pageRequests, 1);
    const attempts = olderAttempts;
    await swipe();
    await swipe();
    await page.waitForTimeout(500);
    assert.equal(
      olderAttempts,
      attempts,
      "failed cursor is not automatically retried by continuing touch input",
    );
    assert.equal(await page.getByText("Short question 5", { exact: true }).count(), 1);
    const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "auto-history-mobile-failure.png") });
    }
    failing = false;
    await page.getByRole("button", { name: "Retry loading", exact: true }).click();
    await page.getByText("Short question 0", { exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(
      await page.getByText("Scroll up for earlier messages", { exact: true }).count(),
      0,
    );
    assert.equal(pageRequests, 2);
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "auto-history-mobile-recovered.png") });
    assert.deepEqual(errors, []);
  },
);
