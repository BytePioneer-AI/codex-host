import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ThreadUsageSnapshot } from "@codexhost/shared-contracts";
import { chromium } from "playwright";

import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

const cases: Array<{
  name: string;
  usage: ThreadUsageSnapshot;
  genericCache: string | null;
  latest: string;
  average: string;
}> = [
  {
    name: "unknown-cache-buckets",
    usage: {
      inputTokens: 144_252,
      outputTokens: 32_294,
      cacheHitRatePercent: 99.51685747295453,
      sessionCacheHitRatePercent: 97.56966586569621,
    },
    genericCache: null,
    latest: "99.5%",
    average: "97.6%",
  },
  {
    name: "known-zero-cache",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 40,
      cacheHitRatePercent: 0,
      sessionCacheHitRatePercent: 0,
    },
    genericCache: "Cache hit 0%",
    latest: "0%",
    average: "0%",
  },
  {
    name: "known-cache-buckets",
    usage: {
      inputTokens: 1_000,
      cachedInputTokens: 900,
      cacheWriteInputTokens: 0,
      outputTokens: 40,
      cacheHitRatePercent: 95,
      sessionCacheHitRatePercent: 90,
    },
    genericCache: "Cache hit 90%",
    latest: "95%",
    average: "90%",
  },
];

for (const scenario of cases) {
  it(
    `CH usage preserves authoritative cache rates (${scenario.name})`,
    { timeout: 30_000 },
    async (t) => {
      const host = new FakeChHost();
      host.add("cache-thread", "/computer/cache-project", "Cache example");
      const request = host.request.bind(host);
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (method === "codexhost/thread/usage/inspect")
          return { threadId: params.threadId, usage: scenario.usage } as T;
        return request<T>(method, params);
      };
      const debuggerServer = await startFakeChDebugger(host);
      t.after(() => debuggerServer.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--session-source", "codexhost", "--ch-cdp", debuggerServer.endpoint],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const folder = page.getByRole("treeitem").filter({ hasText: /^cache-project$/u });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.getByRole("treeitem").filter({ hasText: "Cache example" }).click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      const hostUsage = page.locator('[data-composer-stat="codexhost-usage"] button');
      await hostUsage.waitFor();
      assert.match(
        await hostUsage.innerText(),
        new RegExp(`CH ${scenario.latest.replace(".", "\\.")}`),
      );
      const generic = page.locator('[data-composer-stat="usage"]');
      if (scenario.genericCache === null) assert.equal(await generic.count(), 0);
      else assert.ok((await generic.innerText()).includes(scenario.genericCache));
      const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
      if (screenshots) {
        mkdirSync(screenshots, { recursive: true });
        await page.screenshot({ path: join(screenshots, `${scenario.name}-summary.png`) });
      }
      await hostUsage.click();
      const dialog = page.getByRole("dialog", { name: "Usage details", exact: true });
      await dialog.waitFor();
      assert.equal(
        await dialog
          .locator("dt")
          .filter({ hasText: "Average cache hit" })
          .locator("+ dd")
          .innerText(),
        scenario.average,
      );
      assert.equal(
        await dialog
          .locator("dt")
          .filter({ hasText: "Latest cache hit (CH)" })
          .locator("+ dd")
          .innerText(),
        scenario.latest,
      );
      if (screenshots)
        await page.screenshot({ path: join(screenshots, `${scenario.name}-details.png`) });
      assert.deepEqual(errors, []);
    },
  );
}
