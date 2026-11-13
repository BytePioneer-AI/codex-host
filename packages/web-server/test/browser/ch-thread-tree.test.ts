/** Sidebar acceptance against the real Web endpoints and an isolated protocol fixture Host. */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Locator, Page } from "playwright";
import {
  openSidebar,
  threadMenu,
  threadRow,
  threadTreeBrowser,
  treeShot,
  viewOption,
} from "../support/thread-tree-browser.ts";

async function expanded(page: Page, id: string, value: boolean): Promise<void> {
  const row = threadRow(page, id);
  await row.waitFor();
  if ((await row.getAttribute("aria-expanded")) !== String(value))
    await row.locator("[data-thread-toggle]").click();
  await page.waitForFunction(
    ({ id, value }) => {
      const row = document.querySelector(
        `[data-row-key="recent:${id}"], [data-row-key="session:${id}"]`,
      );
      return row?.getAttribute("aria-expanded") === String(value);
    },
    { id, value },
  );
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.locator('[role="tree"]').evaluateAll((trees) =>
    trees.flatMap((tree) =>
      [tree, ...tree.querySelectorAll("[data-row-key]")]
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => ({
          key: node.getAttribute("data-row-key"),
          width: node.clientWidth,
          scroll: node.scrollWidth,
        })),
    ),
  );
  assert.deepEqual(overflow, [], "the tree and its rows fit the phone sidebar");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

async function rowAlignment(page: Page, id: string) {
  return threadRow(page, id).evaluate((node) => {
    const icon = node.querySelector("[data-harness-id]");
    const title = node.querySelector("[data-session-title]");
    if (!icon || !title) throw new Error("Missing row identity or title");
    const left = node.getBoundingClientRect().x;
    return {
      icon: Math.round(icon.getBoundingClientRect().x - left),
      title: Math.round(title.getBoundingClientRect().x - left),
    };
  });
}

for (const width of [1280, 390]) {
  it(
    `delegated trees fold, persist, support keyboard navigation and cap indentation at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { page, host } = await threadTreeBrowser(t, width);
      const parent = threadRow(page, "parent");
      await parent.waitFor();
      assert.equal(await parent.getAttribute("aria-expanded"), "false");
      await parent.getByRole("button", { name: "Expand 4 child sessions", exact: true }).waitFor();
      assert.deepEqual(
        await rowAlignment(page, "parent"),
        await rowAlignment(page, "destination"),
        "root icons and titles align with or without a fold control",
      );
      assert.equal(await parent.locator("[data-thread-toggle] svg").count(), 1);
      assert.equal(
        await parent
          .locator("[data-thread-toggle]")
          .evaluate((node) => getComputedStyle(node).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      assert.equal(await threadRow(page, "child").count(), 0);
      assert.equal(await page.locator('[data-row-key="section:pinned"]').count(), 0);
      await parent.getByRole("img", { name: "Child sessions are running", exact: true }).waitFor();
      assert.equal(await page.getByText("Native worker", { exact: true }).count(), 0);
      await expanded(page, "parent", true);
      await expanded(page, "child", true);
      await threadRow(page, "grandchild").waitFor();
      assert.equal(await threadRow(page, "child").getAttribute("data-thread-parent"), "parent");
      assert.equal(await threadRow(page, "grandchild").getAttribute("data-thread-depth"), "2");
      assert.equal(
        await parent.locator("[data-thread-tree-activity]").count(),
        0,
        "expanded rows show their own state only",
      );
      const rootPosition = await rowAlignment(page, "parent");
      const childPosition = await rowAlignment(page, "child");
      const grandchildPosition = await rowAlignment(page, "grandchild");
      assert.equal(childPosition.icon - rootPosition.icon, 16);
      assert.equal(grandchildPosition.title - childPosition.title, 16);
      await page.mouse.move(width - 10, 850);
      if (width === 390)
        assert.equal(
          await threadRow(page, "child")
            .locator("[data-thread-toggle]")
            .evaluate((node) => getComputedStyle(node).backgroundColor),
          "rgba(0, 0, 0, 0)",
          "touch focus does not leave a filled toggle",
        );
      await treeShot(page, `thread-tree-${width}-expanded`);
      await page.reload();
      await page.getByText("Native Model", { exact: true }).waitFor();
      await openSidebar(page);
      await threadRow(page, "grandchild").waitFor();
      assert.equal(await parent.getAttribute("aria-expanded"), "true");
      assert.equal(await threadRow(page, "child").getAttribute("aria-expanded"), "true");
      // Arrow keys fold a Thread instead of opening it, and enter its first child.
      await parent.focus();
      await page.keyboard.press("ArrowLeft");
      await threadRow(page, "child").waitFor({ state: "detached" });
      await page.keyboard.press("ArrowRight");
      await threadRow(page, "child").waitFor();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await threadRow(page, "child").evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("ArrowLeft");
      assert.equal(await threadRow(page, "child").getAttribute("aria-expanded"), "false");
      await page.keyboard.press("ArrowLeft");
      assert.equal(await parent.evaluate((node) => node === document.activeElement), true);
      await expanded(page, "child", true);
      await expanded(page, "grandchild", true);
      await expanded(page, "deep", true);
      await threadRow(page, "deepest").waitFor();
      assert.equal(await threadRow(page, "deepest").getAttribute("aria-level"), "5");
      const indent = async (id: string) =>
        threadRow(page, id).evaluate((node) => getComputedStyle(node).paddingInlineStart);
      assert.equal(await indent("deepest"), await indent("deep"));
      assert.notEqual(await indent("grandchild"), await indent("deep"));
      await noHorizontalOverflow(page);
      assert.deepEqual(host.pinnedIds, ["child"], "Web never writes the child's shared pin");
      assert.equal(host.pinWrites.length, 0);
    },
  );
}

it(
  "deeply expanded long titles stay ellipsized inside the 390px sidebar",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t, 390);
    for (const id of ["parent", "child", "grandchild", "deep"]) await expanded(page, id, true);
    const titles = {
      parent:
        "Release plan — coordinate implementation, validation and deployment across several workspaces",
      child:
        "Delegated implementation — update the sidebar and preserve all existing conversation capabilities",
      grandchild:
        "Approval checks — review pending changes and verify desktop and mobile behavior before continuing",
      deep: "Deep review — inspect edge cases, keyboard navigation and exceptionally long conversation titles",
      deepest:
        "Nested follow-up — confirm the indentation cap keeps every deeper conversation inside the sidebar",
    };
    for (const [id, title] of Object.entries(titles)) {
      const thread = host.threads.get(id);
      assert.ok(thread);
      thread.name = title;
      host.changed(id, "thread/name/updated");
    }
    for (const [id, title] of Object.entries(titles)) {
      const label = threadRow(page, id).locator("[data-session-title]");
      await threadRow(page, id).getByText(title, { exact: true }).waitFor();
      assert.deepEqual(
        await label.evaluate((node) => ({
          ellipsis: getComputedStyle(node).textOverflow,
          clipped: node.scrollWidth > node.clientWidth,
        })),
        { ellipsis: "ellipsis", clipped: true },
      );
    }
    assert.deepEqual(await rowAlignment(page, "deep"), await rowAlignment(page, "deepest"));
    await noHorizontalOverflow(page);
    await treeShot(page, "thread-tree-390-expanded-long-titles");
  },
);

it(
  "deep links expand ancestors; background approvals and running descendants remain visible on collapsed roots",
  { timeout: 60_000 },
  async (t) => {
    const { page, host, url } = await threadTreeBrowser(t, 390, "grandchild");
    for (const id of ["parent", "child"])
      assert.equal(await threadRow(page, id).getAttribute("aria-expanded"), "true");
    assert.equal(await threadRow(page, "grandchild").getAttribute("aria-selected"), "true");
    host.pending = [
      {
        requestId: -71,
        threadId: "grandchild",
        kind: "approval",
        interaction: {
          type: "approval",
          title: "Approve review checks",
          description: "Run the review checks?",
          actions: [
            { id: "once", label: "Allow once", effect: "allowOnce" },
            { id: "no", label: "Deny", effect: "deny" },
          ],
        },
        request: {
          method: "mcpServer/elicitation/request",
          params: { requestedSchema: { type: "object", properties: {} } },
        },
      },
    ];
    host.changed("grandchild", "mcpServer/elicitation/request");
    // Close only this test's drawer so the real approval surface can be observed.
    await threadRow(page, "grandchild").click();
    await page.getByRole("radio", { name: "Allow once", exact: true }).waitFor();
    await openSidebar(page);
    await threadRow(page, "destination").click();
    await page.locator('[data-conversation-session="destination"] [data-composer-input]').waitFor();
    await page.locator("[data-phone][data-sidebar-hidden]").waitFor();
    await openSidebar(page);
    await expanded(page, "parent", false);
    const parent = threadRow(page, "parent");
    await parent.getByRole("img", { name: "Child sessions need attention", exact: true }).waitFor();
    await parent.getByRole("img", { name: "Child sessions are running", exact: true }).waitFor();
    await noHorizontalOverflow(page);
    await treeShot(page, "thread-tree-390-collapsed-summary");
    // Search stays flat and reopening the selected child reveals its ancestry.
    await page.getByRole("button", { name: "Search sessions", exact: true }).click();
    await page.getByPlaceholder("Search session names").fill("Approval checks");
    const result = page.getByRole("treeitem").filter({ hasText: "Approval checks" });
    await result.getByText(/Delegated implementation/).waitFor();
    await result.click();
    await page.locator("[data-phone][data-sidebar-hidden]").waitFor();
    await openSidebar(page);
    await threadRow(page, "grandchild").waitFor();
    assert.equal(await parent.getAttribute("aria-expanded"), "true");
    // A fresh browser navigation must also reveal a previously folded path.
    await expanded(page, "parent", false);
    const link = new URL(url);
    link.searchParams.set("session", "deepest");
    await page.goto(link.href);
    await page.locator('[data-conversation-session="deepest"] [data-composer-input]').waitFor();
    await openSidebar(page);
    await threadRow(page, "deepest").waitFor();
    for (const id of ["parent", "child", "grandchild", "deep"])
      assert.equal(await threadRow(page, id).getAttribute("aria-expanded"), "true");
  },
);

async function dragInto(page: Page, source: Locator, target: Locator): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getTiming().iterations === Infinity ||
          animation.playState !== "running",
      ),
  );
  const start = await source.boundingBox(),
    end = await target.boundingBox();
  assert.ok(start && end);
  await page.mouse.move(start.x + 100, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 110, start.y + start.height + 5, { steps: 6 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 3, { steps: 12 });
}

it(
  "children cannot reorder or pin but retain native reference dragging into chat",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t, 1280, "destination");
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    await expanded(page, "parent", true);
    const child = threadRow(page, "child");
    await threadMenu(page, "child");
    assert.equal(await page.getByRole("menuitem", { name: /^(Unpin|Pin) session$/ }).count(), 0);
    await page.keyboard.press("Escape");
    const savedOrder = () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}").sessionOrderByAccount,
      );
    const before = await savedOrder();
    const rows = () =>
      page
        .locator('[role="tree"] [data-row-key]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")));
    const order = await rows();
    await child.dragTo(threadRow(page, "destination"));
    assert.deepEqual(await savedOrder(), before);
    assert.deepEqual(await rows(), order);
    assert.equal(host.placements.size, 0);
    const content = page.locator('[data-conversation-session="destination"]');
    const composer = content.locator("[data-composer-input]");
    await dragInto(page, child, content);
    await page.locator("[data-thread-reference-drop]").waitFor();
    await page.mouse.up();
    const chip = composer.locator('[data-composer-chip="codexhost-thread"]');
    await chip.waitFor();
    assert.equal(await chip.innerText(), "Delegated implementation");
    assert.deepEqual(await savedOrder(), before);
    assert.deepEqual(host.pinnedIds, ["child"]);
    assert.equal(
      host.requests.some((request) => request.method === "turn/start"),
      false,
    );
  },
);

it(
  "archiving a parent names running descendants and cascades through the subtree, with restore",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await threadMenu(page, "parent");
    await page.getByRole("menuitem", { name: "Archive session", exact: true }).click();
    const confirm = page.getByRole("dialog", {
      name: "Stop and archive this session?",
      exact: true,
    });
    await confirm.getByText("Running session: Approval checks", { exact: true }).waitFor();
    assert.equal(
      host.archivedIds.has("parent"),
      false,
      "confirmation precedes the irreversible action",
    );
    const archiveResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/archiveSession"),
    );
    await confirm.getByRole("button", { name: "Stop and archive", exact: true }).click();
    assert.equal((await (await archiveResponse).json()).result.ok, true);
    await confirm.waitFor({ state: "hidden" });
    await threadRow(page, "parent").waitFor({ state: "detached" });
    await page.waitForFunction(
      () => document.querySelector('[data-row-key="recent:grandchild"]') === null,
    );
    const archived = ["parent", "child", "grandchild", "deep", "deepest"];
    await page.getByRole("button", { name: "undo", exact: true }).waitFor();
    assert.deepEqual([...host.archivedIds].sort(), ["archived", ...archived].sort());
    assert.equal(host.archivedIds.has("destination"), false);
    const restoreResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/unarchiveSession"),
    );
    await page.getByRole("button", { name: "undo", exact: true }).click();
    assert.equal((await (await restoreResponse).json()).result.ok, true);
    await threadRow(page, "parent").waitFor();
    assert.deepEqual([...host.archivedIds], ["archived"]);
    assert.deepEqual(
      host.requests
        .filter((request) => request.method === "thread/archive")
        .map((request) => request.params.threadId),
      archived,
    );
  },
);

it(
  "a descendant archive failure reports partial failure without rolling back successful Threads",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    host.archiveFailures.add("child");
    await threadMenu(page, "parent");
    await page.getByRole("menuitem", { name: "Archive session", exact: true }).click();
    const confirm = page.getByRole("dialog", {
      name: "Stop and archive this session?",
      exact: true,
    });
    const failed = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/archiveSession"),
    );
    await confirm.getByRole("button", { name: "Stop and archive", exact: true }).click();
    const result = (await (await failed).json()).result;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "session/archive-partial");
    assert.deepEqual(result.error.details, { failedSessionIds: ["child"] });
    const error = confirm.getByRole("alert");
    await error.waitFor();
    assert.match(await error.innerText(), /Some Threads could not be archived or restored/);
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(
      [...host.archivedIds].sort(),
      ["archived", "parent", "grandchild", "deep", "deepest"].sort(),
    );
    assert.equal(host.archivedIds.has("child"), false);
    await threadRow(page, "parent").waitFor({ state: "detached" });
    await threadRow(page, "child").waitFor();
  },
);

for (const width of [1280, 390]) {
  it(
    `placement filters candidates, expands target ancestors and persists an explicit top level at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { page, host } = await threadTreeBrowser(t, width);
      await expanded(page, "parent", true);
      await viewOption(page, "All conversations (show archived)");
      await threadMenu(page, "child");
      await page.getByRole("menuitem", { name: "Move under…", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "Move under…", exact: true });
      const targets = picker.getByRole("group", { name: "Choose a parent session", exact: true });
      await targets.getByRole("button", { name: /^Move target/ }).waitFor();
      for (const name of [
        "Delegated implementation",
        "Approval checks",
        "Deep review",
        "Nested follow-up",
        "Archived work",
        "Native worker",
      ])
        assert.equal(
          await targets.getByRole("button", { name: new RegExp(`^${name}`) }).count(),
          0,
          name,
        );
      await treeShot(page, `thread-tree-${width}-placement-picker`);
      const search = picker.getByRole("searchbox", { name: "Search sessions", exact: true });
      await search.fill("MOVE TARGET");
      assert.equal(await targets.getByRole("button").count(), 1);
      await targets.getByRole("button", { name: /^Move target/ }).click();
      await picker.waitFor({ state: "hidden" });
      await openSidebar(page);
      const child = threadRow(page, "child");
      await child.waitFor();
      assert.equal(host.parents.child, "target");
      assert.equal(await child.getAttribute("data-thread-parent"), "target");
      assert.equal(await threadRow(page, "target-root").getAttribute("aria-expanded"), "true");
      assert.equal(await threadRow(page, "target").getAttribute("aria-expanded"), "true");
      await threadMenu(page, "child");
      await page.getByRole("menuitem", { name: "Move to top level", exact: true }).click();
      await openSidebar(page);
      await page.waitForFunction(() => {
        const row = document.querySelector(
          '[data-row-key="recent:child"], [data-row-key="session:child"]',
        );
        return row?.getAttribute("data-thread-depth") === "0";
      });
      assert.equal(host.placements.get("child"), null);
      assert.equal(host.delegations.child, "parent", "placement never edits delegation");
      await page.reload();
      await page.getByText("Native Model", { exact: true }).waitFor();
      await openSidebar(page);
      await child.waitFor();
      assert.equal(await child.getAttribute("data-thread-depth"), "0");
      assert.equal(await child.getAttribute("data-thread-parent"), null);
      await noHorizontalOverflow(page);
      await threadMenu(page, "child");
      assert.equal(
        await page.getByRole("menuitem", { name: "Move to top level", exact: true }).count(),
        0,
      );
      await page.keyboard.press("Escape");
    },
  );
}

it(
  "a refused placement reports the Host error without moving the subtree",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    await expanded(page, "parent", true);
    host.placeError = "Placement rejected by Host.";
    await threadMenu(page, "child");
    await page.getByRole("menuitem", { name: "Move under…", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Move under…", exact: true });
    await picker.getByRole("button", { name: /^Move target/ }).click();
    await page
      .getByText("Could not move session: Placement rejected by Host.", { exact: true })
      .waitFor();
    assert.equal(host.parents.child, "parent");
    assert.equal(await threadRow(page, "child").getAttribute("data-thread-parent"), "parent");
    assert.equal(await picker.getByRole("searchbox").isEnabled(), true);
  },
);
