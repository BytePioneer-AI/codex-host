import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "places the turn rail in the left gutter with right-hand previews, graduated markers and working jumps",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    const row = host.add("rail", "/computer/project", "Navigation example");
    row.turns = Array.from({ length: 12 }, (_, i) => ({
      id: `t-${i}`,
      status: "completed",
      items: [
        {
          id: `u-${i}`,
          type: "userMessage",
          content: [{ type: "text", text: `Navigation question ${i}` }],
        },
        {
          id: `a-${i}`,
          type: "agentMessage",
          text:
            `Navigation answer ${i}. ` +
            "This response is long enough to demonstrate a compact three-line navigation preview. ".repeat(
              8,
            ),
        },
      ],
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    let historyPageRequests = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/session/page") historyPageRequests++;
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/ });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Navigation example" }).click();
    await page.getByText("Navigation question 11", { exact: true }).waitFor();
    const nav = page.getByRole("navigation", { name: "Turn navigation", exact: true });
    await nav.waitFor();
    const rail = await nav.boundingBox(),
      scroll = await page.locator("[data-conversation-scroll]").boundingBox();
    assert.ok(rail && scroll);
    assert.ok(
      rail.x - scroll.x >= 8 && rail.x - scroll.x <= 20,
      "rail must be at the left edge of the conversation, not the right edge",
    );
    const marks = nav.getByRole("button");
    assert.equal(await marks.count(), 5);
    assert.equal(await marks.first().getAttribute("aria-label"), "Jump to user message 1");
    await marks.nth(2).hover();
    const tip = page.getByRole("tooltip");
    await tip.waitFor();
    await page.waitForTimeout(200); // measure after the preview entrance transition
    assert.ok((await tip.textContent())?.includes("Navigation question 9"));
    const preview = await tip.boundingBox();
    assert.ok(preview);
    assert.ok(preview.x >= rail.x + rail.width - 1, "preview opens to the right of the rail");
    assert.ok(preview.width <= 321);
    const widths = await marks.evaluateAll((es) =>
      es.map((e) => {
        const css = getComputedStyle(e, "::before");
        return parseFloat(css.width) * new DOMMatrixReadOnly(css.transform).a;
      }),
    );
    assert.ok(
      (widths[2] ?? 0) > (widths[1] ?? 0) && (widths[1] ?? 0) > (widths[0] ?? 0),
      "neighbor marks widen progressively toward the hovered mark",
    );
    const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "left-rail-hover.png") });
    }
    await marks.first().click();
    await page.waitForFunction(
      () =>
        document.querySelector('nav button[aria-current="true"]')?.getAttribute("data-index") ===
        "0",
    );
    const firstQuestion = await page
      .locator('[data-chat-flow-kind="user"]')
      .getByText("Navigation question 7", { exact: true })
      .boundingBox();
    assert.ok(firstQuestion && firstQuestion.y >= scroll.y && firstQuestion.y < scroll.y + 160);
    const scrollTop = await page
      .locator("[data-conversation-scroll]")
      .evaluate((el) => el.scrollTop);
    await marks.first().hover();
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(200);
    assert.equal(historyPageRequests, 0, "scrolling the rail must not page the transcript");
    assert.ok(
      Math.abs(
        (await page.locator("[data-conversation-scroll]").evaluate((el) => el.scrollTop)) -
          scrollTop,
      ) < 1,
    );
    // A captured drag must not jump back to the pointer-down mark on release.
    const from = await marks.first().boundingBox(),
      to = await marks.nth(3).boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        document.querySelector('nav button[aria-current="true"]')?.getAttribute("data-index") ===
        "3",
    );
    await page.mouse.move(800, 300);
    await marks.first().focus();
    await page.keyboard.press("Tab");
    await tip.waitFor();
    assert.ok((await tip.textContent())?.includes("Navigation question 8"));
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector('nav button[aria-current="true"]')?.getAttribute("data-index") ===
        "1",
    );
    await page.waitForTimeout(200);
    if (screenshots) await page.screenshot({ path: join(screenshots, "left-rail-keyboard.png") });
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForTimeout(350); // let responsive sidebar placement settle
    await nav.waitFor({ state: "hidden" });
    if (screenshots) await page.screenshot({ path: join(screenshots, "left-rail-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await nav.waitFor();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await marks.nth(2).hover();
    await tip.waitFor();
    assert.equal(
      await marks.nth(2).evaluate((e) => getComputedStyle(e, "::before").transitionDuration),
      "0s",
    );
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "left-rail-dark-reduced-motion.png") });
    assert.deepEqual(errors, []);
  },
);
