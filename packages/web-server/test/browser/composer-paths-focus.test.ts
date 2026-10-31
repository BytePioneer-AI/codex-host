import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "decorates pasted paths and only auto-focuses the desktop composer",
  { timeout: 60_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "composer-paths-focus-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const host = new FakeChHost();
    const first = host.add("one", workspace, "First conversation");
    const second = host.add("two", workspace, "Second conversation");
    const firstAnswer = first.turns[0]?.items.at(-1);
    const secondAnswer = second.turns[0]?.items.at(-1);
    assert.ok(firstAnswer);
    assert.ok(secondAnswer);
    firstAnswer.text = "First conversation answer";
    secondAnswer.text = "Second conversation answer";
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
    const profiles = [
      { name: "desktop", automatic: true },
      {
        name: "iPhone",
        automatic: false,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      },
      {
        name: "desktop-mode iPad",
        automatic: false,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      },
    ];
    for (const profile of profiles) {
      // A wide viewport keeps the session Sidebar reachable while device identity
      // varies. This tests focus policy, not an emulated software keyboard.
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        userAgent: profile.userAgent,
        hasTouch: !profile.automatic,
      });
      try {
        if (profile.name === "desktop-mode iPad") {
          await context.addInitScript(() => {
            Object.defineProperties(navigator, {
              platform: { configurable: true, value: "MacIntel" },
              maxTouchPoints: { configurable: true, value: 5 },
            });
          });
        }
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const target = new URL(url);
        target.searchParams.set("session", "one");
        await page.goto(target.href);
        const input = page.locator('[data-composer-input][contenteditable="true"]');
        await input.waitFor();
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        assert.equal(
          await input.evaluate((node) => node === document.activeElement),
          profile.automatic,
          `${profile.name}: mount`,
        );
        await input.click();
        assert.equal(
          await input.evaluate((node) => node === document.activeElement),
          true,
          `${profile.name}: explicit click`,
        );
        const text = '查看 @src/a.ts @"dir/a b.md" @README.md 以上';
        await input.evaluate((node, value) => {
          const data = new DataTransfer();
          data.setData("text/plain", value);
          node.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }, text);
        await page.waitForFunction(
          () => document.querySelectorAll("[data-composer-text-ref]").length === 3,
        );
        assert.deepEqual(await input.locator("[data-composer-text-ref]").allTextContents(), [
          "@src/a.ts",
          '@"dir/a b.md"',
          "@README.md",
        ]);
        assert.equal(await input.textContent(), text);
        const folder = page
          .getByRole("treeitem")
          .filter({ hasText: new RegExp(`^${basename(workspace)}$`) })
          .first();
        if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
        await page.locator('[data-row-key="session:two"]').click();
        await page.getByText("Second conversation answer", { exact: true }).waitFor();
        await input.waitFor();
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        assert.equal(
          await input.evaluate((node) => node === document.activeElement),
          profile.automatic,
          `${profile.name}: session switch`,
        );
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
