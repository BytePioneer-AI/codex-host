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
        const calls = { inspect:[], imports:[] };
        const sources = [
          {id:"codex:fixture",harnessId:"codex",provider:"openai-codex",label:"zhaobin_jiang@163.com"},
          {id:"grok:fixture",harnessId:"grok",provider:"xai",label:"grok@example.com"},
        ];
        let imported = [];
        const client = {
          credentialImports: async (request) => {
            calls.imports.push(request);
            if (request.action === "import") imported.push({name:request.name,source:sources.find(s=>s.id===request.sourceId),importedAt:"2026-09-10T08:20:00Z"});
            if (request.action === "remove") imported = imported.filter(r=>r.name!==request.name);
            return {sources,targets:[{harnessId:"pi",providers:["openai-codex","xai"],imports:imported,others:[{provider:"anthropic",type:"oauth"},{provider:"codex1",type:"oauth",label:"same@example.com",vendor:"openai-codex"},{provider:"openai-codex",type:"api_key"}]}]};
          },
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
  await expect(
    section.locator('[data-harness-id="grok"] .settings-account-person-cell'),
  ).toHaveAttribute("title", /登录、退出和切换请在其原生客户端中完成/);
  // The last column holds only Harness target marks: no per-row refresh or native-management text.
  await expect(section.getByText("原生管理")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "刷新额度" })).toHaveCount(0);
  // Only logins with a verified-compatible target get the small Pi mark; every other row has none.
  await expect(
    section.locator('[data-harness-id="grok"] .settings-account-harness-target'),
  ).toBeEnabled();
  await expect(
    section.locator(
      '[data-harness-id="claude-code"] .settings-account-harness-target, [data-harness-id="antigravity"] .settings-account-harness-target',
    ),
  ).toHaveCount(0);
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
    "用于 Harness",
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

test("confirms imports and lists the copy in a dedicated Pi section, including a narrow window", async ({
  page,
}) => {
  await setup(page, { scenario: "external" });
  await page.setViewportSize({ width: 700, height: 900 });
  const mark = page.locator(`${nativeRow} .settings-account-harness-target`);
  const box = await mark.boundingBox();
  expect(box?.width ?? 99).toBeLessThanOrEqual(28);
  const pi = page.getByRole("region", { name: "Pi 中的账号" });
  // Logins Pi already had sit behind a disclosure that starts collapsed.
  const group = pi.locator(".settings-pi-accounts__others");
  const toggle = pi.getByRole("button", { name: /Pi 自有配置/ });
  await expect(group).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(group).toBeVisible();
  const others = group.locator(".settings-pi-accounts__row--other");
  await expect(others).toHaveCount(3);
  await expect(others.nth(0)).toContainText("anthropic");
  await expect(others.nth(1)).toContainText("same@example.com");
  await expect(others.nth(1)).toContainText("codex1");
  // A recognized OAuth vendor carries the same mark the account table uses for that credential.
  await expect(others.nth(1).locator('[data-agent="codex"]')).toHaveCount(1);
  await expect(others.nth(0).locator(".settings-pi-accounts__other-mark")).toHaveCount(1);
  await expect(others.nth(2)).toContainText("API Key");
  await expect(others.getByRole("button")).toHaveCount(0);
  await mark.click();
  const dialog = page.getByRole("dialog", { name: "导入到 Pi", exact: true });
  await expect(dialog).toContainText("保留全部已有 Provider 配置");
  await expect(dialog.getByLabel("模型入口名称")).toHaveValue("codex");
  expect(
    await page.evaluate(
      () =>
        Reflect.get(globalThis, "accountsFixture").calls.imports.filter(
          (r: { action: string }) => r.action === "import",
        ).length,
    ),
  ).toBe(0);
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  const done = page.getByRole("dialog", { name: "已复制到 Pi", exact: true });
  await expect(done).toContainText("复制不代表已验证模型调用");
  await done.getByRole("button", { name: "完成", exact: true }).click();
  await expect(done).toHaveCount(0);
  await expect(mark).toHaveAttribute("data-state", "imported");
  await expect(mark).toHaveAttribute("title", /已复制/);
  await expect(pi).toContainText("zhaobin_jiang@163.com");
  await expect(pi).toContainText("codex/…");
  await expect(pi).toContainText("已复制");

  await pi.getByRole("button", { name: /重新导入凭证/ }).click();
  const reimport = page.getByRole("dialog", { name: "重新导入凭证", exact: true });
  await expect(reimport).toContainText("使用同一来源账号更新 codex/…");
  await reimport.getByRole("button", { name: "确认导入", exact: true }).click();
  await page
    .getByRole("dialog", { name: "已复制到 Pi", exact: true })
    .getByRole("button", { name: "完成", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      Reflect.get(globalThis, "accountsFixture").calls.imports.some(
        (r: { action: string }) => r.action === "reimport",
      ),
    ),
  ).toBe(true);
  await expect(page.locator(`${nativeRow} .settings-account-active`)).toHaveText("当前");

  await pi.getByRole("button", { name: /从 Pi 移除/ }).click();
  const removal = page.getByRole("dialog", { name: "从 Pi 移除", exact: true });
  await removal.getByRole("button", { name: "取消", exact: true }).click();
  await expect(pi).toContainText("codex/…");
  await pi.getByRole("button", { name: /从 Pi 移除/ }).click();
  await removal.getByRole("button", { name: "从 Pi 移除", exact: true }).click();
  await expect(page.locator(".settings-credential-dialog[open]")).toHaveCount(0);
  await expect(others).toHaveCount(3);
  await expect(mark).not.toHaveAttribute("data-state", /.+/);
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
