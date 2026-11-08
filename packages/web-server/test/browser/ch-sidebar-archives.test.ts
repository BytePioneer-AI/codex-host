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
  "archive responds before a delayed Host write and reports success or rollback asynchronously",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-optimistic-archive-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let gate = Promise.withResolvers<undefined>();
    let refuse = false;
    class DelayedArchiveHost extends FakeChChannel {
      override async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
        if (method === "thread/archive") {
          await gate.promise;
          if (refuse) throw new Error("Archive write refused");
        }
        return super.request<T>(method, params);
      }
    }
    const host = new DelayedArchiveHost();
    host.add("slow", "/computer/generated", "Slow archive", false);
    const channel = await startFakeChChannel(host, directory);
    const debug = await startFakeChDebugger(host);
    t.after(() => gate.resolve(undefined));
    t.after(() => channel.close());
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-control-directory",
        directory,
        "--ch-cdp",
        debug.endpoint,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const row = page.locator('[data-row-key="recent:slow"]');
    await row.waitFor();
    const archive = async () => {
      await row.hover();
      await row.getByRole("button", { name: "Archive session", exact: true }).click();
      await row.waitFor({ state: "detached", timeout: 1000 });
      assert.equal(host.archivedIds.has("slow"), false, "UI updates before the Host commits");
      assert.equal(await page.getByRole("button", { name: "undo", exact: true }).count(), 0);
    };
    await archive();
    gate.resolve(undefined);
    await page.getByRole("button", { name: "undo", exact: true }).waitFor();
    assert.equal(host.archivedIds.has("slow"), true);
    await page.getByRole("button", { name: "undo", exact: true }).click();
    await row.waitFor();

    gate = Promise.withResolvers<undefined>();
    refuse = true;
    await archive();
    gate.resolve(undefined);
    await row.waitFor();
    await page.getByText(/Archive not confirmed.*Archive write refused/).waitFor();
    assert.equal(host.archivedIds.has("slow"), false);
    assert.deepEqual(errors, []);
  },
);

for (const legacyFilter of ["show", "only"]) {
  it(
    `archive filters remain available but page loads hide archives despite saved ${legacyFilter} filter`,
    { timeout: 60_000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "ch-sidebar-archives-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const host = new FakeChChannel();
      host.add("active", "/computer/generated", "Active recent", false);
      host.add("archived", "/computer/generated", "Archived recent", false);
      host.add("project-active", "/computer/project", "Active project");
      host.add("project-archived", "/computer/project", "Archived project");
      host.archivedIds.add("archived");
      host.archivedIds.add("project-archived");
      host.pinnedIds = ["archived", "project-archived"];
      const channel = await startFakeChChannel(host, directory);
      const debug = await startFakeChDebugger(host);
      t.after(() => channel.close());
      t.after(() => debug.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        [
          "--session-source",
          "codexhost",
          "--ch-control-directory",
          directory,
          "--ch-cdp",
          debug.endpoint,
        ],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      // Seed just the first load; later reloads exercise the user's actual saved selection.
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      await page.evaluate((archivedFilter) => {
        localStorage.setItem(
          "dsh.workspace.view.v5",
          JSON.stringify({
            groupBy: "workspace",
            orderBy: "updated",
            groupExpansion: {},
            sessionOrderByAccount: {},
            archivedFilter,
          }),
        );
      }, legacyFilter);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.reload();
      await page.getByText("Native Model", { exact: true }).waitFor();
      const row = (id: string) =>
        page.locator(`[data-row-key="session:${id}"], [data-row-key="recent:${id}"]`).first();
      const selectView = async (name: string) => {
        await page.getByRole("button", { name: "View options", exact: true }).click();
        await page.getByRole("menuitem", { name, exact: true }).click();
      };
      const assertArchivesHidden = async () => {
        assert.equal(await row("archived").count(), 0);
        assert.equal(await row("project-archived").count(), 0);
      };
      await row("active").waitFor();
      const project = page.getByRole("treeitem").filter({ hasText: /^project$/ });
      await project.waitFor();
      if ((await project.getAttribute("aria-expanded")) === "false") await project.click();
      await row("project-active").waitFor();
      await assertArchivesHidden();
      const catalogRequests = () =>
        host.requests.filter((r) => r.method === "codexhost/thread/catalog/read");
      assert.ok(catalogRequests().length > 0);
      assert.ok(
        catalogRequests().every((r) => r.params.includeArchived === false),
        "page load must not query archives",
      );

      await row("active").click();
      host.archivedIds.add("active");
      host.changed("active", "thread/archived");
      await row("active").waitFor({ state: "detached" });
      host.archivedIds.delete("active");
      host.changed("active", "thread/unarchived");
      await row("active").waitFor();

      await row("active").hover();
      await row("active").getByRole("button", { name: "Archive session", exact: true }).click();
      await row("active").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "filter archived sessions", exact: true }).waitFor();
      assert.equal(host.archivedIds.has("active"), true);
      await page.getByRole("button", { name: "undo", exact: true }).click();
      await row("active").waitFor();
      assert.equal(host.archivedIds.has("active"), false);

      await selectView("All conversations (show archived)");
      await row("archived").waitFor();
      await row("project-archived").waitFor();
      await row("active").waitFor();
      assert.ok(
        catalogRequests().some((r) => r.params.includeArchived === true),
        "showing archives must explicitly query them",
      );
      await selectView("Archived only");
      await row("active").waitFor({ state: "detached" });
      await row("project-active").waitFor({ state: "detached" });
      await row("archived").waitFor();
      await selectView("In one list");
      await row("project-archived").waitFor();

      await page.reload();
      await row("active").waitFor();
      await row("project-active").waitFor();
      await assertArchivesHidden();
      assert.equal(
        await page.locator('[data-row-key="workspace:"]').count(),
        0,
        "grouping survives reload",
      );
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      await page.getByPlaceholder("Search session names").fill("Archived");
      await page.getByText("No matching sessions", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear search", exact: true }).click();
      await selectView("All conversations (show archived)");
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      await page.getByPlaceholder("Search session names").fill("Archived");
      await page.getByText("Archived recent", { exact: true }).waitFor();
      await page.getByText("Archived project", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear search", exact: true }).click();
      await selectView("Hide archived");
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      await page.getByPlaceholder("Search session names").fill("Archived");
      await page.getByText("No matching sessions", { exact: true }).waitFor();
      assert.deepEqual(errors, []);
    },
  );
}
