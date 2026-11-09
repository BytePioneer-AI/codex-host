import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import { chromium } from "playwright";

import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "opens the right Sidebar file tree from a local Thread's Host-recorded directory",
  { timeout: 60_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "codexhost-right-sidebar-browser-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "README.md"), "# Read me\n");
    writeFileSync(join(workspace, "src", "app.ts"), "export {};\n");

    const host = new FakeChHost();
    host.add("local-thread", workspace, "Local Thread");
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--adapters",
        "test/fake-harness",
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Deep links open a Thread without depending on the Sidebar's list layout.
    const target = new URL(url);
    target.searchParams.set("session", "local-thread");
    await page.goto(target.href);
    await page.waitForLoadState("networkidle");
    await page.getByText("earlier question", { exact: true }).waitFor();
    await page.locator("[data-sidebar-right-expand]").click();
    // A fresh Sidebar shows its guide; a restored layout may open the Files tab directly.
    const guideEntry = page.locator('[data-sidebar-right-guide-entry="files"]');
    if ((await guideEntry.count()) > 0) await guideEntry.click();
    await page.locator('[data-files-state="tree"]').waitFor();
    assert.equal(
      await page.locator("[data-files-root]").getAttribute("data-files-root"),
      workspace,
    );
    await page.locator('[data-files-entry="file"]').first().waitFor();
    const entries = page.locator("[data-files-entry]");
    assert.deepEqual(
      (
        await entries.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-files-path")?.split("/").pop()),
        )
      ).sort(),
      ["README.md", "src"],
    );
    await page.locator('[data-files-entry="directory"]').filter({ hasText: "src" }).click();
    await page.locator('[data-files-entry="file"]').filter({ hasText: "app.ts" }).waitFor();

    // An unsent draft has no Host-confirmed Thread: the same DSH file tree
    // reports it unavailable instead of inventing a directory.
    await page.getByRole("button", { name: "New session", exact: true }).first().click();
    const draftExpand = page.locator("[data-sidebar-right-expand]");
    await draftExpand.waitFor();
    await draftExpand.click();
    const draftGuideEntry = page.locator('[data-sidebar-right-guide-entry="files"]');
    if ((await draftGuideEntry.count()) > 0) await draftGuideEntry.click();
    await page
      .locator('[data-files-state="no-workspace"], [data-files-row="failed"]')
      .first()
      .waitFor();
    assert.deepEqual(errors, []);
  },
);
