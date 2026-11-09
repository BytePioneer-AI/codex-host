import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const touch of [false, true]) {
  for (const width of [390, 1280]) {
    it(
      `pinned row actions follow input capability (${touch ? "touch" : "mouse"}, ${width}px)`,
      { timeout: 60_000 },
      async (t) => {
        const host = new FakeChHost();
        host.add("pinned-session", "/computer/product", "Pinned conversation");
        host.pinnedIds = ["pinned-session"];
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
          viewport: { width, height: 900 },
          isMobile: touch,
          hasTouch: touch,
        });
        await page.goto(url);
        await page.getByText("Native Model", { exact: true }).waitFor({ state: "attached" });
        const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true }).first();
        if (await openSidebar.isVisible()) await openSidebar.click();
        const row = page.locator('[data-row-key="session:pinned-session"]');
        await row.waitFor();
        await page.mouse.move(width - 10, 850);
        assert.equal(
          await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
          !touch,
        );
        assert.equal(await row.getByRole("img", { name: "Pinned", exact: true }).count(), 0);
        const unpin = row.getByRole("button", { name: "Unpin session", exact: true });
        const menu = row.getByRole("button", { name: "Session actions for Pinned conversation" });
        assert.equal(await unpin.isVisible(), false, "no resting standalone pin");
        if (touch) {
          assert.ok(await menu.isVisible(), "touch has a visible menu without long press");
          const bounds = await menu.boundingBox();
          assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
          await row.tap();
          await page.getByText("existing CH answer", { exact: true }).waitFor();
          if (width < 640)
            await page.getByRole("button", { name: "Open sidebar", exact: true }).last().click();
          assert.equal(await unpin.isVisible(), false, "touch focus does not expose shortcuts");
          await menu.tap();
          await page.getByRole("menuitem", { name: "Unpin session", exact: true }).click();
        } else {
          assert.equal(await menu.isVisible(), false);
          await row.hover();
          await unpin.waitFor();
          await page.mouse.move(width - 10, 850);
          await unpin.waitFor({ state: "hidden" });
          // Keyboard modality plus row focus must expose the same quick action.
          await page.keyboard.press("Shift");
          await row.focus();
          await unpin.waitFor();
          assert.ok(await row.evaluate((element) => element.matches(":focus-visible")));
          await unpin.click();
        }
        await page.locator('[data-row-key="section:pinned"]').waitFor({ state: "hidden" });
        assert.deepEqual(host.pinnedIds, [], "both entry points cancel the actual pin");
      },
    );
  }
}
