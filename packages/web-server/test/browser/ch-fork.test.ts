import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startServer } from "../support/server.ts";

async function shot(page: Page, name: string) {
  const directory = process.env.CODEXHOST_TEST_SCREENSHOTS;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `fork-${name}.png`), animations: "allow" });
}

for (const supported of [true, false])
  it(
    `Web ordinary fork through sidebar and message actions (supported=${supported})`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChChannel();
      host.inspection.capabilities.history.fork = supported;
      const source = host.add("source", "/computer/project", "Fork source");
      source.turns.push({
        id: "second-native-turn",
        status: "completed",
        items: [
          { id: "u2", type: "userMessage", content: [{ type: "text", text: "Second question" }] },
          { id: "a2", type: "agentMessage", text: "Second answer" },
        ],
      });
      const original = structuredClone(source);
      const debug = await startFakeChDebugger(host);
      t.after(() => debug.close());
      const controlDirectory = mkdtempSync(join(tmpdir(), "ch-fork-channel-"));
      t.after(() => rmSync(controlDirectory, { recursive: true, force: true }));
      const channel = await startFakeChChannel(host, controlDirectory);
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
          ...(supported ? ["--ch-control-directory", controlDirectory] : []),
        ],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const folder = page.getByRole("treeitem").filter({ hasText: /^project$/ });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      const row = page.locator('[data-row-key="session:source"]');
      await row.click();
      await page.getByText("Second answer", { exact: true }).waitFor();
      await row.hover();
      await row.getByRole("button", { name: /^Session actions for/ }).click();
      await shot(page, `sidebar-before-${supported}`);
      await page.getByRole("menuitem", { name: /^Fork session/ }).click();
      if (supported) {
        await page.locator('[data-row-key="session:fork-1"][aria-selected="true"]').waitFor();
        await page.getByText("Second answer", { exact: true }).waitFor();
        assert.equal(host.threads.get("fork-1")?.turns.length, 2);
      } else {
        await page.getByText(/Fork did not complete:.*does not support native forking/).waitFor();
        assert.equal(host.threads.size, 1);
      }
      await shot(page, `sidebar-after-${supported}`);
      await row.click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      const tail = page.locator("[data-turn-tail]").first();
      await tail.hover();
      const branch = tail.getByRole("button", {
        name: "Branch into a new conversation",
        exact: true,
      });
      await shot(page, `message-before-${supported}`);
      await branch.click();
      if (supported) {
        await page.locator('[data-row-key="session:fork-2"][aria-selected="true"]').waitFor();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
        assert.equal(await page.getByText("Second answer", { exact: true }).count(), 0);
        assert.equal(host.threads.get("fork-2")?.turns.length, 1);
        assert.equal(host.threads.get("fork-2")?.cwd, source.cwd);
        assert.deepEqual(
          host.requests.filter((r) => r.method === "codexhost/thread/fork").map((r) => r.params),
          [
            { threadId: "source", lastTurnId: "second-native-turn" },
            { threadId: "source", lastTurnId: "history-source" },
          ],
        );
        await page.reload();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
      } else {
        await page
          .getByRole("alert")
          .filter({ hasText: /does not support native forking/ })
          .waitFor();
        assert.equal(
          host.requests.some((r) => r.method === "codexhost/thread/fork"),
          false,
        );
      }
      await shot(page, `message-after-${supported}`);
      assert.deepEqual(source, original);
      assert.deepEqual(errors, []);
    },
  );
