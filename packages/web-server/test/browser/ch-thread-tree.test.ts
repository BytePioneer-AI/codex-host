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
    await row.locator(value ? "[data-thread-summary]" : "[data-thread-icon-toggle]").click();
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
    .locator("[data-thread-icon-toggle]")
    .evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
    }));
}

async function tokenColor(page: Page, id: string, token: string): Promise<string> {
  return threadRow(page, id).evaluate((row, token) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    row.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function foldLayout(page: Page, id: string, row = threadRow(page, id)): Promise<void> {
  const layout = await row.evaluate((row) => {
    const icon = row.querySelector("[data-thread-icon-toggle]");
    const title = row.querySelector("[data-session-title]");
    const summary = row.querySelector("[data-thread-summary]");
    if (!icon || !title) throw new Error("Missing fold layout elements");
    const group = document.getElementById(icon.getAttribute("aria-controls") ?? "");
    return {
      oldToggle: row.querySelector("[data-thread-toggle]") !== null,
      group: group?.getAttribute("role"),
      summaryGroup: summary?.getAttribute("aria-controls"),
      iconGroup: icon.getAttribute("aria-controls"),
      summaryTop: summary?.getBoundingClientRect().top,
      titleBottom: title.getBoundingClientRect().bottom,
      summaryHeight: summary?.getBoundingClientRect().height,
      rowBottom: row.getBoundingClientRect().bottom,
      summaryBottom: summary?.getBoundingClientRect().bottom,
      font: summary && getComputedStyle(summary).fontSize,
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  });
  assert.equal(layout.oldToggle, false);
  assert.equal(layout.group, "group");
  if (layout.summaryTop !== undefined) {
    assert.equal(layout.summaryGroup, layout.iconGroup);
    assert.ok(layout.summaryTop >= layout.titleBottom);
    assert.equal(layout.font, "11px");
    assert.ok((layout.summaryBottom ?? 0) <= layout.rowBottom);
    if (layout.coarse) assert.ok((layout.summaryHeight ?? 0) >= 28);
  }
}

async function guides(
  page: Page,
  id: string,
  count: number,
  row = threadRow(page, id),
): Promise<void> {
  // Guide geometry is measured without the transient onboarding between parent and children.
  const later = page
    .locator("[data-thread-style-prompt]")
    .getByRole("button", { name: "Later", exact: true });
  if (await later.count()) {
    const focused = await page.evaluateHandle(() => document.activeElement);
    await later.click();
    await focused.evaluate((element) => {
      if (element instanceof HTMLElement && element.isConnected)
        element.focus({ preventScroll: true });
    });
    await focused.dispose();
  }
  const geometry = await row.evaluate((row) => {
    const group = row
      .closest("[data-thread-branch]")
      ?.querySelector(":scope > [data-thread-guide]");
    if (!group) return null;
    const icon = row.querySelector("[data-harness-id]")?.getBoundingClientRect();
    if (!icon) throw new Error("Missing parent icon");
    const bridge = getComputedStyle(group, "::before");
    const branches = [...group.children];
    return {
      axis: group.getBoundingClientRect().left + parseFloat(bridge.left) + 0.5,
      iconCenter: icon.x + icon.width / 2,
      top: group.getBoundingClientRect().top + parseFloat(bridge.top),
      iconBottom: icon.bottom,
      parentGap: row.getAttribute("data-thread-depth") === "0" ? 12 : 10,
      width: bridge.width,
      pointerEvents: bridge.pointerEvents,
      color: bridge.backgroundColor,
      elbows: branches.map((branch, index) => {
        const stem = getComputedStyle(branch, "::before");
        const elbowTop = parseFloat(stem.maskPosition.split(",")[1]?.trim().split(" ")[1] ?? "");
        const elbowHeight = stem.maskSize.split(",")[1]?.trim().split(" ")[1] ?? "";
        const rect = branch.getBoundingClientRect();
        const childIcon = branch.querySelector("[data-harness-id]")?.getBoundingClientRect();
        return {
          top: rect.top + elbowTop,
          bottom: rect.top + elbowTop + parseFloat(elbowHeight),
          center: childIcon && childIcon.top + childIcon.height / 2,
          iconGap:
            childIcon &&
            childIcon.left - rect.left - parseFloat(stem.left) - parseFloat(stem.width),
          mask: stem.maskImage,
          height: elbowHeight,
          color: stem.backgroundColor,
          separateElbow: getComputedStyle(branch, "::after").content,
          stemBottom:
            rect.top +
            parseFloat(stem.top) +
            parseFloat(stem.height) -
            parseFloat(stem.getPropertyValue("--dsh-thread-guide-stem-end")),
          nextTop: branches[index + 1]?.getBoundingClientRect().top,
          overlay: stem.zIndex,
        };
      }),
    };
  });
  assert.equal(geometry === null ? 0 : 1, count);
  if (geometry) {
    assert.equal(geometry.axis, geometry.iconCenter + 1, "stem sits just right of the parent axis");
    assert.equal(
      geometry.top,
      geometry.iconBottom + geometry.parentGap,
      "stem leaves breathing room below its own parent icon",
    );
    assert.equal(geometry.width, "1px");
    assert.equal(geometry.pointerEvents, "none");
    assert.equal(geometry.color, await tokenColor(page, id, "--dsw-alias-border-l2"));
    for (const arc of geometry.elbows) {
      assert.equal(arc.bottom, arc.center, "each elbow points at its direct child's icon");
      assert.match(arc.mask, /^linear-gradient.*data:image\/svg\+xml/);
      assert.equal(
        arc.separateElbow,
        "none",
        "stem and elbow share a single translucent paint layer",
      );
      assert.equal(arc.height, "8px");
      assert.equal(arc.color, geometry.color);
      assert.equal(arc.iconGap, 6);
      assert.equal(arc.stemBottom, arc.nextTop ?? arc.top, "only non-last stems continue downward");
      assert.equal(arc.overlay, "1", "guides stay above selected and hovered row backgrounds");
    }
  }
}

async function themedShots(page: Page, name: string): Promise<void> {
  await treeShot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("body[data-ds-dark-theme]").waitFor();
  await treeShot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator("body[data-ds-dark-theme]").waitFor({ state: "detached" });
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
      await page.emulateMedia({ colorScheme: "light" });
      const parent = threadRow(page, "parent");
      await parent.waitFor();
      assert.equal(await parent.getAttribute("aria-expanded"), "false");
      await parent
        .getByRole("button", {
          name: "Release plan, 4 child sessions · 1 running, expand",
          exact: true,
        })
        .waitFor();
      assert.deepEqual(
        await rowAlignment(page, "parent"),
        await rowAlignment(page, "destination"),
        "root icons and titles align with or without a fold control",
      );
      assert.equal((await rowAlignment(page, "parent")).icon, 8, "no leading toggle slot");
      assert.equal(await parent.locator("[data-thread-toggle]").count(), 0);
      assert.equal(
        await parent.locator("[data-thread-summary]").innerText(),
        "4 child sessions · 1 running",
      );
      assert.equal((await parent.boundingBox())?.height, width === 390 ? 78 : 56);
      const collapsedStyle = await foldStyle(page, "parent");
      assert.equal(collapsedStyle.background, "rgba(0, 0, 0, 0)");
      await foldLayout(page, "parent");
      assert.equal(
        await parent
          .locator("[data-session-title]")
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
        true,
        "a short title does not lose space to a fixed-width badge",
      );
      assert.equal(await page.locator("[data-thread-guide]").count(), 0);
      await themedShots(page, `thread-tree-${width}-collapsed`);
      assert.equal(await threadRow(page, "child").count(), 0);
      assert.equal(await page.locator('[data-row-key="section:pinned"]').count(), 0);
      await parent.locator('[data-thread-summary] [data-thread-tree-activity="running"]').waitFor();
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
      assert.equal(await parent.locator("[data-thread-summary]").count(), 0);
      assert.equal(expandedStyle.color, collapsedStyle.color);
      await foldLayout(page, "parent");
      await foldLayout(page, "child");
      const rootPosition = await rowAlignment(page, "parent");
      const childPosition = await rowAlignment(page, "child");
      const grandchildPosition = await rowAlignment(page, "grandchild");
      assert.equal(childPosition.icon - rootPosition.icon, 24);
      assert.equal(grandchildPosition.title - childPosition.title, 24);
      await page.mouse.move(width - 10, 850);
      if (width === 390)
        assert.equal(
          await threadRow(page, "child")
            .locator("[data-thread-icon-toggle]")
            .evaluate((node) => getComputedStyle(node).backgroundColor),
          "rgba(0, 0, 0, 0)",
          "touch focus does not leave a filled toggle",
        );
      await guides(page, "parent", 1);
      await guides(page, "child", 1);
      await guides(page, "grandchild", 0);
      await guides(page, "destination", 0);
      await themedShots(page, `thread-tree-${width}-expanded`);
      if (width === 1280) {
        await threadRow(page, "child").locator("[data-thread-icon-toggle]").hover();
        assert.equal((await foldStyle(page, "child")).background, "rgba(0, 0, 0, 0)");
        await foldLayout(page, "child");
        await guides(page, "child", 1);
        await parent.locator("[data-thread-icon-toggle]").hover();
        for (const name of ["Session actions for Release plan", "Archive session", "Pin session"])
          await parent.getByRole("button", { name, exact: true }).waitFor();
        await themedShots(page, "thread-tree-1280-expanded-hover");
        await page.mouse.move(width - 10, 850);
      }
      await parent.focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await parent
          .locator("[data-thread-icon-toggle]")
          .evaluate((node) => node.matches(":focus-visible")),
        true,
      );
      assert.equal((await foldStyle(page, "parent")).background, "rgba(0, 0, 0, 0)");
      await page.keyboard.press("Enter");
      assert.equal(await parent.getAttribute("aria-expanded"), "false");
      assert.equal(
        await page.locator("[data-thread-guide]").count(),
        0,
        "folded subtrees leave no guides",
      );
      await parent.locator("[data-thread-summary]").focus();
      await page.keyboard.press("Space");
      assert.equal(await parent.getAttribute("aria-expanded"), "true");
      assert.equal(
        await parent
          .locator("[data-thread-icon-toggle]")
          .evaluate((node) => node === document.activeElement),
        true,
      );
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
      await guides(page, "parent", 1);
      await page.keyboard.press("ArrowLeft");
      assert.equal(await parent.evaluate((node) => node === document.activeElement), true);
      await expanded(page, "child", true);
      await expanded(page, "grandchild", true);
      await expanded(page, "deep", true);
      await threadRow(page, "deepest").waitFor();
      await guides(page, "deep", 0);
      await guides(page, "deepest", 0);
      assert.equal(await page.locator("[data-thread-guide]").count(), 3);
      for (const id of ["parent", "child", "grandchild"]) await guides(page, id, 1);
      assert.equal(await threadRow(page, "deepest").getAttribute("aria-level"), "5");
      const indent = async (id: string) =>
        threadRow(page, id).evaluate((node) => getComputedStyle(node).paddingInlineStart);
      assert.equal(await indent("deepest"), await indent("deep"));
      assert.notEqual(await indent("grandchild"), await indent("deep"));
      await noHorizontalOverflow(page);
      assert.deepEqual(host.pinnedIds, [], "folding never changes shared pins");
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
    await guides(page, "parent", 1);
    await guides(page, "child", 1);
    await guides(page, "grandchild", 0);
    await treeShot(page, "thread-tree-390-selected-guides");
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
    await parent.locator('[data-thread-summary] [data-thread-tree-activity="pending"]').waitFor();
    assert.equal(
      await parent.locator("[data-thread-summary]").innerText(),
      "4 child sessions · 1 running · 1 needs approval",
    );
    assert.match(
      (await parent.locator("[data-thread-summary]").getAttribute("aria-label")) ?? "",
      /Release plan.*1 needs approval.*expand/,
    );
    await noHorizontalOverflow(page);
    await treeShot(page, "thread-tree-390-collapsed-pending");
    const pendingColor = await parent
      .locator('[data-thread-tree-activity="pending"]')
      .evaluate((node) => getComputedStyle(node).color);
    assert.equal(pendingColor, await tokenColor(page, "parent", "--dsw-alias-state-warn-primary"));
    await noHorizontalOverflow(page);
    host.pending = [];
    host.changed("grandchild", "serverRequest/resolved");
    await parent.locator('[data-thread-tree-activity="pending"]').waitFor({ state: "detached" });
    await parent.locator('[data-thread-tree-activity="running"]').waitFor();
    const runningColor = await parent
      .locator("[data-thread-tree-activity]")
      .evaluate((node) => getComputedStyle(node).color);
    assert.notEqual(runningColor, pendingColor);
    // An unread completion on one descendant cannot hide another descendant's running state.
    await expanded(page, "parent", true);
    const child = host.threads.get("child");
    assert.ok(child);
    child.status = { type: "active" };
    host.changed("child", "turn/started");
    await threadRow(page, "child").locator('[data-session-status="ongoing"]').waitFor();
    child.status = { type: "idle" };
    host.changed("child", "turn/completed");
    await threadRow(page, "child").locator('[data-session-status="done"]').waitFor();
    await expanded(page, "parent", false);
    await parent.locator('[data-thread-tree-activity="running"]').waitFor();
    await noHorizontalOverflow(page);
    await treeShot(page, "thread-tree-390-collapsed-running");
    const running = host.threads.get("grandchild");
    assert.ok(running);
    running.status = { type: "idle" };
    host.changed("grandchild", "turn/completed");
    await parent.locator('[data-thread-tree-activity="running"]').waitFor({ state: "detached" });
    await parent.locator('[data-thread-tree-activity="completed"]').waitFor();
    assert.equal(
      await parent.locator("[data-thread-summary]").innerText(),
      "4 child sessions · 2 unread",
    );
    const completedColor = await parent
      .locator("[data-thread-tree-activity]")
      .evaluate((node) => getComputedStyle(node).color);
    assert.equal(
      completedColor,
      await tokenColor(page, "parent", "--dsw-alias-state-business-primary"),
    );
    await noHorizontalOverflow(page);
    await treeShot(page, "thread-tree-390-collapsed-completed");
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
    // Opening the other completed descendant acknowledges its unread state too.
    await threadRow(page, "child").locator("[data-session-title]").click();
    await page.locator('[data-conversation-session="child"] [data-composer-input]').waitFor();
    await openSidebar(page);
    // A fresh browser navigation must also reveal a previously folded path.
    await expanded(page, "parent", false);
    await parent.locator("[data-thread-tree-activity]").waitFor({ state: "detached" });
    assert.equal(await parent.locator("[data-thread-summary]").innerText(), "4 child sessions");
    const idleColor = await parent
      .locator("[data-thread-summary]")
      .evaluate((node) => getComputedStyle(node).color);
    assert.equal(idleColor, await tokenColor(page, "parent", "--dsw-alias-label-tertiary"));
    await expanded(page, "parent", true);
    await expanded(page, "parent", false);
    assert.equal(new Set([pendingColor, runningColor, completedColor, idleColor]).size, 4);
    await noHorizontalOverflow(page);
    await treeShot(page, "thread-tree-390-collapsed-idle");
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

for (const width of [1280, 390]) {
  it(
    `bent guides and summary rows align in Recents, workspaces and pins at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { page } = await threadTreeBrowser(t, width);
      await page.emulateMedia({ colorScheme: "light" });
      for (const id of ["parent", "child", "grandchild"]) await expanded(page, id, true);
      for (const id of ["parent", "child", "grandchild"]) {
        await guides(page, id, 1);
        await foldLayout(page, id);
      }
      await themedShots(page, `thread-tree-${width}-three-levels`);

      await workspaceRow(page, "tree").click();
      for (const id of ["workspace-root", "workspace-child"]) await expanded(page, id, true);
      const groupedRoot = page.locator('[data-row-key="session:workspace-root"]');
      const groupedChild = page.locator('[data-row-key="session:workspace-child"]');
      await groupedRoot.scrollIntoViewIfNeeded();
      assert.ok(
        await groupedRoot.evaluate(
          (row) => parseFloat(getComputedStyle(row).getPropertyValue("--dsh-workspace-indent")) > 0,
        ),
      );
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForFunction(
          (dark) => document.body.hasAttribute("data-ds-dark-theme") === dark,
          scheme === "dark",
        );
        await guides(page, "workspace-root", 1, groupedRoot);
        await guides(page, "workspace-child", 1, groupedChild);
        await foldLayout(page, "workspace-root", groupedRoot);
        await page.mouse.move(width - 10, 850);
        const openStyle = await foldStyle(page, "workspace-root");
        await expanded(page, "workspace-root", false);
        await page.mouse.move(width - 10, 850);
        const closedStyle = await foldStyle(page, "workspace-root");
        assert.equal(openStyle.color, closedStyle.color, "idle folding changes direction only");
        assert.equal(
          await groupedRoot.locator("[data-thread-summary]").innerText(),
          "2 child sessions",
        );
        await foldLayout(page, "workspace-root", groupedRoot);
        await expanded(page, "workspace-root", true);
        await treeShot(page, `thread-tree-${width}-workspace-${scheme}`);
      }

      await threadMenu(page, "parent");
      await page.getByRole("menuitem", { name: "Pin session", exact: true }).click();
      await openSidebar(page);
      const pinnedRoot = page.locator('[data-sidebar-pinned] [data-row-key="session:parent"]');
      await pinnedRoot.waitFor();
      await pinnedRoot.scrollIntoViewIfNeeded();
      await guides(page, "parent", 1, pinnedRoot);
      await foldLayout(page, "parent", pinnedRoot);
      await page.emulateMedia({ colorScheme: "light" });
      await themedShots(page, `thread-tree-${width}-pinned`);
      await noHorizontalOverflow(page);
    },
  );
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
  "deep links, search and notification navigation open the Thread without opening its workspace folders",
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
      assert.equal(
        await section.getAttribute("aria-expanded"),
        "false",
        "navigation does not open the workspaces section or its folders",
      );
      assert.equal(await workspace.count(), 0);
      assert.equal(await page.locator('[data-row-key="session:workspace-root"]').count(), 0);
      // The Thread ancestors are remembered, so the subtree is open once the user opens the folders.
      await section.click();
      if ((await ancestor.getAttribute("aria-expanded")) !== "true") await ancestor.click();
      if ((await workspace.getAttribute("aria-expanded")) !== "true") await workspace.click();
      for (const row of [threadRow(page, "workspace-root"), threadRow(page, "workspace-child")])
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
  "children can be pinned as independent roots and retain native reference dragging into chat",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t, 1280, "destination");
    await viewOption(page, "In one list");
    await viewOption(page, "Manual");
    await expanded(page, "parent", true);
    const child = threadRow(page, "child");
    await threadMenu(page, "child");
    await page.getByRole("menuitem", { name: "Pin session", exact: true }).click();
    const pinned = page.locator('[data-sidebar-pinned] [data-row-key="session:child"]');
    await pinned.waitFor();
    assert.equal(await pinned.getAttribute("data-thread-parent"), null);
    assert.equal(await pinned.getAttribute("data-thread-depth"), "0");
    assert.equal(await pinned.getAttribute("data-thread-pinned"), "true");
    await expanded(page, "child", true);
    await threadRow(page, "grandchild").waitFor();
    assert.equal(await threadRow(page, "grandchild").getAttribute("data-thread-parent"), "child");
    assert.equal(await threadRow(page, "grandchild").getAttribute("data-thread-depth"), "1");
    assert.equal(await threadRow(page, "parent").getAttribute("aria-expanded"), null);
    assert.deepEqual(host.pinnedIds, ["child"]);
    await threadMenu(page, "child");
    await page.getByRole("menuitem", { name: "Unpin session", exact: true }).click();
    await pinned.waitFor({ state: "detached" });
    await child.waitFor();
    assert.equal(await child.getAttribute("data-thread-parent"), "parent");
    assert.equal(await child.getAttribute("data-thread-pinned"), "false");
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
    assert.deepEqual(host.pinnedIds, []);
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
