import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

/** Native touch input exercises browser gesture arbitration, not only DOM event dispatch. */
async function swipe(page: Page, from: number, to: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from, y: 350 }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from + ((to - from) * step) / 8, y: 350 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

it(
  "animates the first Sidebar opening as well as reopening, except with reduced motion",
  { timeout: 60_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "sidebar-first-open-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const host = new FakeChHost();
    host.add("thread", workspace, "Sidebar animation thread");
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
      { name: "phone button", width: 390, swipe: false, reduce: false },
      { name: "phone swipe", width: 390, swipe: true, reduce: false },
      { name: "desktop button", width: 1280, swipe: false, reduce: false },
      { name: "reduced motion", width: 390, swipe: false, reduce: true },
    ]) {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: 844 },
        hasTouch: profile.width === 390,
        isMobile: profile.width === 390,
        reducedMotion: profile.reduce ? "reduce" : "no-preference",
      });
      try {
        t.diagnostic(profile.name);
        const page = await context.newPage();
        const target = new URL(url);
        target.searchParams.set("session", "thread");
        await page.goto(target.href);
        await page.getByText("earlier question", { exact: true }).waitFor();
        await page.waitForLoadState("networkidle");
        // A longer transition makes the intermediate geometry deterministic under CI load.
        await page.addStyleTag({ content: ":root { --ds-transition-duration-slow: 1000ms; }" });
        for (const opening of ["first", "reopen"]) {
          if (profile.swipe) await swipe(page, 300, 130);
          else await page.locator("[data-sidebar-right-expand]").click();
          const panel = page.locator("[data-sidebar-right-open]");
          await panel.waitFor();
          const animation = await panel.evaluate((node) => {
            const dock = node.querySelector<HTMLElement>(
              '[data-dockkit-host="dock"]:not([hidden])',
            );
            if (dock === null) throw new Error("Visible dock panel not found");
            const transitions = dock
              .getAnimations()
              .filter(
                (animation) =>
                  "transitionProperty" in animation && animation.transitionProperty === "transform",
              );
            return {
              count: transitions.length,
              left: dock.getBoundingClientRect().left,
              destination: node.getBoundingClientRect().left,
            };
          });
          assert.equal(
            animation.count,
            profile.reduce ? 0 : 1,
            `${profile.name}: ${opening} slide`,
          );
          if (!profile.reduce)
            assert.ok(animation.left > animation.destination + 1, `${opening} starts offscreen`);
          await panel.evaluate(async (node) => {
            await Promise.allSettled(node.getAnimations({ subtree: true }).map((a) => a.finished));
          });
          if (opening === "first") {
            await page.locator('[data-sidebar-right-guide-entry="files"]').click();
            await page.locator("[data-files-state]").waitFor();
            assert.equal(await page.locator("[data-sidebar-right-opening]").count(), 0);
            const filesTab = await page
              .locator("[data-dockkit-tab]")
              .first()
              .getAttribute("data-dockkit-tab");
            await page.locator("[data-dockkit-add-tab]").click();
            await page.locator(`[data-dockkit-tab="${filesTab}"]`).click();
            const tabSlides = await panel.evaluate(
              (node) =>
                node
                  .getAnimations({ subtree: true })
                  .filter(
                    (animation) =>
                      "transitionProperty" in animation &&
                      animation.transitionProperty === "transform",
                  ).length,
            );
            assert.equal(tabSlides, 0, "switching tabs in an open panel does not slide the panel");
          }
          if (profile.swipe) await swipe(page, 90, 260);
          else await page.locator("[data-sidebar-right-toggle]").click();
          await page.locator("[data-sidebar-right-open]").waitFor({ state: "detached" });
          if (profile.swipe) {
            const closing = await page
              .locator("[data-sidebar-right-panel]")
              .evaluate(
                (node) =>
                  node
                    .getAnimations({ subtree: true })
                    .filter(
                      (animation) =>
                        "transitionProperty" in animation &&
                        animation.transitionProperty === "transform",
                    ).length,
              );
            assert.equal(closing, 1, "return swipe animates the panel out");
            assert.equal(await page.locator("[data-phone][data-sidebar-collapsed]").count(), 1);
          }
          await page.locator("[data-sidebar-right-panel]").evaluate(async (node) => {
            await Promise.allSettled(node.getAnimations({ subtree: true }).map((a) => a.finished));
          });
        }
      } finally {
        await context.close();
      }
    }
  },
);

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
        if (profile.mobile) {
          await swipe(page, 90, 250);
          await page.locator("[data-phone]:not([data-sidebar-collapsed])").waitFor();
          await page.touchscreen.tap(375, 350);
          await page.locator("[data-phone][data-sidebar-collapsed]").waitFor();
          await swipe(page, 300, 130);
        } else {
          await opener.click();
        }
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

        if (profile.mobile) {
          await swipe(page, 90, 260);
          await page
            .locator("[data-sidebar-right-open]")
            .waitFor({ state: "detached", timeout: 5000 });
          assert.equal(
            await page.locator("[data-phone][data-sidebar-collapsed]").count(),
            1,
            "return swipe closes the right panel without opening the left drawer",
          );
          await swipe(page, 300, 130);
          await page.locator("[data-sidebar-right-open]").waitFor();
          assert.equal(
            await page.locator("[data-sidebar-right-guide]").count(),
            1,
            "swiping a guide card does not activate it or discard the current tab",
          );
          assert.equal(await page.locator("[data-files-state]").count(), 0);
        }
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
