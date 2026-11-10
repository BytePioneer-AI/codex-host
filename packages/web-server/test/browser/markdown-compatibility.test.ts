import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const mobile of [false, true]) {
  it(
    `Markdown compatibility and wide-table scrolling (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      const row = host.add(
        "markdown-compatibility",
        "/tmp/markdown-compatibility",
        "Markdown compatibility",
      );
      const answer = row.turns[0]?.items.at(-1);
      assert.ok(answer);
      const columns = Array.from({ length: 8 }, (_, index) => `Comparison ${index + 1}`);
      answer.text = [
        "Markdown compatibility answer",
        "约 10~20 分钟，或 30~40 分钟，~~删除~~",
        "$$a+b\nc+d$$",
        "After formula",
        String.raw`[Windows source](D:\repo\.github\a.md#L4)`,
        [
          `| ${columns.join(" | ")} |`,
          `| ${columns.map(() => "---").join(" | ")} |`,
          `| ${columns.map(() => "Long comparison cell with enough text to require horizontal scrolling").join(" | ")} |`,
        ].join("\n"),
      ].join("\n\n");
      const debug = await startFakeChDebugger(host);
      t.after(() => debug.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
        { authenticated: true },
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      if (mobile) await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
      const folder = page.getByRole("treeitem").filter({ hasText: /^markdown-compatibility$/ });
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator('[data-row-key="session:markdown-compatibility"]').click();
      await page.getByText("Markdown compatibility answer", { exact: true }).waitFor();
      assert.deepEqual(await page.locator("del").allTextContents(), ["删除"]);
      await page.getByText("约 10~20 分钟，或 30~40 分钟，", { exact: false }).waitFor();
      assert.deepEqual(await page.locator(".katex-display annotation").allTextContents(), [
        "a+b\nc+d",
      ]);
      assert.equal(await page.locator(".katex-error").count(), 0);
      await page.getByText("After formula", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Windows source", exact: true })
          .getAttribute("title"),
        String.raw`D:\repo\.github\a.md`,
      );

      const table = page.locator(".md-table-wide");
      await table.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      assert.equal(await page.evaluate(() => matchMedia("(hover: hover)").matches), !mobile);
      assert.ok(await table.evaluate((element) => element.scrollWidth > element.clientWidth));
      assert.equal(
        await table.evaluate((element) => getComputedStyle(element).overflowX),
        mobile ? "auto" : "hidden",
      );
      if (mobile) {
        const box = await table.boundingBox();
        assert.ok(box);
        const x = Math.min(box.x + box.width - 25, 360);
        const y = box.y + Math.min(box.height / 2, 40);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (const offset of [40, 80, 120, 160, 200]) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: x - offset, y }],
          });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      } else {
        await table.hover();
        assert.equal(
          await table.evaluate((element) => getComputedStyle(element).overflowX),
          "scroll",
        );
        await page.mouse.move(0, 0);
        // Keyboard focus must override the resting hover-capable rule without a pointer over the table.
        await page.keyboard.press("Tab");
        await table.focus();
        assert.equal(await table.evaluate((element) => element.matches(":focus-visible")), true);
        assert.equal(
          await table.evaluate((element) => getComputedStyle(element).overflowX),
          "scroll",
        );
        await page.keyboard.press("ArrowRight");
      }
      await page.waitForFunction(
        () => (document.querySelector(".md-table-wide")?.scrollLeft ?? 0) > 0,
      );
      assert.deepEqual(errors, []);
      assert.equal(
        host.requests.some((request) => ["turn/start", "thread/resume"].includes(request.method)),
        false,
      );
    },
  );
}
