import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

test.use({ timezoneId: "Asia/Shanghai" });
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createAccountsSettingsPage } from "./packages/renderer-extension/src/settings/accounts-page.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";

      globalThis.setupAccounts = ({ locale = "zh-CN", theme = "dark", scenario = "normal" } = {}) => {
        document.documentElement.style.colorScheme = theme;
        const accounts = [
          { accountId:"native",label:"Native",email:"zhaobin_jiang@163.com",planType:"pro" },
        ];
        const accountSnapshot = () => ({
          version:2,currentAccountId:"native",phase:"ready",revision:1,instanceId:"settings-host",
          accounts,
        });
        const snapshots = {
          native: { usedPercent:9,periodType:"seven_day",resetsAt:"2026-09-13T13:16:00Z",resetCredits:{availableCount:2,nextExpiresAt:"2026-10-04T01:54:00Z",expiresAt:["2026-10-04T01:54:00Z","2026-10-08T01:54:00Z"]} },
        };
        let harnessAccounts = [
          {harnessId:"grok",harnessName:"Grok Build",email:"grok@example.com",credits:{usedPercent:0,periodType:"weekly",resetsAt:"2026-09-17T03:32:00Z"}},
          {harnessId:"antigravity",harnessName:"Antigravity",credits:{label:"Gemini Models · Weekly window",usedPercent:10,periodType:"weekly"}},
          {harnessId:"claude-code",harnessName:"Claude Code",email:"claude@example.com",plan:"max",credits:{usedPercent:0,periodType:"five_hour",productUsage:[{product:"7-day window",usagePercent:50}]}},
        ];
        let failUsage = scenario === "error";
        const calls = { inspect:[] };
        const client = {
          ...(scenario === "external" ? {listHarnessAccounts: async () => ({accounts:harnessAccounts})} : {}),
          listCodexAccounts: async () => accountSnapshot(),
          refreshCodexAccounts: async () => accountSnapshot(),
          inspectCodexAccountUsage: async ({accountId}) => {
            calls.inspect.push(accountId);
            if (failUsage) throw new Error("offline");
            return {accountId,usage:null,accountCredits:snapshots[accountId],freshness:"cached",observedAt:"2026-09-10T08:20:00.000Z"};
          },
        };
        globalThis.accountsFixture = {
          calls,
          recover: () => { failUsage=false; },
          clearHarnessAccounts: () => { harnessAccounts=[]; },
        };
        const messages=rendererSettingsMessages(locale);
        const registry=createRendererSettingsPageRegistry([createAccountsSettingsPage(messages,()=>client)]);
        const shell=mountRendererSettingsShell(registry,document,messages);
        shell.openSettings(undefined,"accounts");
        globalThis.accountsFixture.dispose = () => shell.dispose();
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-accounts-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Account settings fixture bundle missing");

async function setup(page: Page, options = {}) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/accounts-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/accounts-test");
  await page.clock.install({ time: new Date("2026-09-10T08:20:00Z") });
  await page.clock.pauseAt(new Date("2026-09-10T08:20:00Z"));
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => Reflect.get(globalThis, "setupAccounts")(options), options);
}

const nativeRow = '[data-account-id="native"]';

test("shows detected Harness quota read-only and removes rows when authentication has no data", async ({
  page,
}) => {
  await setup(page, { scenario: "external" });
  const section = page.locator(".settings-account-table");
  const nativeAccounts = section.locator("tr[data-harness-id]");
  await expect(nativeAccounts).toHaveCount(3);
  await expect(page.locator(".settings-account-count")).toHaveText("账号4");
  await expect(
    nativeAccounts.getByRole("button", { name: /切换|删除|使用重置|登录$/ }),
  ).toHaveCount(0);
  const info = section.getByRole("button", { name: "Grok Build · 原生管理", exact: true });
  await info.click();
  const nativeInfo = section.locator('[data-harness-id="grok"] dialog[open]');
  await expect(nativeInfo).toContainText("登录、退出和切换请在其原生客户端中完成");
  await page.keyboard.press("Escape");
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").clearHarnessAccounts());
  await page.locator(".settings-account-toolbar").getByRole("button", { name: "刷新额度" }).click();
  await expect(nativeAccounts).toHaveCount(0);
  await expect(page.locator(".settings-account-count")).toHaveText("账号1");
});

test("shows current Codex quota, reset-credit count, and no Host consume or login actions", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".settings-account-table th")).toHaveText([
    "账号",
    "5 小时剩余",
    "7 天剩余",
    "管理",
  ]);
  await expect(page.locator(`${nativeRow} .settings-account-active`)).toHaveText("当前");
  await expect(page.locator(`${nativeRow} .settings-account-plan`)).toHaveText("Pro 20x");
  await expect(page.locator(`${nativeRow} .settings-account-reset-summary`)).toContainText("2 张");
  await expect(page.getByRole("button", { name: "添加 Codex 账号" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "登录", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "使用重置", exact: true })).toHaveCount(0);
  await page.locator(`${nativeRow} .settings-account-reset-summary`).click();
  await expect(page.locator(".settings-account-details-row:not([hidden]) li")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "使用重置", exact: true })).toHaveCount(0);
});

test("updates compact countdowns without requests or inventing a reset", async ({ page }) => {
  await setup(page);
  const countdown = page.locator(`${nativeRow} [data-resets-at]`).first();
  await expect(countdown).toHaveText("3d4h");
  const inspect = await page.evaluate(
    () => Reflect.get(globalThis, "accountsFixture").calls.inspect,
  );
  await page.clock.runFor(60_000);
  await expect(countdown).toHaveText("3d4h");
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls.inspect),
  ).toEqual(inspect);
});
