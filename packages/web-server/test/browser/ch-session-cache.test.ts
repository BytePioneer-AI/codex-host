import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, expect } from "@playwright/test";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { defined } from "../support/defined.ts";

it(
  "releases follow, restores cached content and reading position immediately, and waits for authority before history actions",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-browser-cache-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    host.inspection.capabilities.history.rollbackLastTurn = true;
    host.inspection.capabilities.history.fork = true;
    const a = host.add("cached-a", "/computer/cache-project", "Cached A");
    const b = host.add("cold-b", "/computer/cache-project", "Cold B");
    a.historyMode = "paginated";
    const old = defined(a.turns[0]);
    old.items = [
      { id: "old-user", type: "userMessage", content: [{ type: "text", text: "Cached question" }] },
      {
        id: "old-answer",
        type: "agentMessage",
        text: `Cached answer\n\n${Array.from({ length: 60 }, (_, i) => `Reading paragraph ${i}.`).join("\n\n")}`,
        phase: "final_answer",
      },
    ];
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>();
    t.after(() => {
      for (const gate of gates.values()) gate.resolve(undefined);
    });
    const snapshot = host.snapshot.bind(host);
    host.snapshot = async (id, options) => {
      await gates.get(id)?.promise;
      return snapshot(id, options);
    };
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
    const follows = new Map<string, string>();
    const cancelled: string[] = [];
    const openings: Array<{
      epoch: string;
      cursor: number;
      resumedAfter?: number;
      records: unknown[];
    }> = [];
    const resumeRequests: unknown[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (follows.get(frame.streamId) === a.id && frame.value?.type === "snapshot")
          openings.push(frame.value);
      });
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "open" && frame.endpoint === "session/follow") {
          follows.set(frame.streamId, frame.payload.args.request.address.sessionId);
          if (frame.payload.args.request.address.sessionId === a.id)
            resumeRequests.push(frame.payload.args.request.resume);
        }
        if (frame.type === "cancel" && follows.has(frame.streamId))
          cancelled.push(defined(follows.get(frame.streamId)));
      });
    });
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^cache-project$/u });
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator('[data-row-key="session:cached-a"]').click();
    await expect(page.getByText("Cached answer", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit message", exact: true })).toBeEnabled();
    const scroller = page.locator("[data-conversation-scroll]");
    const bottom = await scroller.evaluate((element) => element.scrollTop);
    await scroller.hover();
    await page.mouse.wheel(0, -600);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeLessThan(bottom - 200);
    await page.waitForTimeout(150);
    const savedTop = await scroller.evaluate((element) => element.scrollTop);
    const coldGate = Promise.withResolvers<undefined>();
    gates.set(b.id, coldGate);
    await page.locator('[data-row-key="session:cold-b"]').click();
    await expect(page.getByText("Loading history…", { exact: true })).toBeVisible();
    await expect(page.locator("[data-history-syncing]")).toHaveCount(0);
    await expect(page.getByText("Cached answer", { exact: true })).toHaveCount(0);
    await expect.poll(() => cancelled.includes(a.id)).toBe(true);
    coldGate.resolve(undefined);
    await expect(page.getByText("existing CH answer", { exact: true })).toBeVisible();

    await page.locator('[data-row-key="session:cached-a"]').click();
    await expect.poll(() => openings.length).toBe(2);
    await expect(page.locator("[data-history-syncing]")).toHaveCount(0);
    assert.equal(openings[1]?.resumedAfter, openings[0]?.cursor);
    assert.equal(openings[1]?.records.length, 0);
    await page.locator('[data-row-key="session:cold-b"]').click();
    await expect(page.getByText("existing CH answer", { exact: true })).toBeVisible();
    await expect.poll(() => cancelled.filter((id) => id === a.id).length).toBe(2);

    const cacheGate = Promise.withResolvers<undefined>();
    gates.set(a.id, cacheGate);
    a.turns.push({
      id: "fresh-turn",
      status: "completed",
      items: [
        {
          id: "fresh-user",
          type: "userMessage",
          content: [{ type: "text", text: "New authoritative question" }],
        },
        {
          id: "fresh-answer",
          type: "agentMessage",
          text: "Fresh authoritative answer",
          phase: "final_answer",
        },
      ],
    });
    host.pending = [
      {
        requestId: -71,
        threadId: a.id,
        kind: "approval",
        interaction: {
          type: "approval",
          title: "Current approval",
          actions: [{ id: "once", label: "Allow once", effect: "allowOnce" }],
        },
        request: {
          method: "mcpServer/elicitation/request",
          params: { requestedSchema: { type: "object", properties: {} } },
        },
      },
    ];
    await page.locator('[data-row-key="session:cached-a"]').click();
    await expect(page.getByText("Cached answer", { exact: true })).toBeVisible({ timeout: 1000 });
    const syncing = page.locator("[data-history-syncing]");
    await expect(syncing).toHaveText("Fetching latest messages…");
    await expect(syncing).toHaveAttribute("role", "status");
    await expect(
      page.locator("[data-chat-flow] > [data-history-syncing]:last-child"),
    ).toBeVisible();
    await expect(syncing.locator('svg[data-state="ongoing"]')).toBeVisible();
    await expect(page.getByText("Loading history…", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Fresh authoritative answer", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(0);
    const branch = page.getByRole("button", { name: /Branch/u });
    await expect.poll(() => branch.count()).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Copy", exact: true }).first()).toBeEnabled();
    for (let i = 0; i < (await branch.count()); i++) await expect(branch.nth(i)).toBeDisabled();
    await expect(page.getByRole("radio", { name: "Allow once", exact: true })).toHaveCount(0);
    await expect
      .poll(async () =>
        Math.abs((await scroller.evaluate((element) => element.scrollTop)) - savedTop),
      )
      .toBeLessThan(40);
    assert.equal(
      host.requests.filter(
        (entry) => entry.method === "thread/revert" || entry.method === "thread/fork",
      ).length,
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await syncing.scrollIntoViewIfNeeded();
    await expect(syncing).toBeInViewport();
    const statusBox = defined(await syncing.boundingBox());
    const composerBox = defined(await page.locator("[data-composer-seat]").boundingBox());
    assert.ok(statusBox.x >= 0 && statusBox.x + statusBox.width <= 390);
    assert.ok(statusBox.y + statusBox.height <= composerBox.y);
    const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "history-syncing-mobile.png") });
    }
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.locator("body[data-ds-dark-theme]").waitFor();
    await expect(syncing.locator("svg")).toBeHidden();
    await expect(syncing).toHaveText("Fetching latest messages…");
    await expect(syncing).toBeInViewport();
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "history-syncing-mobile-dark-reduced.png") });
    cacheGate.resolve(undefined);
    await expect(page.getByText("Fresh authoritative answer", { exact: true })).toBeVisible();
    await expect(page.locator("[data-history-syncing]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit message", exact: true })).toBeEnabled();
    await expect(page.getByRole("radio", { name: "Allow once", exact: true })).toBeVisible();
    assert.equal(openings.length, 3);
    assert.deepEqual(resumeRequests[2], { epoch: openings[1]?.epoch, cursor: openings[1]?.cursor });
    assert.equal(openings[2]?.resumedAfter, openings[1]?.cursor);
    assert.ok((openings[2]?.records.length ?? 0) > 0);
    assert.deepEqual(errors, []);
  },
);
