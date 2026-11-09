import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, expect } from "@playwright/test";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { defined } from "../support/defined.ts";

async function fixture(t: TestContext, host: FakeChChannel) {
  const directory = mkdtempSync(join(tmpdir(), "ch-cache-navigation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const channel = await startFakeChChannel(host, directory);
  t.after(() => channel.close());
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    [
      "--session-source",
      "codexhost",
      "--ch-cdp",
      debug.endpoint,
      "--ch-control-directory",
      directory,
    ],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, url, errors };
}

it(
  "scrolling cached history during synchronization does not consume the next paging boundary",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChChannel();
    const source = host.add("paged", "/computer/project", "Paged cache");
    host.add("other", "/computer/project", "Other");
    source.turns = Array.from({ length: 14 }, (_, index) => ({
      id: `turn-${index}`,
      status: "completed",
      items: [
        {
          id: `user-${index}`,
          type: "userMessage",
          content: [{ type: "text", text: `Question ${index}` }],
        },
        {
          id: `answer-${index}`,
          type: "agentMessage",
          text: `Answer ${index}\n\n${Array.from({ length: 8 }, (_, n) => `Paragraph ${index}-${n}`).join("\n\n")}`,
        },
      ],
    }));
    const gate = Promise.withResolvers<undefined>();
    t.after(() => gate.resolve(undefined));
    let hold = false;
    const snapshot = host.snapshot.bind(host);
    host.snapshot = async (id, options) => {
      if (hold && id === source.id) await gate.promise;
      return snapshot(id, options);
    };
    const { page, url, errors } = await fixture(t, host);
    let pageRequests = 0;
    const heads: number[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/session/page") pageRequests++;
    });
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.value?.type === "snapshot" && frame.value.header.id === source.id)
          heads.push(frame.value.records[0].event.seq);
      }),
    );
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/u });
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    const openSource = async () => {
      await page.locator('[data-row-key="session:paged"]').click();
      await expect(page.getByText("Question 13", { exact: true })).toBeVisible();
      await expect(page.locator("[data-history-syncing]")).toHaveCount(0);
    };
    const openOther = async () => {
      await page.locator('[data-row-key="session:other"]').click();
      await expect(page.getByText("existing CH answer", { exact: true })).toBeVisible();
    };
    await openSource();
    await expect
      .poll(() => host.requests.filter((request) => request.method === "thread/turns/list").length)
      .toBeGreaterThan(0);
    // Adopt the server's one prefetched page before freezing a same-head follow snapshot.
    await openOther();
    await openSource();
    await expect(page.getByText("Question 4", { exact: true })).toBeVisible();
    await openOther();
    hold = true;
    await page.locator('[data-row-key="session:paged"]').click();
    await expect(page.locator("[data-history-syncing]")).toBeVisible();
    const scroller = page.locator("[data-conversation-scroll]");
    await scroller.hover();
    await page.mouse.wheel(0, -100000);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(20);
    for (let index = 0; index < 3; index++) {
      await page.mouse.wheel(0, -500);
      await page.waitForTimeout(100);
    }
    assert.equal(
      pageRequests,
      0,
      "cached reading must not attempt pagination during synchronization",
    );
    gate.resolve(undefined);
    await expect(page.locator("[data-history-syncing]")).toHaveCount(0);
    assert.equal(heads.length, 3);
    assert.equal(heads[2], heads[1], "the authoritative snapshot has the cached head");
    for (let index = 0; index < 3; index++) {
      await page.mouse.wheel(0, -500);
      await page.waitForTimeout(100);
    }
    await expect.poll(() => pageRequests).toBeGreaterThan(0);
    await expect(page.getByText("Question 0", { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
  },
);

it(
  "retains a Session's reading position after its display data is evicted from the eight-view cache",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChChannel();
    const source = host.add("reader", "/computer/project", "Long reader");
    const answer = defined(
      defined(source.turns[0]).items.find((item) => item.type === "agentMessage"),
    );
    answer.text = `Reader answer\n\n${Array.from({ length: 60 }, (_, index) => `Reading paragraph ${index}`).join("\n\n")}`;
    const others = Array.from({ length: 9 }, (_, index) => {
      const row = host.add(`other-${index}`, "/computer/project", `Other ${index}`);
      defined(defined(row.turns[0]).items.find((item) => item.type === "agentMessage")).text =
        `Other answer ${index}`;
      return row;
    });
    const gate = Promise.withResolvers<undefined>();
    t.after(() => gate.resolve(undefined));
    let hold = false;
    const snapshot = host.snapshot.bind(host);
    host.snapshot = async (id, options) => {
      if (hold && id === source.id) await gate.promise;
      return snapshot(id, options);
    };
    const { page, url, errors } = await fixture(t, host);
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/u });
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    const more = page.getByRole("button", { name: /^Show \d+ more$/u });
    while (await more.count()) await more.first().click();
    await page.locator('[data-row-key="session:reader"]').click();
    await expect(page.getByText("Reader answer", { exact: true })).toBeVisible();
    const scroller = page.locator("[data-conversation-scroll]");
    const bottom = await scroller.evaluate((element) => element.scrollTop);
    await scroller.hover();
    await page.mouse.wheel(0, -600);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeLessThan(bottom - 200);
    await page.waitForTimeout(150);
    const savedTop = await scroller.evaluate((element) => element.scrollTop);
    for (const [index, row] of others.entries()) {
      await page.locator(`[data-row-key="session:${row.id}"]`).click();
      await expect(page.getByText(`Other answer ${index}`, { exact: true })).toBeVisible();
    }
    hold = true;
    await page.locator('[data-row-key="session:reader"]').click();
    await expect(page.getByText("Loading history…", { exact: true })).toBeVisible();
    await expect(page.getByText("Reader answer", { exact: true })).toHaveCount(0);
    gate.resolve(undefined);
    await expect(page.getByText("Reader answer", { exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await scroller.evaluate((element) => element.scrollTop)) - savedTop),
      )
      .toBeLessThan(40);
    assert.deepEqual(errors, []);
  },
);
