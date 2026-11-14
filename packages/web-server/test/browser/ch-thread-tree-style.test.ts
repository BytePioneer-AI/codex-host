/** Browser-local collapse styles and transient onboarding; no real Harness calls. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { expect } from "@playwright/test";
import type { Page } from "playwright";
import {
  openSidebar,
  threadRow,
  threadTreeBrowser,
  treeShot,
} from "../support/thread-tree-browser.ts";

const KEY = "codexhost.web.preferences.v1:ui-workspace";
async function themedShots(page: Page, name: string) {
  await page.mouse.move(800, 30);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    if (colorScheme === "dark") await page.locator("body[data-ds-dark-theme]").waitFor();
    else await page.locator("body[data-ds-dark-theme]").waitFor({ state: "detached" });
    await treeShot(page, `${name}-${colorScheme}`);
  }
}
async function fits(page: Page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(
    await page
      .locator('[role="tree"], [data-thread-style-prompt]')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.outerHTML.slice(0, 100)),
      ),
    [],
  );
}
async function chooseInMenu(page: Page, name: string) {
  await page.getByRole("button", { name: "View options", exact: true }).click();
  const menu = page.getByRole("menu");
  const choice = menu.getByRole("menuitem", { name, exact: true });
  await expect(menu.getByText("Session count display", { exact: true })).toBeVisible();
  await expect(menu.getByRole("radiogroup")).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Compact", exact: true }).locator("svg"),
  ).toHaveCount(1);
  await expect(choice.locator("svg")).toHaveCount(0);
  await treeShot(page, `style-${page.viewportSize()?.width}-view-options`);
  await page.evaluate(`(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.endsWith(":ui-workspace")) throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    };
    window.restoreMenuStorage = () => { Storage.prototype.setItem = original; };
  })()`);
  await choice.click();
  await expect(menu.getByRole("alert")).toHaveText(
    "Could not save the style. Previous setting kept; please retry.",
  );
  await expect(
    menu.getByRole("menuitem", { name: "Compact", exact: true }).locator("svg"),
  ).toHaveCount(1);
  assert.equal(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "{}").user.threadTreeCollapseStyle,
      KEY,
    ),
    "ring",
  );
  await page.evaluate(() =>
    (window as unknown as { restoreMenuStorage: () => void }).restoreMenuStorage(),
  );
  await choice.focus();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "View options", exact: true }).click();
  await expect(choice.locator("svg")).toHaveCount(1);
  await expect(
    menu.getByRole("menuitem", { name: "Compact", exact: true }).locator("svg"),
  ).toHaveCount(0);
  await expect(menu.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
}

for (const width of [1280, 390]) {
  it(
    `tree style prompt, persistence and ring priorities at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { page, host } = await threadTreeBrowser(t, width);
      const parent = threadRow(page, "parent");
      const prompt = page.locator("[data-thread-style-prompt]");
      assert.equal(await prompt.count(), 0, "initial load does not prompt");
      await themedShots(page, `style-${width}-summary`);
      await parent.locator("[data-thread-summary]").click();
      await prompt.waitFor();
      assert.equal(await prompt.count(), 1);
      await expect(prompt).toHaveAccessibleName("Choose how to display session counts");
      await expect(prompt.getByText("Count and status", { exact: true })).toBeVisible();
      await expect(prompt.getByText("Icon status ring", { exact: true })).toBeVisible();
      const choices = prompt.getByRole("radiogroup");
      const detailed = choices.getByRole("radio", { name: "Detailed", exact: true });
      const compact = choices.getByRole("radio", { name: "Compact", exact: true });
      await expect(detailed).toBeChecked();
      await expect(compact).not.toBeChecked();
      const sampleTitles = [
        "Child awaiting approval",
        "Child running",
        "Child finished, unread",
        "All read",
      ];
      for (const choice of [detailed, compact]) {
        assert.deepEqual(
          await choice.locator("[data-session-title]").allTextContents(),
          sampleTitles,
        );
      }
      assert.deepEqual(
        await compact
          .locator("[data-thread-ring]")
          .evaluateAll((rings) => rings.map((ring) => ring.getAttribute("data-thread-ring"))),
        ["pending", "running", "completed", "idle"],
      );
      const left = await detailed.boundingBox();
      const right = await compact.boundingBox();
      assert.ok(left && right && left.x + left.width <= right.x + 1 && left.y === right.y);
      assert.equal(
        await prompt.locator("button").count(),
        3,
        "samples have no interactive controls",
      );
      await prompt.scrollIntoViewIfNeeded();
      await fits(page);
      await themedShots(page, `style-${width}-choice-bar`);
      await prompt.getByRole("button", { name: "Later", exact: true }).click();
      await expect(prompt).toHaveCount(0);
      assert.equal(
        await page.evaluate(
          (key) =>
            Object.hasOwn(
              JSON.parse(localStorage.getItem(key) ?? "{}").user,
              "threadTreeCollapseStyle",
            ),
          KEY,
        ),
        false,
      );
      await parent.locator("[data-thread-icon-toggle]").click();
      await parent.locator("[data-thread-icon-toggle]").focus();
      await page.keyboard.press("Enter");
      await prompt.waitFor();
      // Browser quota refusal must not mark the default as an explicit choice.
      await page.evaluate(`(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.endsWith(":ui-workspace")) throw new DOMException("full", "QuotaExceededError");
        return original.call(this, key, value);
      };
      window.restoreTreeStorage = () => { Storage.prototype.setItem = original; };
    })()`);
      await detailed.focus();
      await page.keyboard.press("ArrowRight");
      await expect(compact).toBeFocused();
      await expect(detailed).toBeChecked();
      await page.keyboard.press("ArrowLeft");
      await expect(detailed).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");
      await prompt.getByRole("alert").waitFor();
      await treeShot(page, `style-${width}-save-error`);
      await page.evaluate(() =>
        (window as unknown as { restoreTreeStorage: () => void }).restoreTreeStorage(),
      );
      await compact.press("Enter");
      await expect(prompt).toHaveCount(0);
      await expect(parent.locator("[data-thread-icon-toggle]")).toBeFocused();
      await parent.locator("[data-thread-icon-toggle]").click();
      await expect(parent.locator("[data-thread-summary]")).toHaveCount(0);
      const ring = parent.locator("[data-thread-ring]");
      await expect(ring).toHaveAttribute("data-thread-ring", "running");
      const geometry = await parent.evaluate((row) => {
        const iconNode = row.querySelector("[data-harness-id]");
        const ringNode = row.querySelector("[data-thread-ring]");
        if (!iconNode || !ringNode) throw new Error("Missing Harness glyph or descendant ring");
        const icon = iconNode.getBoundingClientRect();
        const ring = ringNode.getBoundingClientRect();
        return {
          glyph: icon.width,
          diameter: ring.width,
          x: ring.x + ring.width / 2 - icon.x - icon.width / 2,
          y: ring.y + ring.height / 2 - icon.y - icon.height / 2,
          height: row.getBoundingClientRect().height,
        };
      });
      assert.deepEqual(geometry, {
        glyph: 14,
        diameter: 22,
        x: 0,
        y: 0,
        height: width === 390 ? 44 : 32,
      });
      await themedShots(page, `style-${width}-ring-running`);
      host.pending = [
        {
          requestId: -91,
          threadId: "grandchild",
          kind: "approval",
          interaction: {
            type: "approval",
            title: "Review checks",
            description: "Run checks?",
            actions: [{ id: "once", label: "Allow once", effect: "allowOnce" }],
          },
          request: {
            method: "mcpServer/elicitation/request",
            params: { requestedSchema: { type: "object", properties: {} } },
          },
        },
      ];
      host.changed("grandchild", "mcpServer/elicitation/request");
      await expect(ring).toHaveAttribute("data-thread-ring", "pending");
      await expect(parent.locator("[data-thread-icon-toggle]")).toHaveAccessibleName(
        /4 child sessions.*1 running.*1 needs approval.*expand/,
      );
      await themedShots(page, `style-${width}-ring-pending`);
      host.pending = [];
      host.changed("grandchild", "serverRequest/resolved");
      await expect(ring).toHaveAttribute("data-thread-ring", "running");
      const grandchild = host.threads.get("grandchild");
      assert.ok(grandchild);
      grandchild.status = { type: "idle" };
      host.changed("grandchild", "turn/completed");
      await expect(ring).toHaveAttribute("data-thread-ring", "completed");
      await themedShots(page, `style-${width}-ring-unread`);
      await parent.locator("[data-thread-icon-toggle]").click();
      await threadRow(page, "child").locator("[data-thread-icon-toggle]").click();
      await threadRow(page, "grandchild").locator("[data-session-title]").click();
      await page
        .locator('[data-conversation-session="grandchild"] [data-composer-input]')
        .waitFor();
      await openSidebar(page);
      await parent.locator("[data-thread-icon-toggle]").click();
      await expect(ring).toHaveAttribute("data-thread-ring", "idle");
      await themedShots(page, `style-${width}-ring-idle`);
      await fits(page);
      await chooseInMenu(page, "Detailed");
      await parent.locator("[data-thread-summary]").waitFor();
      await parent.locator("[data-thread-icon-toggle]").click();
      await expect(prompt).toHaveCount(0);
      await page.reload();
      await openSidebar(page);
      await expect(prompt).toHaveCount(0);
      assert.equal(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").user.threadTreeCollapseStyle,
          KEY,
        ),
        "summary",
      );
      if (width === 390) {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: "General", exact: true }).click();
        const styles = page.getByRole("radiogroup", {
          name: "Session count display",
          exact: true,
        });
        await styles.scrollIntoViewIfNeeded();
        await expect(styles.getByRole("radio", { name: "Detailed", exact: true })).toBeChecked();
        await fits(page);
        assert.equal(
          await styles.evaluate((node) => {
            const row = node.parentElement?.getBoundingClientRect();
            if (!row) return false;
            const control = node.getBoundingClientRect();
            return control.left >= row.left && control.right <= row.right + 1;
          }),
          true,
        );
        await themedShots(page, "style-390-settings");
      }
    },
  );
}

it(
  "a short sidebar reveals choices for a recent parent with 23 additional children",
  { timeout: 40_000 },
  async (t) => {
    const { page, host } = await threadTreeBrowser(t);
    for (let index = 0; index < 23; index++) {
      const id = `delegated-${index}`;
      const child = host.add(id, "/computer/thread-tree", `Delegated task ${index + 1}`, false);
      child.updatedAt = Math.floor(Date.now() / 1000) - index;
      host.delegations[id] = "parent";
    }
    // Keep a Workspace projection as well as the independently rendered Recents row.
    host.projectSnapshot.assignments.parent = "project-workspace-root";
    host.projectSnapshot.projectless = host.projectSnapshot.projectless.filter(
      (id) => id !== "parent",
    );
    await page.evaluate((key) => {
      const record = JSON.parse(localStorage.getItem(key) ?? "{}");
      record.user.showRecentVisits = false;
      record.revision++;
      localStorage.setItem(key, JSON.stringify(record));
    }, KEY);
    // Leave room for all four comparison samples, but not the expanded child list.
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();
    const parent = page.locator('[data-row-key="recent:parent"]');
    const icon = parent.locator("[data-thread-icon-toggle]");
    const prompt = page.locator("[data-thread-style-prompt]");
    const assertChoicesVisible = async () => {
      await expect(prompt).toHaveCount(1);
      for (const style of ["summary", "ring"])
        await expect(prompt.locator(`[data-thread-style-choice="${style}"]`)).toBeInViewport({
          ratio: 1,
        });
      await expect(prompt.getByRole("button", { name: "Later", exact: true })).toBeInViewport({
        ratio: 1,
      });
      assert.equal(
        await parent.evaluate((row) =>
          row
            .closest("[data-thread-branch]")
            ?.firstElementChild?.nextElementSibling?.hasAttribute("data-thread-style-prompt"),
        ),
        true,
      );
    };
    const assertUnchosen = async () => {
      assert.equal(
        await page.evaluate(
          (key) =>
            Object.hasOwn(
              JSON.parse(localStorage.getItem(key) ?? "{}").user,
              "threadTreeCollapseStyle",
            ),
          KEY,
        ),
        false,
      );
    };
    await expect(prompt).toHaveCount(0);
    await parent.locator("[data-thread-summary]").click();
    await assertChoicesVisible();
    await expect(icon).toBeFocused();
    await treeShot(page, "prompt-short-sidebar-first-expansion");
    await prompt.getByRole("button", { name: "Later", exact: true }).click();
    await assertUnchosen();
    await page.reload();
    await expect(parent).toHaveAttribute("aria-expanded", "true");
    await expect(prompt).toHaveCount(0);
    await icon.click();
    await expect(parent).toHaveAttribute("aria-expanded", "false");
    await icon.click();
    await assertChoicesVisible();
    await treeShot(page, "prompt-short-sidebar-restored-reexpanded");
    await prompt.getByRole("button", { name: "Later", exact: true }).click();
    await parent.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await assertChoicesVisible();
    const reads = () =>
      host.requests.filter((request) => request.method === "codexhost/thread/tree/read").length;
    const before = reads();
    const occurrence = await icon.getAttribute("aria-controls");
    host.changed("parent", "codexhost/thread/tree/changed");
    await expect.poll(reads).toBeGreaterThan(before);
    await assertChoicesVisible();
    assert.equal(await icon.getAttribute("aria-controls"), occurrence);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.keyboard.press("Escape");
    await assertUnchosen();
    await page.setViewportSize({ width: 1280, height: 900 });
    await parent.scrollIntoViewIfNeeded();
    await themedShots(page, "prompt-recent-23-children-restored");
    await prompt.locator('[data-thread-style-choice="summary"]').click();
    await expect(prompt).toHaveCount(0);
    await icon.click();
    await icon.click();
    await expect(prompt).toHaveCount(0);
    await page.reload();
    await expect(parent).toHaveAttribute("aria-expanded", "true");
    await expect(prompt).toHaveCount(0);
  },
);

it(
  "automatic expansion never prompts; settings and storage updates return summary focus",
  { timeout: 40_000 },
  async (t) => {
    const { page } = await threadTreeBrowser(t, 1280, "grandchild");
    const parent = threadRow(page, "parent");
    const prompt = page.locator("[data-thread-style-prompt]");
    await expect(parent).toHaveAttribute("aria-expanded", "true");
    await expect(prompt).toHaveCount(0);
    await page.reload();
    await expect(parent).toHaveAttribute("aria-expanded", "true");
    await expect(prompt).toHaveCount(0);
    await parent.locator("[data-thread-icon-toggle]").click();
    await parent.locator("[data-thread-summary]").focus();
    await page.evaluate((key) => {
      const record = JSON.parse(localStorage.getItem(key) ?? "{}");
      record.user.threadTreeCollapseStyle = "ring";
      record.revision++;
      localStorage.setItem(key, JSON.stringify(record));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    }, KEY);
    await expect(parent.locator("[data-thread-summary]")).toHaveCount(0);
    await expect(parent.locator("[data-thread-icon-toggle]")).toBeFocused();
    const view = page.getByRole("button", { name: "View options", exact: true });
    await view.click();
    await view.focus();
    await page.keyboard.press("End");
    const compact = page.getByRole("menuitem", { name: "Compact", exact: true });
    await expect(compact).toBeFocused();
    await expect(compact.locator("svg")).toHaveCount(1);
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("menuitem", { name: "Detailed", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(view).toBeFocused();
    await parent.locator("[data-thread-summary]").waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "General", exact: true }).click();
    const display = page.getByRole("region", { name: "Display & language", exact: true });
    const styles = display.getByRole("radiogroup", {
      name: "Session count display",
      exact: true,
    });
    await expect(styles).toHaveAccessibleDescription(
      "How a collapsed parent shows its child sessions' status.",
    );
    await styles.getByRole("radio", { name: "Compact", exact: true }).click();
    await expect(styles.getByRole("radio", { name: "Compact", exact: true })).toBeChecked();
    await styles.getByRole("radio", { name: "Compact", exact: true }).press("ArrowLeft");
    await expect(styles.getByRole("radio", { name: "Detailed", exact: true })).toBeChecked();
    await display.scrollIntoViewIfNeeded();
    await themedShots(page, "style-1280-settings");
    await page.keyboard.press("Escape");
    await parent.locator("[data-thread-summary]").waitFor();
    await parent.locator("[data-thread-icon-toggle]").click();
    await expect(prompt).toHaveCount(0);
  },
);
