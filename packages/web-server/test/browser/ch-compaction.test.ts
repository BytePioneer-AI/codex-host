import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "renders recovered manual compaction and the live automatic compaction lifecycle",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-browser-compaction-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("compaction", "/computer/shared", "Compaction lifecycle");
    row.turns = [
      {
        id: "manual-compaction",
        status: "completed",
        items: [
          {
            id: "manual-compaction-item",
            type: "contextCompaction",
            status: "completed",
          },
        ],
      },
    ];
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
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
        debuggerServer.endpoint,
        "--ch-control-directory",
        directory,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^shared$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Compaction lifecycle" }).click();

    const recovered = page.locator('[data-tool="compact_context"][data-state="ok"]');
    await recovered.waitFor();
    assert.match((await recovered.innerText()).trim(), /上下文已压缩/u);
    assert.doesNotMatch(await recovered.innerText(), /compact_context/u);

    const automatic = {
      id: "automatic-compaction-item",
      type: "contextCompaction",
      status: "running",
    };
    row.turns.push({
      id: "automatic-compaction",
      status: "inProgress",
      items: [
        {
          id: "automatic-user",
          type: "userMessage",
          content: [{ type: "text", text: "Continue after automatic compaction" }],
        },
        automatic,
      ],
    });
    row.status = { type: "active" };
    host.changed(row.id, "item/started");

    const running = page.locator('[data-tool="compact_context"][data-state="running"]');
    await running.waitFor();
    assert.match((await running.innerText()).trim(), /正在压缩/u);
    const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "compaction-running.png") });
    }

    automatic.status = "completed";
    host.changed(row.id, "item/completed");
    const completed = page.locator('[data-tool="compact_context"][data-state="ok"]');
    await completed.nth(1).waitFor();
    assert.equal(await completed.count(), 2);
    assert.match((await completed.nth(1).innerText()).trim(), /上下文已压缩/u);
    if (screenshots) {
      await page.screenshot({ path: join(screenshots, "compaction-completed.png") });
    }
    assert.deepEqual(errors, []);
  },
);
