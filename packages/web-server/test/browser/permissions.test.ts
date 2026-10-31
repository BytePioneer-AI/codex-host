import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const width of [390, 1280])
  it(
    `shows native configuration instead of a guessed permission at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      host.add("native-permissions", "/computer/permissions", "Native permissions thread");
      const request = host.request.bind(host);
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        const result = await request<T>(method, params);
        if (method === "codexhost/thread/inspect" && !host.modes.has(String(params.threadId)))
          delete (result as { effectivePermissionModeId?: string }).effectivePermissionModeId;
        return result;
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
        isMobile: width < 600,
        hasTouch: width < 600,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true }).last();
      if (await sidebar.isVisible()) await sidebar.click();
      const folder = page.getByRole("treeitem").filter({ hasText: /^permissions$/u });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator('[data-row-key="session:native-permissions"]').click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      const permission = page.getByRole("button", {
        name: "Access mode, current: Native configuration",
        exact: true,
      });
      await permission.waitFor();
      assert.match((await permission.getAttribute("title")) ?? "", /native permissions/u);
      assert.equal(
        await page
          .getByRole("button", { name: "Access mode, current: default", exact: true })
          .count(),
        0,
      );
      assert.equal(
        host.requests.some(({ method }) => method === "thread/start"),
        false,
      );
      await permission.click();
      await page.getByRole("menuitem", { name: "Ask", exact: true }).click();
      await page.getByRole("button", { name: "Access mode, current: Ask", exact: true }).waitFor();
      assert.equal(host.modes.get("native-permissions"), "ask");
      assert.deepEqual(errors, []);
    },
  );
