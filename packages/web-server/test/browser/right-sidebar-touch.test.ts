import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "preserves mobile sidebar controls without changing desktop behavior",
  { timeout: 90_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "sidebar-touch-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const host = new FakeChHost();
    host.add("thread", workspace, "Sidebar touch thread");
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
    for (const profile of [
      { name: "narrow desktop", mobile: false, userAgent: undefined },
      {
        name: "iPhone",
        mobile: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      },
      {
        name: "desktop-mode iPad",
        mobile: true,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      },
    ]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: profile.mobile,
        isMobile: profile.mobile,
        ...(profile.userAgent === undefined ? {} : { userAgent: profile.userAgent }),
        reducedMotion: "reduce",
      });
      try {
        t.diagnostic(profile.name);
        if (profile.name === "desktop-mode iPad")
          await context.addInitScript(() => {
            Object.defineProperties(navigator, {
              platform: { value: "MacIntel", configurable: true },
              maxTouchPoints: { value: 5, configurable: true },
            });
          });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const target = new URL(url);
        target.searchParams.set("session", "thread");
        await page.goto(target.href);
        await page.getByText("earlier question", { exact: true }).waitFor();
        await page.waitForLoadState("networkidle");
        const opener = page.locator("[data-sidebar-right-expand]");
        await opener.waitFor();
        const footprint = await opener.evaluate((node) => node.getBoundingClientRect().toJSON());
        await opener.click();
        await page
          .locator('[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]')
          .waitFor();
        if (profile.mobile) {
          assert.equal(await opener.count(), 1, profile.name);
          assert.equal(await opener.isDisabled(), true);
          assert.equal(await opener.isVisible(), false);
          assert.deepEqual(
            await opener.evaluate((node) => node.getBoundingClientRect().toJSON()),
            footprint,
            "mobile opener retains its geometry while hidden",
          );
        } else {
          assert.equal(await opener.count(), 0, "narrow desktop still removes the opener");
        }
        const split = page.locator("[data-dockkit-split-button]");
        await page.locator("[data-dockkit-split-blocked]").waitFor({ state: "attached" });
        assert.equal(await split.isDisabled(), true);
        assert.equal(await split.isVisible(), !profile.mobile);
        const splitWidth = await split.evaluate((node) => node.getBoundingClientRect().width);
        assert.ok(splitWidth > 0, "hidden split controls keep their footprint");

        const collapse = page.locator("[data-sidebar-right-toggle]");
        await page.mouse.move(0, 800);
        const background = await collapse.evaluate(
          (node) => getComputedStyle(node).backgroundColor,
        );
        await collapse.hover();
        assert.equal(await collapse.evaluate((node) => node.matches(":hover")), true);
        const hovered = await collapse.evaluate((node) => getComputedStyle(node).backgroundColor);
        if (profile.mobile) assert.equal(hovered, background, "touch has no sticky hover color");
        else assert.notEqual(hovered, background, "desktop retains hover feedback");
        await collapse.click();
        await opener.waitFor();
        assert.equal(await opener.isDisabled(), false);
        if (profile.mobile)
          assert.deepEqual(
            await opener.evaluate((node) => node.getBoundingClientRect().toJSON()),
            footprint,
          );

        // A touch device can still split when there is room; the two-pane limit
        // hides blocked controls without collapsing their measured footprint.
        await page.setViewportSize({ width: 740, height: 900 });
        await opener.click();
        await page.locator("[data-dockkit-split-button]:not(:disabled)").waitFor();
        assert.equal(await split.isVisible(), true);
        assert.equal(
          await split.evaluate((node) => node.getBoundingClientRect().width),
          splitWidth,
        );
        await split.click();
        await page.waitForFunction(
          () => document.querySelectorAll("[data-dockkit-split-blocked]").length === 2,
        );
        for (const control of await split.all()) {
          assert.equal(await control.isDisabled(), true);
          assert.equal(await control.isVisible(), !profile.mobile);
          assert.equal(
            await control.evaluate((node) => node.getBoundingClientRect().width),
            splitWidth,
          );
        }
        assert.deepEqual(errors, [], profile.name);
      } finally {
        await context.close();
      }
    }
  },
);
