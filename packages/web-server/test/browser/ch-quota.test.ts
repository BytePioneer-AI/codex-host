import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const mode of [
  "plan",
  "account-only",
  "missing",
  "exhausted",
  "mirrored",
  "scoped",
  "legacy",
] as const) {
  it(`CH quota is independent from session usage (${mode})`, { timeout: 30_000 }, async (t) => {
    const host = new FakeChHost();
    host.add("quota-thread", "/computer/quota-project", "Quota example");
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "codexhost/thread/usage/inspect")
        return {
          threadId: params.threadId,
          usage:
            mode === "account-only"
              ? null
              : {
                  totalCostUsd: 1.23,
                  contextUsedTokens: 264_000,
                  contextWindowTokens: 1_000_000,
                  ...(mode === "plan" ||
                  mode === "exhausted" ||
                  mode === "mirrored" ||
                  mode === "scoped" ||
                  mode === "legacy"
                    ? {
                        planFiveHourUsedPercent: mode === "exhausted" ? 100 : 25,
                        planFiveHourResetsAtUnix: 1_800_000_000,
                        planSevenDayUsedPercent: 40,
                        planSevenDayResetsAtUnix: 1_800_100_000,
                      }
                    : {}),
                },
          ...(mode === "mirrored" || mode === "scoped" || mode === "legacy"
            ? {
                accountCredits: {
                  usedPercent: mode === "legacy" ? 18 : 25,
                  periodType: "five_hour",
                  resetsAt: new Date(1_800_000_000_000).toISOString(),
                  productUsage: [
                    {
                      product: "7-day window",
                      ...(mode === "legacy" ? {} : { periodType: "seven_day" }),
                      usagePercent: 40,
                      resetsAt: new Date(1_800_100_000_000).toISOString(),
                    },
                    ...(mode === "scoped"
                      ? [
                          {
                            product: "Opus",
                            periodType: "seven_day",
                            scope: { id: "opus", label: "Opus" },
                            usagePercent: 40,
                          },
                        ]
                      : []),
                  ],
                },
              }
            : {}),
          ...(mode === "account-only"
            ? {
                accountCredits: { usedPercent: 0, periodType: "monthly", used: 0, limit: 100 },
              }
            : {}),
        } as T;
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
    const folder = page.getByRole("treeitem").filter({ hasText: /^quota-project$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Quota example" }).click();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
    const usage = page.locator('[data-composer-stat="codexhost-usage"] button');
    const quota = page.locator('[data-composer-stat="codexhost-quota"] button');
    const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
    const capture = async (name: string) => {
      if (!screenshots) return;
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `quota-${mode}-${name}.png`) });
    };
    if (mode !== "account-only") {
      await usage.click();
      const details = page.getByRole("dialog", { name: "Usage details", exact: true });
      await details.waitFor();
      assert.doesNotMatch(await details.innerText(), /Plan usage|Account quota|5-hour|7-day/);
      await capture("usage");
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "hidden" });
    }
    if (mode === "missing") {
      assert.equal(await quota.count(), 0);
    } else {
      await quota.waitFor();
      const remaining =
        mode === "account-only"
          ? "100"
          : mode === "exhausted"
            ? "0"
            : mode === "legacy"
              ? "82"
              : "75";
      assert.equal(await quota.innerText(), `${remaining}%`);
      if (mode === "account-only") assert.equal(await usage.count(), 0);
      const quotaBox = await quota.boundingBox();
      const dockBox = await page.locator("[data-composer-dock]").boundingBox();
      const dockParentBox = await page.locator("[data-composer-dock]").locator("..").boundingBox();
      assert.ok(quotaBox && dockBox && Math.abs(quotaBox.x - dockBox.x) < 2);
      assert.ok(
        dockBox &&
          dockParentBox &&
          Math.abs(dockBox.x + dockBox.width / 2 - (dockParentBox.x + dockParentBox.width / 2)) < 2,
      );
      await quota.hover();
      const details = page.getByRole("dialog", { name: "Quota details", exact: true });
      await details.waitFor();
      assert.equal(
        await details.getByRole("progressbar").first().getAttribute("aria-valuenow"),
        remaining,
      );
      if (mode === "legacy") {
        assert.equal(await details.getByRole("progressbar").count(), 2);
        assert.equal(await details.getByText("7-day window", { exact: true }).count(), 1);
        assert.equal(await details.getByText("7-day limit", { exact: true }).count(), 0);
      }
      if (mode === "mirrored" || mode === "scoped") {
        assert.equal(await details.getByRole("progressbar").count(), mode === "scoped" ? 3 : 2);
        assert.equal(await details.getByText("5-hour limit", { exact: true }).count(), 1);
        assert.equal(await details.getByText("7-day limit", { exact: true }).count(), 1);
        if (mode === "scoped")
          assert.equal(await details.getByText("Opus", { exact: true }).count(), 1);
      }
      if (mode === "plan") {
        assert.match(await details.innerText(), /Remaining\s+60%/);
        assert.match(await details.innerText(), /Resets/);
      }
      await capture("hover");
      await quota.click();
      await page.getByText("existing CH answer", { exact: true }).hover();
      assert.equal(await details.isVisible(), true);
      await capture("pinned");
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "hidden" });
      await capture("closed");
    }
    if (mode !== "account-only") {
      await page.getByRole("button", { name: "26% of context used", exact: true }).click();
      const contextDialog = page.getByRole("dialog", { name: "of context used", exact: true });
      await contextDialog.waitFor();
      assert.equal(await contextDialog.locator("dl").count(), 0);
      assert.match(await contextDialog.innerText(), /264K/);
      await capture("context");
    }
    assert.deepEqual(errors, []);
  });
}
