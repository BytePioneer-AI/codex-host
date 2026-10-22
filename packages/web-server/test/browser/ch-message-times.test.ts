import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "shows original message times after loading and reopening shared history",
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-message-times-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("timed-history", "/computer/project", "Original message times");
    row.turns = [
      {
        id: "original-turn",
        status: "completed",
        startedAt: Date.UTC(2024, 0, 2, 1, 2) / 1000,
        completedAt: Date.UTC(2024, 0, 2, 1, 3, 5) / 1000,
        items: [
          {
            id: "user",
            type: "userMessage",
            content: [{ type: "text", text: "Earlier question" }],
          },
          { id: "answer", type: "agentMessage", text: "Earlier answer" },
        ],
      },
    ];
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
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      timezoneId: "Asia/Shanghai",
      locale: "en-US",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page
      .locator('[data-row-key^="session:"]')
      .filter({ hasText: "Original message times" })
      .click();

    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByText("Earlier answer", { exact: true }).waitFor();
      const user = page.locator('[data-clock="start"]');
      const assistant = page.locator('[data-clock="end"]');
      assert.equal(await user.innerText(), "2024-1-2 09:02");
      assert.equal(await assistant.innerText(), "2024-1-2 09:03");
      if (attempt === 0) await page.reload();
    }
    assert.ok(host.snapshots > 0, "message timing survives the shared snapshot contract");
    assert.deepEqual(errors, []);
  },
);
