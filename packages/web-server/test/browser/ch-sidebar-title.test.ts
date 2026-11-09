import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const locale of ["en-US", "zh-CN"]) {
  for (const pinned of [false, true]) {
    it(
      `sidebar title stays Sessions (${locale}, ${pinned ? "with pins" : "without pins"})`,
      { timeout: 60_000 },
      async (t) => {
        const host = new FakeChHost();
        host.add("project-session", "/computer/product", "Project conversation");
        if (pinned) host.pinnedIds = ["project-session"];
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
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale });
        const chinese = locale === "zh-CN";
        const response = await page.request.post(new URL("/api/settings/mutate", url).href, {
          headers: { origin: new URL(url).origin },
          data: {
            type: "client-request",
            rpcId: "fixture-locale",
            method: "settings/mutate",
            payload: {
              args: {
                ns: "locale",
                ops: [{ op: "set", path: ["preference"], value: chinese ? "zh" : "en" }],
              },
            },
          },
        });
        assert.equal(response.ok(), true);
        assert.equal((await response.json()).result.ok, true);
        await page.goto(url);
        await page.locator('[data-row-key="section:workspaces"]').waitFor();
        const title = page.getByText(chinese ? "会话" : "Sessions", { exact: true });
        assert.equal(await title.count(), 1);
        assert.equal(await title.isVisible(), true);
        assert.equal(
          await page.getByText(chinese ? "工作区" : "Workspaces", { exact: true }).count(),
          1,
          "Workspaces labels only the folder group, not the sidebar header",
        );
        assert.equal(await page.locator('[data-row-key="section:pinned"]').count(), pinned ? 1 : 0);
      },
    );
  }
}
