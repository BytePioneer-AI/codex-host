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

async function over(target: Locator, data: JSHandle<DataTransfer>, fraction = 0.5, offsetX = 0) {
  await target.scrollIntoViewIfNeeded();
  return target.evaluate(
    (element, { data, fraction, offsetX }) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: rect.left + rect.width / 2 + offsetX,
          clientY: rect.top + rect.height * fraction,
        }),
      );
      return data.dropEffect;
    },
    { data, fraction, offsetX },
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

it(
  "placement is visible within 100ms while the Host takes one second",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    await expand(page, "parent");
    await expand(page, "child");
    host.placeDelayMs = 1000;
    const source = threadRow(page, "grandchild"),
      target = threadRow(page, "destination");
    const data = await begin(page, source);
    await over(target, data, 0.75);
    const started = performance.now();
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/session/place"),
    );
    await release(source, target, data, 0.75);
    await waitParent(page, "grandchild", null);
    const ids = await page
      .locator('[role="tree"] [data-thread-depth]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")?.split(":")[1]));
    const visibleMs = performance.now() - started;
    assert.equal(
      ids.indexOf("grandchild"),
      ids.indexOf("destination") + 1,
      "manual slot is optimistic too",
    );
    assert.equal(host.placements.size, 0);
    const rpc = await response;
    t.diagnostic(
      `drop to DOM: ${visibleMs.toFixed(0)}ms; RPC: ${(performance.now() - started).toFixed(0)}ms`,
    );
    assert.equal((await rpc.json()).result.ok, true);
    assert.ok(visibleMs < 100, `drop to DOM took ${visibleMs.toFixed(0)}ms`);
  },
);

async function waitHost(host: ThreadTreeBrowserHost, id: string, parent: string | null) {
  const deadline = performance.now() + 8000;
  while (host.placements.get(id) !== parent && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.placements.get(id), parent);
}

async function surfaces(target: Locator) {
  return target.evaluate((row) => {
    const elements = new Set<Element>();
    for (let node = row.parentElement; node; node = node.parentElement) {
      if (node.matches('[data-sidebar-group], [role="tree"], [role="group"]')) {
        elements.add(node);
        const heading = node.querySelector(':scope > [data-row-key^="workspace:"]');
        if (heading) elements.add(heading);
      }
    }
    return [...elements].map((node) => {
      const style = getComputedStyle(node);
      return {
        background: style.background,
        border: style.border,
        outline: style.outline,
        before: getComputedStyle(node, "::before").content,
        after: getComputedStyle(node, "::after").content,
      };
    });
  });
}

async function themedDragShots(page: Page, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(
      (dark) => document.body.hasAttribute("data-ds-dark-theme") === dark,
      colorScheme === "dark",
    );
    await treeShot(page, `${name}-${colorScheme}`);
  }
}

async function savedOrder(page: Page) {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}").sessionOrderByAccount,
  );
}

it(
  "a stable middle dwell attaches children, shows intent, expands ancestry and persists",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    await expand(page, "parent");
    await expand(page, "target-root");
    const source = threadRow(page, "child"),
      target = threadRow(page, "target");
    const before = await surfaces(target);
    const background = await target.evaluate((row) => getComputedStyle(row).background);
    const data = await begin(page, source);
    assert.equal(await over(target, data), "move");
    assert.equal(await target.getAttribute("data-thread-drop"), "after");
    assert.equal(await target.getAttribute("data-thread-dwell"), "true");
    await page.waitForTimeout(550);
    assert.equal(await target.getAttribute("data-thread-drop"), "under");
    assert.equal(await target.getAttribute("data-thread-drop-label"), null);
    assert.equal(await target.evaluate((row) => getComputedStyle(row, "::after").content), "none");
    assert.equal(await target.evaluate((row) => getComputedStyle(row).background), background);
    assert.deepEqual(await surfaces(target), before);
    assert.notEqual(await target.evaluate((row) => getComputedStyle(row).outlineStyle), "none");
    await themedDragShots(page, "thread-tree-drag-row-highlight");
    await release(source, target, data);
    await waitParent(page, "child", "target");
    await waitHost(host, "child", "target");
    assert.equal(await target.getAttribute("aria-expanded"), "true");
    assert.equal(await threadRow(page, "target-root").getAttribute("aria-expanded"), "true");
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}").sessionOrderByAccount?.[
          "thread:target"
        ]?.join(",") === "child",
    );
    assert.equal(await page.locator("[data-thread-drop]").count(), 0);
    await page.reload();
    await page.getByText("Native Model", { exact: true }).waitFor();
    await waitParent(page, "child", "target");
    // Updated ordering changes the displayed parent without a manual before/after slot.
    await viewOption(page, "Last updated");
    const root = threadRow(page, "destination");
    const rootData = await begin(page, root);
    await over(target, rootData);
    await page.waitForTimeout(200);
    assert.equal(await target.evaluate((row) => getComputedStyle(row).backgroundImage), "none");
    assert.equal(await target.getAttribute("data-thread-drop-label"), null);
    assert.equal(await over(target, rootData, 0.05), "move");
    assert.equal(await target.getAttribute("data-thread-drop"), "sibling");
    assert.equal(
      await page.locator('[data-thread-drop="before"], [data-thread-drop="after"]').count(),
      0,
    );
    await release(root, target, rootData, 0.05);
    await waitParent(page, "destination", "target-root");
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
    const attach = await begin(page, source);
    await over(root, attach);
    await page.waitForTimeout(550);
    await release(source, root, attach);
    await waitParent(page, "child", "destination");
    await waitHost(host, "child", "destination");
  },
);

for (const { failFirst, reorder } of [
  { failFirst: false, reorder: false },
  { failFirst: true, reorder: false },
  { failFirst: true, reorder: true },
]) {
  it(
    `two quick placements retain the latest position when the first ${failFirst ? "fails" : "succeeds"}${reorder ? " and the second only reorders" : ""}`,
    { timeout: 60_000 },
    async (t) => {
      const { page, host } = await threadTreeBrowser(t);
      await viewOption(page, "In one list");
      await viewOption(page, "Manual");
      await expand(page, "parent");
      await expand(page, "target-root");
      host.placeDelayMs = 1000;
      if (failFirst) host.placeError = "First placement refused.";
      const child = threadRow(page, "child"),
        destination = threadRow(page, "destination"),
        target = threadRow(page, "target");
      const first = await begin(page, child);
      const firstTarget = reorder ? target : destination;
      await over(firstTarget, first, 0.75);
      await release(child, firstTarget, first, 0.75);
      await waitParent(page, "child", reorder ? "target-root" : null);
      const deadline = performance.now() + 1000;
      while (
        !host.requests.some((request) => request.method === "codexhost/thread/tree/place") &&
        performance.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(host.requests.some((request) => request.method === "codexhost/thread/tree/place"));
      host.placeError = undefined;
      const second = await begin(page, child);
      const fraction = reorder ? 0.25 : 0.75;
      await over(target, second, fraction);
      const started = performance.now();
      await release(child, target, second, fraction);
      await waitParent(page, "child", "target-root");
      assert.ok(performance.now() - started < 100);
      const monitor = await page.evaluateHandle(() => {
        const parents: (string | null)[] = [];
        const observer = new MutationObserver(() => {
          const row = document.querySelector('[data-row-key="session:child"]');
          parents.push(row?.getAttribute("data-thread-parent") ?? null);
        });
        observer.observe(document.body, { childList: true, attributes: true, subtree: true });
        return { parents, observer };
      });
      await waitHost(host, "child", "target-root");
      await page.waitForFunction(
        (order) =>
          JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}").sessionOrderByAccount?.[
            "thread:target-root"
          ]?.join(",") === order,
        reorder ? "child,target" : "target,child",
      );
      await page.waitForTimeout(150);
      const observed = await monitor.evaluate((monitor) => {
        monitor.observer.disconnect();
        return monitor.parents;
      });
      await monitor.dispose();
      assert.ok(observed.length > 0);
      assert.ok(
        observed.every((parent) => parent === "target-root"),
        JSON.stringify(observed),
      );
      if (failFirst)
        await page
          .getByText("Could not move session: First placement refused.", { exact: true })
          .waitFor();
      await page.reload();
      await page.getByText("Native Model", { exact: true }).waitFor();
      await waitParent(page, "child", "target-root");
    },
  );
}

it(
  "self, descendants, current parent and archived rows reject without feedback or writes",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await viewOption(page, "All conversations (show archived)");
    await viewOption(page, "Manual");
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
      for (const fraction of [0.1, 0.5, 0.9]) {
        assert.equal(await over(target, data, fraction), "none", targetId);
        assert.equal(await target.getAttribute("data-thread-drop"), null);
        assert.equal(await target.getAttribute("data-thread-dwell"), null);
      }
      await release(source, target, data);
    }
    assert.deepEqual(writes, []);
    assert.equal(host.placements.size, 0);
    assert.equal(host.parents.child, "parent");
  },
);

it(
  "manual halves move a three-level subtree to a specified root slot, reorder children and retain both after reload",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    await expand(page, "parent");
    await expand(page, "child");
    const source = threadRow(page, "grandchild");
    const target = threadRow(page, "parent");
    const before = await surfaces(target);
    const rowBefore = await target.evaluate((row) => ({
      background: getComputedStyle(row).background,
      outline: getComputedStyle(row).outline,
    }));
    const data = await begin(page, source);
    assert.equal(await over(target, data, 0.75), "move");
    assert.equal(await target.getAttribute("data-thread-drop"), "after");
    assert.equal(await page.locator("[data-thread-drop]").count(), 1);
    assert.deepEqual(await surfaces(target), before);
    assert.deepEqual(
      await target.evaluate((row) => ({
        background: getComputedStyle(row).background,
        outline: getComputedStyle(row).outline,
      })),
      rowBefore,
    );
    const line = await target.evaluate((row) => {
      const style = getComputedStyle(row, "::after");
      return { content: style.content, height: style.height, color: style.backgroundColor };
    });
    assert.equal(line.content, '\"\"');
    assert.equal(line.height, "3px");
    assert.notEqual(line.color, "rgba(0, 0, 0, 0)");
    await themedDragShots(page, "thread-tree-drag-insertion-line");
    await release(source, target, data, 0.75);
    await waitParent(page, "grandchild", null);
    await page.waitForFunction(() => {
      const order =
        JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}").sessionOrderByAccount
          ?.__flat_session_order__ ?? [];
      return order.indexOf("grandchild") === order.indexOf("parent") + 1;
    });
    await waitHost(host, "grandchild", null);
    assert.equal(await source.getAttribute("data-thread-depth"), "0");
    await treeShot(page, "thread-tree-drag-three-level-to-root");

    // Immediate center release means sibling, not child; this also creates a second child to reorder.
    const destination = threadRow(page, "destination");
    const child = threadRow(page, "child");
    const quick = await begin(page, destination);
    assert.equal(await over(child, quick), "move");
    assert.equal(await child.getAttribute("data-thread-drop"), "after");
    await release(destination, child, quick);
    await waitParent(page, "destination", "parent");
    await waitHost(host, "destination", "parent");
    const reorder = await begin(page, destination);
    await over(child, reorder, 0.25);
    await release(destination, child, reorder, 0.25);
    await page.waitForFunction(() => {
      const order = JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}")
        .sessionOrderByAccount?.["thread:parent"];
      return order?.[0] === "destination" && order?.[1] === "child";
    });
    const after = await savedOrder(page);
    await page.reload();
    await page.getByText("Native Model", { exact: true }).waitFor();
    await waitParent(page, "grandchild", null);
    await waitParent(page, "destination", "parent");
    assert.deepEqual(await savedOrder(page), after);
    const ids = await page
      .locator('[role="tree"] [data-thread-depth]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")?.split(":")[1]));
    assert.equal(ids.indexOf("grandchild"), ids.indexOf("child") + 1);
    assert.ok(ids.indexOf("destination") < ids.indexOf("child"));
    const canceled = await begin(page, source);
    await over(target, canceled, 0.1);
    assert.equal(await over(source, canceled), "none");
    await release(source, source, canceled);
    assert.deepEqual(await savedOrder(page), after, "rejected drops clear insertion markers");
  },
);

it(
  "drifting inside the row keeps the dwell and leaving the row edges cancels child intent",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    const source = threadRow(page, "destination");
    const target = threadRow(page, "parent");
    const data = await begin(page, source);
    await over(target, data);
    await page.waitForTimeout(300);
    await over(target, data, 0.5, 30);
    await page.waitForTimeout(250);
    assert.equal(await target.getAttribute("data-thread-drop"), "under");
    await over(target, data, 0.15);
    assert.equal(await target.getAttribute("data-thread-drop"), "under");
    await over(target, data, 0.05);
    assert.equal(await target.getAttribute("data-thread-drop"), "before");
    assert.equal(await target.getAttribute("data-thread-dwell"), null);
    await release(source, target, data, 0.05);
    assert.equal(host.placements.size, 0);
    assert.equal(await source.getAttribute("data-thread-parent"), null);
  },
);

async function folderBrowser(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "thread-tree-drag-folders-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new ThreadTreeBrowserHost();
  host.add("parent", "/computer/own", "Own parent");
  host.add("child", "/computer/own", "Own child", false);
  host.projectSnapshot.assignments.child = "project-parent";
  host.add("own-target", "/computer/own", "Own target", false);
  host.projectSnapshot.assignments["own-target"] = "project-parent";
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

for (const folder of [false, true]) {
  it(
    `row insertion never colors the ${folder ? "workspace" : "Recents"} group, even after its header was targeted`,
    { timeout: 60_000 },
    async (t) => {
      const fixture = folder ? await folderBrowser(t) : await threadTreeBrowser(t);
      const { page } = fixture;
      await viewOption(page, "Manual");
      await expand(page, "parent");
      const heading = "own" in fixture ? fixture.own : page.locator('[data-row-key="workspace:"]');
      const target = threadRow(page, folder ? "own-target" : "destination");
      const source = threadRow(page, "child");
      const before = await surfaces(target);
      const group = heading.locator("xpath=ancestor::*[@data-sidebar-group][1]");
      const groupStyle = await group.evaluate((node) => ({
        background: getComputedStyle(node).background,
        outline: getComputedStyle(node).outline,
        border: getComputedStyle(node).border,
      }));
      const data = await begin(page, source);
      await over(heading, data);
      assert.equal(await heading.getAttribute("data-thread-drop"), "top");
      assert.equal(await heading.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
      assert.deepEqual(
        await group.evaluate((node) => ({
          background: getComputedStyle(node).background,
          outline: getComputedStyle(node).outline,
          border: getComputedStyle(node).border,
        })),
        groupStyle,
      );
      await over(target, data, 0.75);
      assert.equal(await heading.getAttribute("data-thread-drop"), null);
      assert.equal(await target.getAttribute("data-thread-drop"), "after");
      assert.deepEqual(await surfaces(target), before);
      assert.equal(await page.locator("[data-thread-drop]").count(), 1);
      assert.equal(await target.evaluate((node) => getComputedStyle(node).outlineStyle), "none");
      assert.equal(
        await target.evaluate((node) => getComputedStyle(node, "::after").height),
        "3px",
      );
      await themedDragShots(page, `thread-tree-drag-${folder ? "workspace" : "recents"}-line`);
      await over(target, data);
      await page.waitForTimeout(550);
      assert.equal(await target.getAttribute("data-thread-drop"), "under");
      assert.equal(await target.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
      assert.equal(
        await target.evaluate((node) => getComputedStyle(node, "::after").content),
        "none",
      );
      assert.equal(await page.locator("[data-thread-drop-label]").count(), 0);
      await themedDragShots(page, `thread-tree-drag-${folder ? "workspace" : "recents"}-outline`);
      await source.dispatchEvent("dragend", { dataTransfer: data });
      await data.dispose();
    },
  );
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
    await waitHost(host, "child", null);
    assert.equal(host.delegations.child, "parent");
    // Restore through the same row gesture, then release on the group's actual list container.
    const attach = await begin(page, child);
    await over(threadRow(page, "parent"), attach);
    await page.waitForTimeout(550);
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
    await waitHost(host, "child", null);
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
    await over(threadRow(page, "child"), data);
    await page.waitForTimeout(550);
    await release(source, threadRow(page, "child"), data);
    await waitParent(page, "destination", "child");
    await waitHost(host, "destination", "child");
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
    await over(threadRow(page, "destination"), data, 0.1);
    await over(content, data);
    assert.equal(await page.locator("[data-thread-drop]").count(), 0);
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
        assert.equal(
          await threadRow(page, "child").getAttribute("draggable"),
          touch ? "false" : "true",
        );
        await threadMenu(page, "child");
        if (touch && width === 390) await treeShot(page, "thread-tree-drag-phone-menu");
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
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    const originalOrder = await savedOrder(page);
    host.placeError = "Placement rejected by Host.";
    host.placeDelayMs = 1000;
    const source = threadRow(page, "child"),
      target = threadRow(page, "destination");
    const data = await begin(page, source);
    await over(target, data);
    await release(source, target, data);
    await waitParent(page, "child", null);
    assert.equal(host.parents.child, "parent", "Host has not completed the write");
    await page
      .getByText("Could not move session: Placement rejected by Host.", { exact: true })
      .waitFor();
    assert.equal(host.parents.child, "parent");
    await waitParent(page, "child", "parent");
    assert.deepEqual(await savedOrder(page), originalOrder);
    assert.equal(await page.locator("[data-thread-drop]").count(), 0);
  },
);
