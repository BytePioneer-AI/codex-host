/** Real DragEvent/DataTransfer input against production Web endpoints and an isolated fixture Host. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type JSHandle, type Locator, type Page } from "playwright";
import { startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import {
  ThreadTreeBrowserHost,
  openSidebar,
  threadMenu,
  threadRow,
  threadTreeBrowser,
  treeShot,
  viewOption,
} from "../support/thread-tree-browser.ts";

async function expand(page: Page, id: string): Promise<void> {
  const row = threadRow(page, id);
  if ((await row.getAttribute("aria-expanded")) === "false")
    await row.locator("[data-thread-toggle]").click();
}

async function begin(page: Page, source: Locator): Promise<JSHandle<DataTransfer>> {
  await source.waitFor();
  const data = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    // Chromium protects native drag effects outside a trusted drag. Record the
    // handlers' requested effects on the real transfer used by our DragEvents.
    Object.defineProperty(data, "dropEffect", { value: "none", writable: true });
    return data;
  });
  await source.dispatchEvent("dragstart", { dataTransfer: data });
  return data;
}

async function over(target: Locator, data: JSHandle<DataTransfer>, fraction = 0.5) {
  await target.scrollIntoViewIfNeeded();
  return target.evaluate(
    (element, { data, fraction }) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height * fraction,
        }),
      );
      return data.dropEffect;
    },
    { data, fraction },
  );
}

async function release(
  source: Locator,
  target: Locator,
  data: JSHandle<DataTransfer>,
  fraction = 0.5,
) {
  await target.evaluate(
    (element, { data, fraction }) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height * fraction,
        }),
      );
    },
    { data, fraction },
  );
  if (await source.count()) await source.dispatchEvent("dragend", { dataTransfer: data });
  await data.dispose();
}

async function waitParent(page: Page, id: string, parent: string | null) {
  await page.waitForFunction(
    ({ id, parent }) => {
      const row = document.querySelector(
        `[data-row-key="recent:${id}"], [data-row-key="session:${id}"]`,
      );
      return row !== null && row.getAttribute("data-thread-parent") === parent;
    },
    { id, parent },
  );
}

async function savedOrder(page: Page) {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}").sessionOrderByAccount,
  );
}

it(
  "row centers attach roots and children, expand target ancestry, and persist across reload",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    await expand(page, "parent");
    await expand(page, "target-root");
    const source = threadRow(page, "child"),
      target = threadRow(page, "target");
    const before = await savedOrder(page);
    const data = await begin(page, source);
    assert.equal(await over(target, data), "move");
    assert.equal(await target.getAttribute("data-thread-drop"), "under");
    assert.notEqual(await target.evaluate((row) => getComputedStyle(row).outlineStyle), "none");
    await treeShot(page, "thread-tree-drag-row-highlight");
    await release(source, target, data);
    await waitParent(page, "child", "target");
    assert.equal(host.placements.get("child"), "target");
    assert.equal(await target.getAttribute("aria-expanded"), "true");
    assert.equal(await threadRow(page, "target-root").getAttribute("aria-expanded"), "true");
    assert.deepEqual(await savedOrder(page), before, "a child drag never changes manual order");
    assert.equal(await page.locator("[data-thread-drop]").count(), 0);
    await page.reload();
    await page.getByText("Native Model", { exact: true }).waitFor();
    await waitParent(page, "child", "target");
    // Updated ordering uses the entire row, including its outer edge, for placement.
    await viewOption(page, "Last updated");
    const root = threadRow(page, "destination");
    const rootData = await begin(page, root);
    assert.equal(await over(target, rootData, 0.05), "move");
    assert.equal(await target.getAttribute("data-thread-drop"), "under");
    await release(root, target, rootData, 0.05);
    await waitParent(page, "destination", "target");
    assert.equal(
      await page.evaluate(() => {
        const event = new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
        });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      false,
      "a moved source must not leave native sorting acceptance active",
    );
    await source.dragTo(root);
    await waitParent(page, "child", "destination");
    assert.equal(host.placements.get("child"), "destination");
  },
);

it(
  "self, descendants, current parent and archived rows reject without feedback or writes",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await viewOption(page, "All conversations (show archived)");
    await expand(page, "parent");
    await expand(page, "child");
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/session/place")) writes.push(request.url());
    });
    const rejected: [string, string][] = [
      ["parent", "parent"],
      ["parent", "child"],
      ["parent", "grandchild"],
      ["child", "parent"],
      ["child", "archived"],
      ["archived", "destination"],
    ];
    for (const [sourceId, targetId] of rejected) {
      const source = threadRow(page, sourceId),
        target = threadRow(page, targetId);
      const data = await begin(page, source);
      assert.equal(await over(target, data), "none", targetId);
      assert.equal(await target.getAttribute("data-thread-drop"), null);
      await release(source, target, data);
    }
    assert.deepEqual(writes, []);
    assert.equal(host.placements.size, 0);
    assert.equal(host.parents.child, "parent");
  },
);

it(
  "manual edges still reorder roots, but children cannot reorder and entering a rejected center clears stale markers",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    const roots = page.locator('[role="tree"] [data-thread-depth="0"]');
    const sourceKey = await roots.last().getAttribute("data-row-key");
    const targetKey = await roots.first().getAttribute("data-row-key");
    assert.ok(sourceKey && targetKey && sourceKey !== targetKey);
    const source = page.locator(`[data-row-key="${sourceKey}"]`);
    const target = page.locator(`[data-row-key="${targetKey}"]`);
    const before = await savedOrder(page);
    const data = await begin(page, source);
    assert.equal(await over(target, data, 0.1), "move");
    assert.equal(await target.getAttribute("data-thread-drop"), null);
    await release(source, target, data, 0.1);
    await page.waitForFunction(
      (before) =>
        JSON.stringify(
          JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}").sessionOrderByAccount,
        ) !== before,
      JSON.stringify(before),
    );
    assert.equal(host.placements.size, 0);
    const insertedBefore = await savedOrder(page);
    const bottom = await begin(page, source);
    assert.equal(await over(target, bottom, 0.9), "move");
    assert.equal(await target.getAttribute("data-thread-drop"), null);
    await release(source, target, bottom, 0.9);
    await page.waitForFunction(
      (before) =>
        JSON.stringify(
          JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}").sessionOrderByAccount,
        ) !== before,
      JSON.stringify(insertedBefore),
    );
    assert.equal(host.placements.size, 0);
    await expand(page, "parent");
    const child = threadRow(page, "child");
    const after = await savedOrder(page);
    const childData = await begin(page, child);
    assert.equal(await over(source, childData, 0.05), "none");
    await release(child, source, childData, 0.05);
    assert.deepEqual(await savedOrder(page), after);
    const canceled = await begin(page, source);
    await over(target, canceled, 0.1);
    assert.equal(await over(source, canceled), "none");
    await release(source, source, canceled);
    assert.deepEqual(
      await savedOrder(page),
      after,
      "the last sort marker must not commit on a rejected drop",
    );
  },
);

async function folderBrowser(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "thread-tree-drag-folders-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new ThreadTreeBrowserHost();
  host.add("parent", "/computer/own", "Own parent");
  host.add("child", "/computer/own", "Own child", false);
  host.projectSnapshot.assignments.child = "project-parent";
  host.projectSnapshot.projectless.splice(0);
  host.add("other", "/computer/other", "Other conversation");
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
      "--adapters",
      "test/fake-harness",
    ],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    locale: "en-US",
  });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(url);
  await page.getByText("Native Model", { exact: true }).waitFor();
  const own = page.locator('[data-row-key^="workspace:"]').filter({ hasText: /^own$/ });
  const other = page.locator('[data-row-key^="workspace:"]').filter({ hasText: /^other$/ });
  await own.waitFor();
  await other.waitFor();
  if ((await own.getAttribute("aria-expanded")) === "false") await own.click();
  await expand(page, "parent");
  return { page, host, own, other };
}

it(
  "only the owning group header or list whitespace detaches the displayed parent",
  { timeout: 60_000 },
  async (t) => {
    const { page, host, own } = await folderBrowser(t);
    const child = threadRow(page, "child");
    const data = await begin(page, child);
    assert.equal(await over(own, data), "move");
    assert.equal(await own.getAttribute("data-thread-drop"), "top");
    await treeShot(page, "thread-tree-drag-group-highlight");
    await release(child, own, data);
    await waitParent(page, "child", null);
    assert.equal(host.placements.get("child"), null);
    assert.equal(host.delegations.child, "parent");
    // Restore through the same row gesture, then release on the group's actual list container.
    const attach = await begin(page, child);
    await over(threadRow(page, "parent"), attach);
    await release(child, threadRow(page, "parent"), attach);
    await waitParent(page, "child", "parent");
    const whitespace = own
      .locator("xpath=ancestor::*[@data-sidebar-group][1]")
      .locator(':scope > [role="group"]')
      .last();
    const detach = await begin(page, child);
    assert.equal(await over(whitespace, detach), "move");
    await release(child, whitespace, detach);
    await waitParent(page, "child", null);
  },
);

it(
  "the Recents header also detaches a child from its displayed parent",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await expand(page, "parent");
    const child = threadRow(page, "child");
    const heading = page.locator('[data-row-key="workspace:"]');
    const data = await begin(page, child);
    assert.equal(await over(heading, data), "move");
    assert.equal(await heading.getAttribute("data-thread-drop"), "top");
    await release(child, heading, data);
    await waitParent(page, "child", null);
    assert.equal(host.placements.get("child"), null);
  },
);

it(
  "a foreign group header calls folder membership only and leaves display lineage unchanged",
  { timeout: 60_000 },
  async (t) => {
    const { page, host, other } = await folderBrowser(t);
    const calls: { method: string; request: Record<string, unknown> }[] = [];
    page.on("request", (request) => {
      for (const method of ["workspace/insertSessionBefore", "session/place"])
        if (request.url().endsWith(`/api/${method}`))
          calls.push({ method, request: request.postDataJSON().payload.args.request });
    });
    const before = { ...host.parents };
    const child = threadRow(page, "child");
    const data = await begin(page, child);
    assert.equal(await over(other, data), "move");
    assert.equal(await other.getAttribute("data-thread-drop"), "folder");
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/insertSessionBefore"),
    );
    await release(child, other, data);
    assert.equal((await (await response).json()).result.ok, true);
    assert.deepEqual(calls, [
      {
        method: "workspace/insertSessionBefore",
        request: {
          workspaceId: (await other.getAttribute("data-row-key"))?.slice("workspace:".length),
          sessionId: "child",
        },
      },
    ]);
    assert.deepEqual(host.parents, before);
    await waitParent(page, "child", "parent");
    assert.equal(host.placements.size, 0);
    // Catalog membership persistence is a known, pre-existing backend issue outside this UI test.
  },
);

it(
  "hover expands after a dwell, but leaving, dropping, Escape and blur cancel the timer and feedback",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    const source = threadRow(page, "destination"),
      target = threadRow(page, "parent");
    for (const cancel of ["leave", "drop", "Escape", "blur"]) {
      const data = await begin(page, source);
      await over(target, data);
      if (cancel === "leave") await target.dispatchEvent("dragleave", { dataTransfer: data });
      else if (cancel === "drop") {
        await release(source, source, data);
      } else if (cancel === "Escape") await page.keyboard.press("Escape");
      else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.waitForTimeout(700);
      assert.equal(await target.getAttribute("aria-expanded"), "false", cancel);
      assert.equal(await page.locator("[data-thread-drop]").count(), 0, cancel);
      if (cancel !== "drop") {
        await source.dispatchEvent("dragend", { dataTransfer: data });
        await data.dispose();
      }
    }
    const data = await begin(page, source);
    await over(target, data);
    await page.waitForTimeout(300);
    assert.equal(await target.getAttribute("aria-expanded"), "false");
    await threadRow(page, "child").waitFor();
    assert.equal(await target.getAttribute("aria-expanded"), "true");
    await release(source, threadRow(page, "child"), data);
    await waitParent(page, "destination", "child");
    assert.equal(host.placements.get("destination"), "child");
  },
);

it(
  "a child keeps its native reference payload and can still drop into chat",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t, 1280, "destination");
    await expand(page, "parent");
    const source = threadRow(page, "child");
    const data = await begin(page, source);
    const types = await data.evaluate((data) => [...data.types]);
    assert.ok(types.some((type) => type.includes("thread")));
    const content = page.locator('[data-conversation-session="destination"]');
    await over(content, data);
    await page.locator("[data-thread-reference-drop]").waitFor();
    await release(source, content, data);
    const chip = content.locator('[data-composer-chip="codexhost-thread"]');
    await chip.waitFor();
    assert.equal(await chip.innerText(), "Delegated implementation");
    assert.equal(host.placements.size, 0);
    assert.equal(
      host.requests.some((request) => request.method === "turn/start"),
      false,
    );
  },
);

for (const touch of [false, true])
  for (const width of [390, 1280]) {
    it(
      `placement menus follow sidebar input capability (${touch ? "touch" : "mouse"}, ${width}px)`,
      { timeout: 60_000 },
      async (t) => {
        const { page, host } = await threadTreeBrowser(t, touch ? 390 : 1280);
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(
          (phone) => Boolean(document.querySelector("[data-phone]")) === phone,
          width < 640,
        );
        await openSidebar(page);
        await expand(page, "parent");
        await threadMenu(page, "child");
        const move = page.getByRole("menuitem", { name: "Move under…", exact: true });
        const top = page.getByRole("menuitem", { name: "Move to top level", exact: true });
        assert.equal(await move.count(), touch ? 1 : 0);
        assert.equal(await top.count(), touch ? 1 : 0);
        if (!touch) return;
        await move.click();
        const picker = page.getByRole("dialog", { name: "Move under…", exact: true });
        if (width === 390) await treeShot(page, "thread-tree-drag-phone-placement-picker");
        await picker.getByRole("button", { name: /^Move target/ }).click();
        await picker.waitFor({ state: "hidden" });
        await openSidebar(page);
        await waitParent(page, "child", "target");
        assert.equal(host.placements.get("child"), "target");
        await threadMenu(page, "child");
        await page.getByRole("menuitem", { name: "Move to top level", exact: true }).click();
        await openSidebar(page);
        await waitParent(page, "child", null);
        assert.equal(host.placements.get("child"), null);
      },
    );
  }

it(
  "a refused drag placement uses the existing row-operation error without changing lineage",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await expand(page, "parent");
    host.placeError = "Placement rejected by Host.";
    const source = threadRow(page, "child"),
      target = threadRow(page, "destination");
    const data = await begin(page, source);
    await over(target, data);
    await release(source, target, data);
    await page
      .getByText("Could not move session: Placement rejected by Host.", { exact: true })
      .waitFor();
    assert.equal(host.parents.child, "parent");
    assert.equal(await source.getAttribute("data-thread-parent"), "parent");
    assert.equal(await page.locator("[data-thread-drop]").count(), 0);
  },
);
