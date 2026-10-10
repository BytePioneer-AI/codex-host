import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({
    path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `${name}.png`),
    animations: "disabled",
  });
}

for (const mobile of [false, true]) {
  it(
    `light DSH sidebar keeps titles readable and controls usable (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      for (let i = 0; i < 28; i++) {
        host.add(
          `sidebar-${i}`,
          "/computer/product",
          `Conversation ${String(i).padStart(2, "0")} — review the workspace interaction and layout`,
        );
      }
      host.add("other-a", "/computer/reference-a", "Other project A");
      host.add("other-b", "/computer/reference-b", "Other project B");
      const debug = await startFakeChDebugger(host);
      t.after(() => debug.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      // Default draft selection/configuration must settle before opening the drawer.
      await page.getByText("Native Model", { exact: true }).waitFor();
      const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
      if (mobile) await openSidebar.first().click();
      const folder = page.getByRole("treeitem").filter({ hasText: /^product$/ });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      const rows = page.locator('[data-row-key^="session:sidebar-"]');
      await rows.first().waitFor();
      assert.equal(await rows.count(), 5);
      if (!mobile) await page.mouse.move(800, 800);
      const folderIcon = folder.locator("svg").first();
      assert.equal(await folder.locator('[data-openai-icon="Folder"]').count(), 0);
      assert.equal(await folderIcon.getAttribute("viewBox"), "0 0 16 16");
      assert.equal(await folderIcon.getAttribute("width"), "16");
      assert.equal(await folderIcon.getAttribute("stroke-width"), "1");
      assert.equal(await folderIcon.getAttribute("aria-hidden"), "true");
      const expandedFolderPath = await folderIcon.locator("path").first().getAttribute("d");
      const openColor = await folderIcon.evaluate((element) => getComputedStyle(element).color);
      if (!mobile) await folder.hover();
      assert.equal(
        await folderIcon.isVisible(),
        true,
        "open folder must not be replaced by a hover chevron",
      );
      const other = page.getByRole("treeitem").filter({ hasText: /^reference-a$/ });
      if ((await other.getAttribute("aria-expanded")) === "true") await other.click();
      const otherIcon = other.locator("svg").first();
      const closedColor = await otherIcon.evaluate((element) => getComputedStyle(element).color);
      const closedPath = await otherIcon.locator("path").first().getAttribute("d");
      await other.click();
      assert.equal(await other.getAttribute("aria-expanded"), "true");
      assert.equal(await otherIcon.isVisible(), true);
      assert.equal(
        await otherIcon.evaluate((element) => getComputedStyle(element).color),
        openColor,
        "expanding a different project is blue without changing the selected conversation",
      );
      assert.notEqual(openColor, closedColor);
      assert.notEqual(await otherIcon.locator("path").first().getAttribute("d"), closedPath);
      await shot(page, `folder-open-${mobile ? "touch" : "desktop"}`);
      await other
        .getByRole("button", { name: "Workspace actions for reference-a", exact: true })
        .click();
      await page.getByRole("menu").waitFor();
      assert.equal(await otherIcon.isVisible(), true, "folder stays visible with its menu open");
      assert.equal(
        await otherIcon.evaluate((element) => getComputedStyle(element).color),
        openColor,
      );
      await page.keyboard.press("Escape");
      await other.click();
      assert.equal(
        await otherIcon.evaluate((element) => getComputedStyle(element).color),
        closedColor,
      );
      assert.equal(await otherIcon.locator("path").first().getAttribute("d"), closedPath);
      if (!mobile) await page.mouse.move(800, 800);
      await shot(page, `sidebar-${mobile ? "touch" : "desktop"}-rest`);
      const row = rows.first();
      await row.locator('[data-harness-id="fake"]').waitFor();
      assert.equal(
        await page.locator("[data-openai-icon]").count(),
        0,
        "navigation uses one DSH icon family",
      );
      const trigger = row.getByRole("button", { name: /^Session actions for/ });
      if (mobile) {
        const bounds = await trigger.boundingBox();
        assert.ok(
          bounds && bounds.width >= 44 && bounds.height >= 44,
          "touch menu is a real 44px target",
        );
        assert.equal(
          await row.getByRole("button", { name: "Archive session", exact: true }).isVisible(),
          false,
        );
        await trigger.tap();
        await page.getByRole("menu").waitFor();
        await shot(page, "sidebar-touch-menu");
        assert.equal(await row.getAttribute("aria-selected"), "false", "menu does not navigate");
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "hidden" });
        await row.tap();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
        await shot(page, "sidebar-touch-conversation");
        await openSidebar.last().click();
        await shot(page, "sidebar-touch-selected");
      } else {
        const title = row.locator("[data-session-title]");
        const resting = await title.boundingBox();
        const rowBox = await row.boundingBox();
        assert.ok(
          resting && rowBox && resting.width > rowBox.width * 0.66,
          "resting title must not lose three button widths to hidden actions",
        );
        const groupA = page.getByRole("treeitem").filter({ hasText: /^reference-a$/ });
        const groupB = page.getByRole("treeitem").filter({ hasText: /^reference-b$/ });
        for (const group of [groupA, groupB]) {
          if ((await group.getAttribute("aria-expanded")) === "true") await group.click();
        }
        const a = await groupA.boundingBox(),
          b = await groupB.boundingBox();
        assert.ok(
          a && b && b.y - a.y - a.height >= 3 && b.y - a.y - a.height <= 5,
          "closed projects use compact 4px spacing",
        );
        await row.hover();
        await trigger.waitFor();
        const hovered = await title.boundingBox();
        assert.ok(
          resting && hovered && Math.abs(resting.width - hovered.width) < 1,
          "hover must not squeeze the title",
        );
        const fullTitle = await title.textContent();
        assert.ok(fullTitle);
        await page.getByRole("button").filter({ hasText: fullTitle }).waitFor();
        assert.equal(
          await title.evaluate((element) => element.scrollLeft),
          0,
          "titles stay still on hover",
        );
        for (const button of [
          trigger,
          row.getByRole("button", { name: "Archive session", exact: true }),
          row.getByRole("button", { name: "Pin session", exact: true }),
        ]) {
          const box = await button.boundingBox();
          assert.ok(
            box && rowBox && box.x >= rowBox.x && box.x + box.width <= rowBox.x + rowBox.width,
          );
        }
        await shot(page, "sidebar-desktop-hover");
        await row.getByRole("button", { name: "Pin session", exact: true }).click();
        await row.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
        await page.mouse.move(800, 800);
        await row.getByRole("img", { name: "Pinned", exact: true }).waitFor();
        await shot(page, "sidebar-desktop-pinned");
        await row.hover();
        await row.getByRole("button", { name: "Unpin session", exact: true }).click();
        await row.getByRole("button", { name: "Pin session", exact: true }).waitFor();
        await page.mouse.move(800, 800);
        assert.equal(
          await trigger.isVisible(),
          false,
          "mouse actions must not leave a sticky toolbar",
        );
        await row.click({ button: "right" });
        await page.getByRole("menu").waitFor();
        await page.mouse.move(1000, 800);
        await page.waitForTimeout(600);
        assert.equal(
          await page.getByRole("menu").isVisible(),
          true,
          "menu stays open when the pointer leaves",
        );
        await shot(page, "sidebar-desktop-context-menu");
        assert.equal(await row.getAttribute("aria-selected"), "false");
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "hidden" });
        await row.click();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
        await row.press("ArrowDown");
        assert.equal(
          await row.getAttribute("aria-selected"),
          "true",
          "focus movement does not navigate",
        );
        assert.equal(
          await rows.nth(1).evaluate((element) => element === document.activeElement),
          true,
        );
        await page.keyboard.press("Enter");
        assert.equal(await rows.nth(1).getAttribute("aria-current"), "page");
        await shot(page, "sidebar-desktop-keyboard");
        await page.getByRole("button", { name: "Show 10 more", exact: true }).click();
        assert.equal(await rows.count(), 15);
        await page.getByRole("button", { name: "Show 10 more", exact: true }).click();
        assert.equal(await rows.count(), 25);
        await page.getByRole("button", { name: "Show 3 more", exact: true }).click();
        assert.equal(await rows.count(), 28);
        const lastKey = await rows.last().getAttribute("data-row-key");
        await rows.last().click();
        await page.getByRole("button", { name: "Show less", exact: true }).click();
        assert.equal(
          await rows.count(),
          6,
          "selected older Thread survives collapse without all intermediate rows",
        );
        assert.equal(
          await page.locator(`[data-row-key="${lastKey}"]`).getAttribute("aria-selected"),
          "true",
        );
        await shot(page, "sidebar-selected-older");
        await folder.press("ArrowLeft");
        assert.equal(await folder.getAttribute("aria-expanded"), "false");
        assert.notEqual(
          await folderIcon.locator("path").first().getAttribute("d"),
          expandedFolderPath,
        );
        await folder.press("ArrowRight");
        assert.equal(await folder.getAttribute("aria-expanded"), "true");
        assert.equal(
          await folderIcon.locator("path").first().getAttribute("d"),
          expandedFolderPath,
        );
        assert.equal(await rows.count(), 6);
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        await page.mouse.move(1000, 800);
        await page.locator("body[data-ds-dark-theme]").waitFor();
        await shot(page, "sidebar-desktop-dark");
        await page.getByRole("button", { name: "View options", exact: true }).click();
        await page.getByRole("menuitem", { name: "In one list", exact: true }).click();
        const flatRows = page.locator('[data-row-key^="session:"]');
        assert.ok((await flatRows.count()) >= 10 && (await flatRows.count()) <= 11);
        assert.equal(
          await page.locator(`[data-row-key="${lastKey}"]`).getAttribute("aria-current"),
          "page",
        );
        await page.getByRole("button", { name: "Show 10 more", exact: true }).click();
        assert.ok((await flatRows.count()) >= 20 && (await flatRows.count()) <= 21);
        await shot(page, "sidebar-flat-paged");
      }
      assert.deepEqual(errors, []);
      assert.equal(
        host.requests.some((r) =>
          ["turn/start", "thread/start", "thread/archive"].includes(r.method),
        ),
        false,
      );
    },
  );
}
