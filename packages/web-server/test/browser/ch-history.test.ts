import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "shows the native tail before slow older history and prepends without moving visible anchors",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    const row = host.add("long", "/computer/project", "Long paged history");
    row.turns = Array.from({ length: 20 }, (_, i) => ({
      id: `turn-${i}`,
      status: "completed",
      items: [
        { id: `u-${i}`, type: "userMessage", content: [{ type: "text", text: `Question ${i}` }] },
        {
          id: `a-${i}`,
          type: "agentMessage",
          text:
            `Answer ${i}: ` +
            "A historical answer with enough lines to verify stable scroll anchoring. ".repeat(15),
        },
      ],
    }));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t.after(() => release());
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "thread/turns/list" && params.cursor) await gate;
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/ });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Long paged history" }).click();
    await page.getByText("Question 19", { exact: true }).waitFor();
    assert.equal(await page.getByText("Question 14", { exact: true }).count(), 0);
    const head = host.requests.filter((r) => r.method === "thread/turns/list");
    assert.equal(head.length, 1, "tail is visible while older native reads remain blocked");
    assert.equal(head[0]?.params.limit, 5);
    const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "paged-tail-before-older.png") });
    }
    release();
    const earlier = page.getByRole("button", { name: "Load earlier", exact: true });
    await earlier.scrollIntoViewIfNeeded();
    const anchor = page.getByText("Question 15", { exact: true });
    await anchor.waitFor();
    const before = await anchor.boundingBox();
    assert.ok(before);
    const key = await anchor
      .locator("xpath=ancestor::*[@data-chat-node-key][1]")
      .getAttribute("data-chat-node-key");
    await earlier.click();
    await page.getByText("Question 10", { exact: true }).waitFor();
    // Layout settlement only; the assertion measures the original visible message,
    // not a new synthetic offset or an injected scroll position.
    await page.waitForTimeout(500);
    const after = await anchor.boundingBox();
    assert.ok(after);
    assert.ok(Math.abs(after.y - before.y) < 4, `anchor moved ${after.y - before.y}px`);
    assert.equal(
      await anchor
        .locator("xpath=ancestor::*[@data-chat-node-key][1]")
        .getAttribute("data-chat-node-key"),
      key,
    );
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "paged-anchor-after-prepend.png") });
    await earlier.click();
    await page.getByText("Question 5", { exact: true }).waitFor();
    await earlier.click();
    await page.getByText("Question 0", { exact: true }).waitFor();
    assert.equal(await earlier.count(), 0);
    assert.equal(host.requests.filter((r) => r.method === "thread/turns/list").length, 4);
    assert.deepEqual(errors, []);
    await page.reload();
    await page.getByText("Question 19", { exact: true }).waitFor();
    assert.equal(
      host.requests.filter((r) => r.method === "thread/turns/list").length,
      4,
      "reopening reuses the loaded native window",
    );
  },
);
