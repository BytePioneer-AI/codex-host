/** Two clients naturally see one CH Thread store; no real GUI/model/CLI is touched. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const width of [390, 1280])
  it(
    `CH threads and automatic working-directory groups at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      host.add("gui-existing", "/computer/main-project", "From Codex GUI");
      host.add("gui-worktree", "/computer/worktrees/task-a", "From another worktree");
      const debuggerServer = await startFakeChDebugger(host);
      t.after(() => debuggerServer.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--session-source", "codexhost", "--ch-cdp", debuggerServer.endpoint],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 600,
        hasTouch: width < 600,
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      // Wait for initial navigation/settings to settle before opening the mobile
      // sidebar, which otherwise gets closed by the late default selection.
      await page.waitForLoadState("networkidle");
      const open = page.getByRole("button", { name: "Open sidebar", exact: true });
      if (await open.first().isVisible()) await open.first().click();
      const projectFolder = page.getByRole("treeitem").filter({ hasText: /^main-project$/ });
      await projectFolder.waitFor();
      if ((await projectFolder.getAttribute("aria-expanded")) === "false")
        await projectFolder.click();
      await page
        .getByRole("treeitem")
        .filter({ hasText: "From Codex GUI" })
        .waitFor()
        .catch(async (error: unknown) => {
          if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
            mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
            await page.screenshot({
              path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `ch-opening-failure-${width}.png`),
            });
          }
          throw error;
        });
      if (width < 600 && (await open.last().isVisible())) await open.last().click();
      await page
        .getByRole("treeitem")
        .filter({ hasText: /^task-a$/ })
        .click();
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(
            process.env.CODEXHOST_TEST_SCREENSHOTS,
            `ch-directory-observation-${width}.png`,
          ),
          animations: "disabled",
        });
      }
      await page.getByRole("treeitem").filter({ hasText: "From another worktree" }).waitFor();
      const row = page.getByRole("treeitem").filter({ hasText: "From Codex GUI" });
      assert.equal(await row.getAttribute("data-row-key"), "session:gui-existing");
      await row.click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `ch-history-${width}.png`),
          animations: "disabled",
        });
      }
      const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
      if (width < 600) {
        await page
          .getByRole("button", { name: "New session", exact: true })
          .filter({ hasText: "New Session" })
          .waitFor({ state: "hidden" });
        await sidebar.last().click();
      }
      if (process.env.CODEXHOST_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `ch-directories-${width}.png`),
          animations: "disabled",
        });
      await page
        .getByRole("button", { name: "New session", exact: true })
        .filter({ hasText: "New Session" })
        .click();
      // Wait for the requested draft, rather than typing into the previous
      // Thread's still-mounted composer during asynchronous navigation.
      await page.getByText("What should we build today?", { exact: true }).waitFor();
      await page
        .getByRole("textbox", {
          name: "Describe what you want to build, / commands, @ files or sessions",
          exact: true,
        })
        .fill("created in Web");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page
        .getByText("CH response: created in Web", { exact: true })
        .waitFor()
        .catch(async (error: unknown) => {
          if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
            await page.screenshot({
              path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `ch-send-failure-${width}.png`),
            });
          }
          throw error;
        });
      assert.equal(host.requests.filter((r) => r.method === "thread/start").length, 1);
      const newThread = [...host.threads.values()].find((value) =>
        value.id.startsWith("canonical-"),
      );
      assert.ok(newThread);
      assert.ok(
        host.requests.some((r) => r.method === "thread/read" && r.params.threadId === newThread.id),
      );
      await page.reload();
      await page.getByText("CH response: created in Web", { exact: true }).waitFor();
      if (process.env.CODEXHOST_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `ch-canonical-restored-${width}.png`),
          animations: "disabled",
        });
      assert.deepEqual(errors, []);
      assert.equal(
        host.requests.some((r) => r.method.includes("project/")),
        false,
      );
    },
  );

it(
  "shows a native history failure instead of leaving the loading hint indefinitely",
  { timeout: 30_000 },
  async (t) => {
    const host = new FakeChHost();
    host.add("unreadable", "/computer/project", "Unreadable history");
    host.historyError = "Native history unavailable";
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debuggerServer.endpoint],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    await page.getByText("Native Model", { exact: true }).waitFor();
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/ });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Unreadable history" }).click();
    await page.getByText(/Failed to load history:.*Native history unavailable/).waitFor();
    assert.equal(await page.getByText("Loading history…", { exact: true }).count(), 0);
  },
);
