import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

/** Real touch input lets the browser arbitrate taps, scrolling and pointer cancellation. */
async function touchMove(page: Page, x: number, y: number, dx: number, dy = 0): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * step) / 8, y: y + (dy * step) / 8 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

it("supports phone document tab swipes and single taps", { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "document-tabs-touch-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const files = Array.from({ length: 8 }, (_, index) => `document-${index}.txt`);
  for (const file of files) writeFileSync(join(workspace, file), `Content of ${file}\n`);
  const host = new FakeChHost();
  const thread = host.add("thread", workspace, "Document tabs touch");
  thread.turns = [
    {
      id: "turn",
      status: "completed",
      items: [
        { id: "u", type: "userMessage", content: [{ type: "text", text: "open documents" }] },
        {
          id: "a",
          type: "agentMessage",
          text: files.map((file) => `[${file}](${file})`).join(" "),
        },
      ],
    },
  ];
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
    viewport: { width: 1280, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const target = new URL(url);
  target.searchParams.set("session", "thread");
  await page.goto(target.href);
  await page.getByText("open documents", { exact: true }).waitFor();
  for (const file of files) {
    await page.getByRole("button", { name: file, exact: true }).click();
    await page
      .locator("[data-textpreview-plain]")
      .filter({ hasText: `Content of ${file}` })
      .waitFor();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const strip = page.locator("[data-dockkit-strip-tabs]:visible");
  await strip.waitFor();
  // Settle automatic active-chip scrolling before exercising native gestures.
  await page.addStyleTag({
    content: "[data-dockkit-strip-tabs] { scroll-behavior: auto !important; }",
  });

  await t.test(
    "horizontal swipes scroll the tab row without reordering or closing the sidebar",
    async () => {
      const before = await strip.evaluate((element) => {
        element.scrollLeft = 0;
        return {
          width: element.clientWidth,
          total: element.scrollWidth,
          active: element.querySelector('[aria-selected="true"]')?.getAttribute("data-dockkit-tab"),
          tabs: [...element.querySelectorAll("[data-dockkit-tab]")].map((tab) =>
            tab.getAttribute("data-dockkit-tab"),
          ),
        };
      });
      assert.ok(before.total > before.width, "fixture has overflowing tabs");
      const box = await strip.boundingBox();
      assert.ok(box);
      await touchMove(page, box.x + box.width - 25, box.y + box.height / 2, -150);
      assert.ok(
        (await strip.evaluate((element) => element.scrollLeft)) > 50,
        "swipe scrolls the tab row",
      );
      assert.deepEqual(
        await strip
          .locator("[data-dockkit-tab]")
          .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-dockkit-tab"))),
        before.tabs,
      );
      assert.equal(
        await strip.locator('[aria-selected="true"]').getAttribute("data-dockkit-tab"),
        before.active,
        "scrolling does not switch tabs",
      );
      await page.locator("[data-sidebar-right-open]").waitFor();
      const offset = await strip.evaluate((element) => element.scrollLeft);
      await touchMove(page, box.x + 25, box.y + box.height / 2, 120);
      assert.ok(
        (await strip.evaluate((element) => element.scrollLeft)) < offset - 30,
        "reverse swipe scrolls back",
      );
    },
  );

  await t.test("touch hover does not reveal an inactive tab's close target", async () => {
    await strip.evaluate((element) => {
      element.scrollLeft = 0;
    });
    const tab = strip.getByRole("tab").filter({ hasText: files[0] }).first();
    await tab.hover();
    const close = tab.locator("[data-dockkit-tab-close]");
    assert.equal(
      await close.evaluate((element) => getComputedStyle(element).pointerEvents),
      "none",
      "emulated hover must not make a hidden close button intercept the first touch",
    );
  });

  await t.test("one slightly moving touch selects an inactive tab", async () => {
    await strip.evaluate((element) => {
      element.scrollLeft = 0;
    });
    const tab = strip.getByRole("tab").filter({ hasText: files[0] }).first();
    const id = await tab.getAttribute("data-dockkit-tab");
    const box = await tab.boundingBox();
    assert.ok(box);
    await touchMove(page, box.x + 20, box.y + box.height / 2, 0, 6);
    assert.equal(
      await page.locator(`[data-dockkit-tab="${id}"]:visible`).getAttribute("aria-selected"),
      "true",
      "a small finger movement must still activate on the first touch",
    );
    for (const file of [files[1], files[0], files[1], files[0]]) {
      const next = strip.getByRole("tab").filter({ hasText: file }).first();
      const nextId = await next.getAttribute("data-dockkit-tab");
      const bounds = await next.boundingBox();
      assert.ok(bounds);
      // The trailing edge overlaps the close target only after the tab is selected.
      await page.touchscreen.tap(bounds.x + bounds.width - 14, bounds.y + bounds.height / 2);
      assert.equal(
        await page.locator(`[data-dockkit-tab="${nextId}"]:visible`).getAttribute("aria-selected"),
        "true",
      );
      assert.equal(
        await strip.getByRole("tab").count(),
        files.length,
        "an inactive tab's trailing edge selects, not closes",
      );
    }
    await strip.locator('[aria-selected="true"] [data-dockkit-tab-close]').tap();
    assert.equal(
      await strip.getByRole("tab").count(),
      files.length - 1,
      "the active tab still closes with one touch",
    );
  });

  await t.test(
    "desktop keeps hover controls, keyboard selection and mouse tab dragging",
    async () => {
      const desktop = await browser.newPage({ viewport: { width: 1280, height: 844 } });
      try {
        await desktop.goto(target.href);
        for (const file of files.slice(0, 3)) {
          await desktop.getByRole("button", { name: file, exact: true }).click();
          await desktop
            .locator("[data-textpreview-plain]")
            .filter({ hasText: `Content of ${file}` })
            .waitFor();
        }
        const row = desktop.locator("[data-dockkit-strip-tabs]:visible");
        const first = row.getByRole("tab").first();
        await first.hover();
        assert.equal(
          await first
            .locator("[data-dockkit-tab-close]")
            .evaluate((element) => getComputedStyle(element).pointerEvents),
          "auto",
        );
        const last = row.getByRole("tab").last();
        const lastId = await last.getAttribute("data-dockkit-tab");
        const from = await last.boundingBox();
        const to = await first.boundingBox();
        assert.ok(from && to);
        await desktop.mouse.move(from.x + 20, from.y + from.height / 2);
        await desktop.mouse.down();
        await desktop.mouse.move(to.x + 5, to.y + to.height / 2, { steps: 10 });
        await desktop.mouse.up();
        assert.equal(await row.getByRole("tab").first().getAttribute("data-dockkit-tab"), lastId);
        await row.getByRole("tab").first().focus();
        await desktop.keyboard.press("ArrowRight");
        await desktop.keyboard.press("Enter");
        assert.equal(await row.getByRole("tab").nth(1).getAttribute("aria-selected"), "true");
      } finally {
        await desktop.close();
      }
    },
  );
});
