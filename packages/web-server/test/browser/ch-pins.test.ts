import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function shot(page: Page, name: string) {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({
    path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, name + ".png"),
    animations: name.endsWith("refused") ? "allow" : "disabled",
  });
}

for (const mobile of [false, true]) {
  it(
    `native pins share one top section across projects (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      for (let i = 0; i < 8; i++)
        host.add(`pin-${i}`, "/computer/product", `Project conversation ${i}`);
      host.add("reference-pin", "/computer/reference", "Reference conversation pinned in GUI");
      host.add("official", "/computer/reference", "Official Codex is not exposed").modelProvider =
        "openai";
      host.pinnedIds = ["official", "reference-pin"];
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
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
      if (mobile) await openSidebar.first().click();
      const pins = page.locator("[data-sidebar-pinned]");
      await pins.getByText("Reference conversation pinned in GUI", { exact: true }).waitFor();
      assert.equal(
        await page.getByText("Official Codex is not exposed", { exact: true }).count(),
        0,
      );
      const folder = page.getByRole("treeitem").filter({ hasText: /^product$/ });
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      const row = page.locator('[data-row-key="session:pin-0"]');
      await row.waitFor();
      await shot(page, `pins-${mobile ? "touch" : "desktop"}-initial`);
      const before = page.url();
      if (!mobile) await row.hover();
      await row.getByRole("button", { name: /^Session actions for/ }).click();
      await page.getByRole("menuitem", { name: "Pin session", exact: true }).click();
      await pins.locator('[data-row-key="session:pin-0"]').waitFor();
      assert.equal(page.url(), before, "pinning does not navigate");
      assert.deepEqual(host.pinnedIds, ["official", "reference-pin", "pin-0"]);
      assert.equal(
        await page.locator('[data-row-key="session:pin-0"]').count(),
        1,
        "no duplicated project row",
      );
      assert.equal(await pins.locator('[data-harness-id="fake"]').count(), 2);
      // Pinning changes row order: measure after the existing 200ms row glide,
      // not while the project header is still translating from its old position.
      await page.waitForFunction(() =>
        [...document.querySelectorAll("[data-row-key]")].every((element) =>
          element.getAnimations().every((animation) => animation.playState !== "running"),
        ),
      );
      const pinBox = await pins.boundingBox(),
        folderBox = await folder.boundingBox();
      assert.ok(pinBox && folderBox && pinBox.y + pinBox.height <= folderBox.y);
      await shot(page, `pins-${mobile ? "touch" : "desktop"}-added`);
      await folder.click();
      assert.equal(await row.isVisible(), true, "collapsing a project cannot hide a pin");
      await row.click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      if (mobile) await openSidebar.last().click();
      assert.equal(await row.getAttribute("aria-current"), "page");
      if (!mobile) {
        await row.press("Home");
        assert.equal(
          await pins
            .locator('[data-row-key="session:reference-pin"]')
            .evaluate((el) => el === document.activeElement),
          true,
        );
        assert.equal(
          await row.getAttribute("aria-current"),
          "page",
          "focus movement does not open another Thread",
        );
      }
      // A second browser receives the confirmed native pin order, not browser-local storage.
      const observer = await browser.newPage();
      await observer.goto(url);
      await observer.locator('[data-sidebar-pinned] [data-row-key="session:pin-0"]').waitFor();
      host.pinError = "Native pin refusal";
      if (!mobile) await row.hover();
      await row.getByRole("button", { name: /^Session actions for/ }).click();
      await page.getByRole("menuitem", { name: "Unpin session", exact: true }).click();
      await page.getByText(/Unpin not confirmed.*Native pin refusal/).waitFor();
      await page.waitForFunction(() => {
        const toast = document.querySelector('[role="alert"]');
        return toast && getComputedStyle(toast).opacity === "1";
      });
      assert.equal(await pins.locator('[data-row-key="session:pin-0"]').count(), 1);
      await shot(page, `pins-${mobile ? "touch" : "desktop"}-refused`);
      host.pinError = undefined;
      if (!mobile) await row.hover();
      await row.getByRole("button", { name: /^Session actions for/ }).click();
      await page.getByRole("menuitem", { name: "Unpin session", exact: true }).click();
      await pins.locator('[data-row-key="session:pin-0"]').waitFor({ state: "detached" });
      await observer
        .locator('[data-sidebar-pinned] [data-row-key="session:pin-0"]')
        .waitFor({ state: "detached" });
      assert.deepEqual(host.pinnedIds, ["official", "reference-pin"]);
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await row.waitFor();
      assert.equal(await row.getAttribute("aria-current"), "page");
      // Fixture simulates an outside GUI change; the page must discover it via the real polling path.
      host.pinnedIds = ["pin-7", "reference-pin", "official"];
      await pins.locator('[data-row-key="session:pin-7"]').waitFor({ timeout: 15_000 });
      assert.deepEqual(
        await pins
          .locator("[data-row-key]")
          .evaluateAll((rows) => rows.map((el) => el.getAttribute("data-row-key"))),
        ["session:pin-7", "session:reference-pin"],
      );
      await shot(page, `pins-${mobile ? "touch" : "desktop"}-gui-change`);
      await page.reload();
      await page.getByText("Native Model", { exact: true }).waitFor();
      if (mobile) await openSidebar.first().click();
      await pins.locator('[data-row-key="session:pin-7"]').waitFor();
      const menu = pins
        .locator('[data-row-key="session:pin-7"]')
        .getByRole("button", { name: /^Session actions for/ });
      if (mobile) {
        const box = await menu.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44);
      }
      await shot(page, `pins-${mobile ? "touch" : "desktop"}-reload`);
      await page.getByRole("button", { name: "View options", exact: true }).click();
      await page.getByRole("menuitem", { name: "In one list", exact: true }).click();
      await pins.locator('[data-row-key="session:pin-7"]').waitFor();
      const keys = await page
        .locator('[data-row-key^="session:"]')
        .evaluateAll((rows) => rows.map((el) => el.getAttribute("data-row-key")));
      assert.equal(new Set(keys).size, keys.length, "flat mode also renders each Thread only once");
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.locator("body[data-ds-dark-theme]").waitFor();
      await shot(page, `pins-${mobile ? "touch" : "desktop"}-flat-dark`);
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      await page.getByPlaceholder("Search session names").fill("Reference conversation");
      await page.getByText("Reference conversation pinned in GUI", { exact: true }).waitFor();
      assert.equal(
        await page.getByText("Reference conversation pinned in GUI", { exact: true }).count(),
        1,
      );
      assert.equal(
        await pins.count(),
        0,
        "search replaces the section without duplicating its result",
      );
      await shot(page, `pins-${mobile ? "touch" : "desktop"}-search`);
      assert.deepEqual(errors, []);
    },
  );
}
