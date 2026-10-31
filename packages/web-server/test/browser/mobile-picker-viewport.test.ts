import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

/** Replay DSH's Safari coordinate regression with the bundled Lexical runtime. */
async function keyboardViewport(page: Page): Promise<void> {
  const input = page.locator('[data-composer-input][contenteditable="true"]');
  await input.fill("keyboard viewport");
  const saved = await page.evaluateHandle(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("Missing visual viewport");
    const style = document.documentElement.style;
    const previous = {
      height: style.getPropertyValue("height"),
      priority: style.getPropertyPriority("height"),
      scroll: window.scrollY,
      offset: Object.getOwnPropertyDescriptor(viewport, "offsetTop"),
    };
    style.setProperty("height", `${window.innerHeight * 2}px`);
    window.scrollTo(0, window.innerHeight);
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: window.scrollY });
    return previous;
  });
  try {
    const before = await input.evaluate((node) => ({
      top: node.getBoundingClientRect().top,
      scroll: window.scrollY,
    }));
    assert.ok(before.scroll > 0, "fixture must exercise a scrolled page");
    await page.keyboard.insertText("z");
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    assert.deepEqual(
      await input.evaluate((node) => ({
        top: node.getBoundingClientRect().top,
        scroll: window.scrollY,
      })),
      before,
    );
  } finally {
    await saved.evaluate((previous) => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      if (previous.offset) Object.defineProperty(viewport, "offsetTop", previous.offset);
      else Reflect.deleteProperty(viewport, "offsetTop");
      const style = document.documentElement.style;
      if (previous.height === "") style.removeProperty("height");
      else style.setProperty("height", previous.height, previous.priority);
      window.scrollTo(0, previous.scroll);
    });
    await saved.dispose();
  }
}

it(
  "keeps mobile picker search explicit and preserves a keyboard-panned composer",
  { timeout: 90_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "mobile-picker-viewport-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const host = new FakeChHost();
    host.add("thread", workspace, "Picker thread");
    host.inspection.catalog.models = Array.from({ length: 5 }, (_, i) => ({
      ref: { id: i === 0 ? "native" : `model-${i}` },
      label: i === 0 ? "Native Model" : `Model ${i}`,
    }));
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
      { name: "desktop", mobile: false, userAgent: undefined },
      {
        name: "iPhone",
        mobile: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      },
      {
        name: "iPad",
        mobile: true,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      },
    ]) {
      const context = await browser.newContext({
        viewport: { width: profile.mobile ? 390 : 1280, height: 900 },
        hasTouch: profile.mobile,
        isMobile: profile.mobile,
        userAgent: profile.userAgent,
      });
      try {
        if (profile.name === "iPad")
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
        const trigger = page.getByRole("button", { name: /^Select model, current Native Model/u });
        await trigger.click();
        const thinking = page.getByRole("menu", { name: "Thinking", exact: true });
        await thinking.getByRole("menuitem", { name: "Native Model", exact: true }).click();
        const search = page.getByRole("searchbox", { name: "Search models…", exact: true });
        await search.waitFor();
        assert.equal(
          await search.evaluate((node) => document.activeElement === node),
          !profile.mobile,
          profile.name,
        );
        const current = page.getByRole("menuitemradio", { name: "Native Model", exact: true });
        if (profile.mobile)
          assert.equal(await current.evaluate((node) => document.activeElement === node), true);
        // Explicit keyboard input can enter search, and Escape still walks back.
        await page.keyboard.press("ArrowDown");
        assert.equal(await search.evaluate((node) => document.activeElement === node), true);
        await search.fill("Model 1");
        await page.getByRole("menuitemradio", { name: "Model 1", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
        const composer = page.locator('[data-composer-input][contenteditable="true"]');
        await composer.fill("/");
        await page
          .getByRole("listbox", { name: "Trigger suggestions", exact: true })
          .getByRole("option", { name: /^Permission\b/u })
          .click();
        await page.getByRole("listbox", { name: "/permission matches", exact: true }).waitFor();
        const filter = page.getByRole("textbox", { name: "Filter options", exact: true });
        assert.equal(
          await filter.evaluate((node) => document.activeElement === node),
          !profile.mobile,
          `${profile.name}: command popup`,
        );
        await filter.click();
        assert.equal(await filter.evaluate((node) => document.activeElement === node), true);
        await filter.press("Escape");
        await keyboardViewport(page);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
    assert.equal(
      host.requests.some((request) => ["turn/start", "thread/resume"].includes(request.method)),
      false,
    );
  },
);
