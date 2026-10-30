/** Delegation carriers are display-only Harness references, not Markdown links. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const width of [390, 1280])
  it(
    `sent delegation mentions show Harness icons and names at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      const thread = host.add("source", "/computer/project", "Delegation mentions");
      const first = "[@Grok](subagent://codexhost.grok)";
      const bitmap = "[@CH Harness](subagent://codexhost.fake)";
      const missing = "[@Removed Harness](subagent://codexhost.removed)";
      const literal = "[@reviewer](subagent://reviewer) [@bad](subagent://codexhost.bad_id)";
      const text = `${first} 让他搜索相关的事情\n${bitmap} ${first} ${missing}\n[@<b>name</b>](<subagent://codexhost.grok>)\n${literal}`;
      const user = thread.turns[0]?.items.find((item) => item.type === "userMessage");
      assert.ok(user);
      user.content = [{ type: "text", text }];
      const request = host.request.bind(host);
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        const result = await request<T>(method, params);
        if (method !== "codexhost/harness/plugins/list") return result;
        const base = result as { plugins: Array<Record<string, unknown>> };
        return {
          plugins: [
            ...base.plugins,
            {
              ...base.plugins[0],
              id: "grok",
              name: "Grok",
              iconStyle: {
                vector: {
                  viewBox: "0 0 24 24",
                  color: "currentColor",
                  paths: [{ d: "M2 2h20v20H2z" }],
                },
              },
            },
          ],
        } as T;
      };
      const debug = await startFakeChDebugger(host);
      t.after(() => debug.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--ch-cdp", debug.endpoint],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url}?session=source`);
      const body = page.locator("[data-conversation-scroll]");
      const chips = body.locator('[data-ref-chip="harness"]');
      await chips.first().waitFor();
      assert.deepEqual(await chips.allTextContents(), [
        "Grok",
        "CH Harness",
        "Grok",
        "Removed Harness",
        "<b>name</b>",
      ]);
      await chips.first().locator('svg[viewBox="0 0 24 24"]').waitFor();
      await chips.nth(1).locator("img").waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('[data-ref-chip="harness"] img');
        return image?.complete && image.naturalWidth > 0;
      });
      await page.waitForFunction(
        () => !!document.querySelector('[data-ref-chip="harness"][title*="codexhost.removed"] svg'),
      );
      assert.equal(await chips.locator("a,button,b,script").count(), 0);
      assert.equal(await chips.first().getAttribute("title"), first);
      assert.ok((await body.innerText()).includes(literal));
      assert.equal((await body.innerText()).includes(first), false);
      const icon = await chips
        .first()
        .locator("svg")
        .evaluate((svg) => ({
          width: svg.getBoundingClientRect().width,
          fill: getComputedStyle(svg).fill,
          color: getComputedStyle(svg).color,
        }));
      assert.equal(icon.width, 14);
      assert.equal(icon.fill, icon.color);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole("button", { name: "Copy", exact: true }).first().click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
      await page.reload();
      await chips.first().waitFor();
      assert.equal(await chips.count(), 5, "existing history renders without rewriting carriers");
      assert.deepEqual(user.content, [{ type: "text", text }]);
      assert.equal(
        host.requests.some((entry) => entry.method === "turn/start"),
        false,
      );
      assert.deepEqual(errors, []);
    },
  );
