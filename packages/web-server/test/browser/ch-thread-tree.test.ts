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

async function foldStyle(page: Page, id: string) {
  return threadRow(page, id)
    .locator("[data-thread-toggle]")
    .evaluate((node) => {
      const content = node.firstElementChild;
      const chevron = node.querySelector("svg");
      if (!content || !chevron) throw new Error("Missing fold content or chevron");
      return {
        background: getComputedStyle(node).backgroundColor,
        contentBackground: getComputedStyle(content).backgroundColor,
        border: getComputedStyle(node).borderWidth,
        color: getComputedStyle(node).color,
        chevron: getComputedStyle(chevron).transform,
      };
    });
}

async function foldLayout(page: Page, id: string): Promise<void> {
  const layout = await threadRow(page, id).evaluate((row) => {
    const toggle = row.querySelector("[data-thread-toggle]");
    const icon = row.querySelector("[data-thread-icon-toggle]");
    const chevron = toggle?.querySelector("svg");
    if (!toggle || !icon || !chevron) throw new Error("Missing fold layout elements");
    const chevronBox = chevron.getBoundingClientRect();
    return {
      chevronBeforeIcon: chevronBox.right <= icon.getBoundingClientRect().left,
      chevronInRow: chevronBox.left >= -1,
      chevronWidth: chevronBox.width,
    };
  });
  assert.equal(layout.chevronBeforeIcon, true, "the chevron sits left of the icon");
  assert.equal(layout.chevronInRow, true);
  assert.equal(layout.chevronWidth, 10);
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
      assert.equal((await rowAlignment(page, "parent")).icon, 8, "no leading toggle slot");
      assert.equal(await parent.locator("[data-thread-toggle] svg").count(), 1);
      const toggleBounds = await parent.locator("[data-thread-toggle]").boundingBox();
      assert.ok(
        toggleBounds && toggleBounds.width < 44 && toggleBounds.height >= (width === 390 ? 32 : 28),
        "a content-sized control keeps transparent padding for its hit target",
      );
      const collapsedStyle = await foldStyle(page, "parent");
      assert.equal(collapsedStyle.background, "rgba(0, 0, 0, 0)");
      assert.equal(collapsedStyle.contentBackground, "rgba(0, 0, 0, 0)");
      assert.equal(collapsedStyle.border, "0px");
      assert.equal(await parent.locator("[data-thread-toggle]").innerText(), "");
      assert.notEqual(collapsedStyle.chevron, "none");
      await foldLayout(page, "parent");
      assert.equal(
        await parent
          .locator("[data-session-title]")
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
        true,
        "a short title does not lose space to a fixed-width badge",
      );
      await treeShot(page, `thread-tree-${width}-collapsed`);
      assert.equal(await threadRow(page, "child").count(), 0);
      assert.equal(await page.locator('[data-row-key="section:pinned"]').count(), 0);
      await parent
        .locator('[data-thread-toggle][aria-description="Child sessions are running"]')
        .waitFor();
      assert.equal(await page.getByText("Native worker", { exact: true }).count(), 0);
      const selectionBefore = await parent.getAttribute("aria-selected");
      await expanded(page, "parent", true);
      assert.equal(
        await parent.getAttribute("aria-selected"),
        selectionBefore,
        "folding does not open the row",
      );
      await expanded(page, "child", true);
      await threadRow(page, "grandchild").waitFor();
      assert.equal(await threadRow(page, "child").getAttribute("data-thread-parent"), "parent");
      assert.equal(await threadRow(page, "grandchild").getAttribute("data-thread-depth"), "2");
      assert.equal(
        await parent.locator("[data-thread-tree-activity]").count(),
        0,
        "expanded rows show their own state only",
      );
      await page.mouse.move(width - 10, 850);
      const expandedStyle = await foldStyle(page, "parent");
      assert.equal(expandedStyle.background, "rgba(0, 0, 0, 0)");
      assert.equal(expandedStyle.contentBackground, "rgba(0, 0, 0, 0)");
      assert.equal(expandedStyle.chevron, "none");
      assert.notEqual(expandedStyle.color, collapsedStyle.color);
      await foldLayout(page, "parent");
      await foldLayout(page, "child");
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
      if (width === 1280) {
        await threadRow(page, "child").locator("[data-thread-toggle]").hover();
        assert.equal((await foldStyle(page, "child")).background, "rgba(0, 0, 0, 0)");
        await foldLayout(page, "child");
        await treeShot(page, "thread-tree-1280-expanded-hover");
        await page.mouse.move(width - 10, 850);
      }
      await parent.focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await parent
          .locator("[data-thread-toggle]")
          .evaluate((node) => node.matches(":focus-visible")),
        true,
      );
      assert.equal((await foldStyle(page, "parent")).background, "rgba(0, 0, 0, 0)");
      await page.keyboard.press("Enter");
      assert.equal(await parent.getAttribute("aria-expanded"), "false");
      await page.keyboard.press("Space");
      assert.equal(await parent.getAttribute("aria-expanded"), "true");
      await parent
        .getByRole("button", { name: "Collapse 4 child sessions", exact: true })
        .waitFor();
      assert.equal(await parent.getAttribute("aria-selected"), selectionBefore);
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
    for (const id of ["parent", "child", "grandchild", "deep"]) await foldLayout(page, id);
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
    await parent
      .locator('[data-thread-toggle][aria-description="Child sessions need attention"]')
      .waitFor();
    assert.equal(await parent.locator("[data-thread-tree-activity]").count(), 1);
    assert.equal(
      await parent
        .locator("[data-thread-toggle] [data-thread-tree-activity]")
        .getAttribute("data-thread-tree-activity"),
      "pending",
    );
    await noHorizontalOverflow(page);
    await treeShot(page, "thread-tree-390-collapsed-summary");
    const pendingColor = await parent
      .locator("[data-thread-tree-activity]")
      .evaluate((node) => getComputedStyle(node).color);
    host.pending = [];
    host.changed("grandchild", "serverRequest/resolved");
    await parent
      .locator('[data-thread-toggle][aria-description="Child sessions are running"]')
      .waitFor();
    const runningColor = await parent
      .locator("[data-thread-tree-activity]")
      .evaluate((node) => getComputedStyle(node).color);
    const running = host.threads.get("grandchild");
    assert.ok(running);
    running.status = { type: "idle" };
    host.changed("grandchild", "turn/completed");
    await parent
      .locator(
        '[data-thread-toggle][aria-description="Child sessions finished and have not been opened"]',
      )
      .waitFor();
    const completedColor = await parent
      .locator("[data-thread-tree-activity]")
      .evaluate((node) => getComputedStyle(node).color);
    assert.equal(
      new Set([pendingColor, runningColor, completedColor]).size,
      3,
      "each aggregate state has its own sidebar color",
    );
    assert.equal(
      await parent.locator("[data-session-status]").count(),
      0,
      "descendant activity does not replace the parent's own idle status",
    );
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

function workspaceRow(page: Page, title: string) {
  return page.locator('[data-row-key^="workspace:"]').filter({ hasText: new RegExp(`^${title}$`) });
}

async function groupFolds(page: Page) {
  return page.evaluate(() => {
    const view = JSON.parse(localStorage.getItem("dsh.workspace.view.v5") ?? "{}");
    return { groups: view.groupExpansion ?? {}, sections: view.sectionExpansion ?? {} };
  });
}

for (const width of [1280, 390]) {
  it(
    `Recents selection preserves default and explicit workspace folds, including the current Thread at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { page } = await threadTreeBrowser(t, width);
      const workspace = workspaceRow(page, "tree");
      await workspace.waitFor();
      assert.equal(await workspace.getAttribute("aria-expanded"), "false");
      const selectRecent = async (id: string) => {
        await page.locator(`[data-row-key="recent:${id}"] [data-session-title]`).click();
        await page.locator(`[data-conversation-session="${id}"] [data-composer-input]`).waitFor();
        await openSidebar(page);
        if (await workspace.count())
          assert.equal(await workspace.getAttribute("aria-expanded"), "false");
      };
      const defaults = await groupFolds(page);
      await selectRecent("workspace-root");
      assert.deepEqual(await groupFolds(page), defaults, "default folds are untouched");
      await selectRecent("workspace-root");
      assert.deepEqual(await groupFolds(page), defaults, "reselecting the current Thread is inert");
      await workspace.click();
      await page.locator('[data-row-key="session:workspace-root"]').waitFor();
      await workspace.click();
      const explicit = await groupFolds(page);
      await selectRecent("destination");
      await selectRecent("workspace-root");
      await selectRecent("workspace-root");
      assert.deepEqual(await groupFolds(page), explicit, "explicit folds are untouched");
      await expanded(page, "workspace-root", true);
      await expanded(page, "workspace-child", true);
      await selectRecent("workspace-grandchild");
      assert.deepEqual(
        await groupFolds(page),
        explicit,
        "child selection only reveals Thread ancestors",
      );
      await selectRecent("workspace-root");
      await treeShot(page, `thread-tree-${width}-recent-workspace-folded`);
      await page.locator('[data-row-key="section:workspaces"]').click();
      const sectionFolded = await groupFolds(page);
      await selectRecent("workspace-root");
      assert.deepEqual(
        await groupFolds(page),
        sectionFolded,
        "the workspace section stays folded too",
      );
      await noHorizontalOverflow(page);
    },
  );
}

it(
  "deep links, search and notification navigation reveal workspace path and Thread ancestors",
  { timeout: 60_000 },
  async (t) => {
    const { page, url } = await threadTreeBrowser(t, 390);
    await viewOption(page, "Workspace Tree");
    const ancestor = workspaceRow(page, "projects");
    const workspace = workspaceRow(page, "tree");
    const section = page.locator('[data-row-key="section:workspaces"]');
    const foldPath = async () => {
      if ((await ancestor.getAttribute("aria-expanded")) !== "true") await ancestor.click();
      if ((await workspace.getAttribute("aria-expanded")) === "true") await workspace.click();
      await ancestor.click();
      if ((await section.getAttribute("aria-expanded")) === "true") await section.click();
      await expanded(page, "workspace-root", false);
    };
    const assertRevealed = async () => {
      await page
        .locator('[data-conversation-session="workspace-grandchild"] [data-composer-input]')
        .waitFor();
      await openSidebar(page);
      for (const row of [
        section,
        ancestor,
        workspace,
        threadRow(page, "workspace-root"),
        threadRow(page, "workspace-child"),
      ])
        assert.equal(await row.getAttribute("aria-expanded"), "true");
      await page.locator('[data-row-key="session:workspace-grandchild"]').waitFor();
    };
    await foldPath();
    const link = new URL(url);
    link.searchParams.set("session", "workspace-grandchild");
    await page.goto(link.href);
    await assertRevealed();
    await page.locator('[data-row-key="recent:destination"]').click();
    await page.locator('[data-conversation-session="destination"] [data-composer-input]').waitFor();
    await openSidebar(page);
    await foldPath();
    // Exercise the production service-worker message listener, without real push delivery.
    await page.evaluate(() =>
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "codexhost/open-session", sessionId: "workspace-grandchild" },
        }),
      ),
    );
    await assertRevealed();
    await page.locator('[data-row-key="recent:destination"]').click();
    await page.locator('[data-conversation-session="destination"] [data-composer-input]').waitFor();
    await openSidebar(page);
    await foldPath();
    await page.getByRole("button", { name: "Search sessions", exact: true }).click();
    await page.getByPlaceholder("Search session names").fill("Workspace review");
    await page.getByRole("treeitem").filter({ hasText: "Workspace review" }).click();
    await assertRevealed();
    await noHorizontalOverflow(page);
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
  "children hide pin actions and retain native reference dragging into chat",
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
    const content = page.locator('[data-conversation-session="destination"]');
    const composer = content.locator("[data-composer-input]");
    await dragInto(page, child, content);
    await page.locator("[data-thread-reference-drop]").waitFor();
    await page.mouse.up();
    const chip = composer.locator('[data-composer-chip="codexhost-thread"]');
    await chip.waitFor();
    assert.equal(await chip.innerText(), "Delegated implementation");
    assert.deepEqual(await savedOrder(), before);
    assert.equal(host.placements.size, 0);
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

for (const width of [390]) {
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
    const { page, host } = await threadTreeBrowser(t, 390);
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

it(
  "clicking the icon of a parent folds it without opening the session",
  { timeout: 60_000 },
  async (t) => {
    const { page } = await threadTreeBrowser(t, 1280);
    const parent = threadRow(page, "parent");
    await parent.waitFor();
    const selectionBefore = await parent.getAttribute("aria-selected");
    await parent.locator("[data-thread-icon-toggle]").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-row-key$=":parent"]')?.getAttribute("aria-expanded") ===
        "true",
    );
    assert.equal(await parent.getAttribute("aria-selected"), selectionBefore);
    await parent.locator("[data-thread-icon-toggle]").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-row-key$=":parent"]')?.getAttribute("aria-expanded") ===
        "false",
    );
    assert.equal(await page.locator('[data-conversation-session="parent"]').count(), 0);
  },
);
