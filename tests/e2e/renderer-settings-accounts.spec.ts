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
        let harnessAccounts = scenario === "balance" ? [
          {harnessId:"pi",harnessName:"Pi",label:"qingge",balance:{amount:4,currency:"USD",label:"钱包余额"}},
          {harnessId:"pi",harnessName:"Pi",label:"DeepSeek",balance:{amount:12.5,currency:"CNY",label:"DeepSeek API"}},
        ] : [
          {harnessId:"grok",harnessName:"Grok Build",email:"grok@example.com",credits:{usedPercent:0,periodType:"weekly",resetsAt:"2026-09-17T03:32:00Z"}},
          {harnessId:"antigravity",harnessName:"Antigravity",credits:{label:"Gemini Models · Weekly window",usedPercent:10,periodType:"weekly"}},
          {harnessId:"claude-code",harnessName:"Claude Code",email:"claude@example.com",plan:"max",credits:{usedPercent:0,periodType:"five_hour",productUsage:[{product:"7-day window",usagePercent:50}]}},
        ];
        if (scenario === "layout") harnessAccounts.push({
          harnessId:"kimi-code",harnessName:"Kimi Code",credits:{usedPercent:0,periodType:"weekly",resetsAt:"2026-09-17T03:32:00Z",productUsage:[{product:"Kimi Code · 5-hour",usagePercent:12,resetsAt:"2026-09-10T09:00:00Z"}]},
        });
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
          ...(["external", "balance", "layout"].includes(scenario) ? {listHarnessAccounts: async () => ({accounts:harnessAccounts})} : {}),
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
  // No per-row refresh or native-management text; only compatible logins get the Pi import chip.
  await expect(section.getByText("原生管理")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "刷新额度" })).toHaveCount(0);
  await expect(section.locator('[data-harness-id="grok"] .settings-account-pi-import')).toHaveText(
    "导入到 Pi",
  );
  await expect(
    section.locator(
      '[data-harness-id="claude-code"] .settings-account-pi-import, [data-harness-id="antigravity"] .settings-account-pi-import',
    ),
  ).toHaveCount(0);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").clearHarnessAccounts());
  await page.locator(".settings-account-toolbar").getByRole("button", { name: "刷新额度" }).click();
  await expect(nativeAccounts).toHaveCount(0);
  await expect(page.locator(".settings-account-count")).toHaveText("账号1");
});

test("shows each prepaid Billing Source without inventing quota percentages", async ({
  page,
}, testInfo) => {
  await setup(page, { scenario: "balance" });
  const piRows = page.locator('.settings-account-table tr[data-harness-id="pi"]');
  await expect(piRows).toHaveCount(2);
  await expect(piRows.filter({ hasText: "qingge" })).toContainText("USD 4.00");
  await expect(piRows.filter({ hasText: "DeepSeek" })).toContainText("CNY 12.50");
  await expect(piRows.getByRole("meter")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("accounts-balance-wide.png") });
  await page.setViewportSize({ width: 700, height: 900 });
  for (const cell of await piRows.locator(".settings-account-balance-cell").all()) {
    await expect(cell).toBeVisible();
    const box = await cell.boundingBox();
    if (!box) throw new Error("Balance cell has no visible bounds");
    expect(box.x + box.width).toBeLessThanOrEqual(700);
  }
  await page.screenshot({ path: testInfo.outputPath("accounts-balance-narrow.png") });
});

test("shows current Codex quota, reset-credit count, and no Host consume or login actions", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".settings-account-table th")).toHaveText(["账号", "剩余额度"]);
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

test("imports from a row chip or the Pi section without adding a table column", async ({
  page,
}) => {
  await setup(page, { scenario: "external" });
  await page.setViewportSize({ width: 700, height: 900 });
  const chip = page.locator(`${nativeRow} .settings-account-pi-import`);
  await expect(chip).toHaveText("导入到 Pi");
  // The chip shares the identity's extras line with the reset cards instead of a third column.
  await expect(
    page.locator(`${nativeRow} .settings-account-row__extras .settings-account-reset-summary`),
  ).toHaveCount(1);
  await expect(page.locator(".settings-account-table th")).toHaveText(["账号", "剩余额度"]);
  const pi = page.getByRole("region", { name: "Pi 中的账号" });
  await expect(pi.locator(".settings-pi-accounts__hint")).toBeVisible();
  // Logins Pi already had sit behind a disclosure that starts collapsed.
  const group = pi.locator(".settings-pi-accounts__others");
  const toggle = pi.getByRole("button", { name: /Pi 自有配置/ });
  await expect(group).toBeHidden();
  await toggle.click();
  await expect(group.locator(".settings-pi-accounts__row--other")).toHaveCount(3);
  await expect(group.getByRole("button")).toHaveCount(0);

  await chip.click();
  const dialog = page.getByRole("dialog", { name: "导入到 Pi", exact: true });
  await expect(dialog).toContainText("保留全部已有 Provider 配置");
  await expect(dialog.getByLabel("模型入口名称")).toHaveValue("codex");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  const done = page.getByRole("dialog", { name: "已复制到 Pi", exact: true });
  await expect(done).toContainText("复制不代表已验证模型调用");
  await done.getByRole("button", { name: "完成", exact: true }).click();
  await expect(chip).toHaveAttribute("data-state", "imported");
  await expect(chip).toContainText("codex/…");
  await expect(pi).toContainText("zhaobin_jiang@163.com");

  // The section's own entry lets the user choose among compatible logins.
  await pi.getByRole("button", { name: "导入账号", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "导入到 Pi", exact: true });
  await expect(picker.getByRole("radio")).toHaveCount(2);
  await expect(picker.getByRole("radio", { name: /grok@example.com/ })).toBeChecked();
  await expect(picker.getByLabel("模型入口名称")).toHaveValue("grok");
  await expect(picker).toContainText("已导入为 codex/…");
  await picker.getByRole("button", { name: "确认导入", exact: true }).click();
  await page
    .getByRole("dialog", { name: "已复制到 Pi", exact: true })
    .getByRole("button", { name: "完成", exact: true })
    .click();
  await expect(page.locator('[data-harness-id="grok"] .settings-account-pi-import')).toContainText(
    "grok/…",
  );

  await pi.getByRole("button", { name: /重新导入凭证: zhaobin/ }).click();
  const reimport = page.getByRole("dialog", { name: "重新导入凭证", exact: true });
  await expect(reimport).toContainText("使用同一来源账号更新 codex/…");
  await reimport.getByRole("button", { name: "取消", exact: true }).click();

  await pi.getByRole("button", { name: /从 Pi 移除: zhaobin/ }).click();
  const removal = page.getByRole("dialog", { name: "从 Pi 移除", exact: true });
  await removal.getByRole("button", { name: "从 Pi 移除", exact: true }).click();
  await expect(page.locator(".settings-credential-dialog[open]")).toHaveCount(0);
  await expect(chip).not.toHaveAttribute("data-state", /.+/);
  await expect(chip).toHaveText("导入到 Pi");

  // Collapsing the section hides its list but keeps the header and import entry.
  await pi.getByRole("button", { name: /Pi 中的账号/ }).click();
  await expect(pi.locator(".settings-pi-accounts__card")).toBeHidden();
  await expect(pi.getByRole("button", { name: "导入账号", exact: true })).toBeVisible();
});

test("shows emails by default and masks their middle on demand across the page", async ({
  page,
}, testInfo) => {
  await setup(page, { scenario: "external" });
  const toolbar = page.locator(".settings-account-toolbar");
  const toggle = toolbar.getByRole("button", { name: "隐藏邮箱", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const nativeEmail = page.locator(`${nativeRow} .settings-account-email`);
  const grokEmail = page.locator('[data-harness-id="grok"] .settings-account-email');
  await expect(nativeEmail).toHaveText("zhaobin_jiang@163.com");
  // Import once so the Pi section also lists an email.
  await page.locator(`${nativeRow} .settings-account-pi-import`).click();
  await page
    .getByRole("dialog", { name: "导入到 Pi", exact: true })
    .getByRole("button", { name: "确认导入", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "已复制到 Pi", exact: true })
    .getByRole("button", { name: "完成", exact: true })
    .click();
  const pi = page.getByRole("region", { name: "Pi 中的账号" });

  await toggle.click();
  const reveal = toolbar.getByRole("button", { name: "显示邮箱", exact: true });
  await expect(reveal).toHaveAttribute("aria-pressed", "true");
  await expect(nativeEmail).toHaveText("zh****ng@163.com");
  await expect(nativeEmail).toHaveAttribute("title", "zh****ng@163.com");
  await expect(grokEmail).toHaveText("g****k@example.com");
  await expect(page.getByText("zhaobin_jiang", { exact: false })).toHaveCount(0);
  await expect(pi).toContainText("zh****ng@163.com");
  await page.screenshot({ path: testInfo.outputPath("accounts-emails-hidden.png") });
  // Masking is display-only: search still finds the account by its real email.
  await toolbar.getByRole("searchbox").fill("zhaobin");
  await expect(nativeEmail).toHaveText("zh****ng@163.com");
  await toolbar.getByRole("searchbox").fill("");

  await reveal.click();
  await expect(nativeEmail).toHaveText("zhaobin_jiang@163.com");
  await expect(pi).toContainText("zhaobin_jiang@163.com");
});

test("keeps quota columns aligned with the Pi chip in the identity and spans single limits", async ({
  page,
}, testInfo) => {
  await setup(page, { scenario: "layout", theme: "light" });
  const kimi = page.locator('.settings-account-table tr[data-harness-id="kimi-code"]');
  await expect(kimi).toHaveCount(1);
  await expect(kimi.getByRole("meter")).toHaveCount(2);
  await expect(kimi.locator(".settings-account-usage-cell")).toHaveCount(2);
  await expect(
    page.locator(
      '[data-harness-id="grok"] .settings-account-person-cell .settings-account-pi-import',
    ),
  ).toHaveCount(1);
  await expect(page.locator(".settings-account-table col")).toHaveCount(3);
  for (const header of await page.locator(".settings-account-table th").all()) {
    await expect(header).toHaveCSS("text-align", "center");
  }
  const single = page.locator('[data-harness-id="grok"] .settings-account-usage-cell');
  await expect(single).toHaveCount(1);
  await expect(single).toHaveAttribute("colspan", "2");
  const dual = page.locator('[data-harness-id="claude-code"] .settings-account-usage-cell');
  await expect(dual).toHaveCount(2);
  const left = await dual.nth(0).boundingBox();
  const right = await dual.nth(1).boundingBox();
  const wide = await single.boundingBox();
  if (!left || !right || !wide) throw new Error("Missing quota bounds");
  expect(left.y).toBe(right.y);
  expect(Math.abs(wide.width - left.width - right.width)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath("accounts-wide.png") });
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(single).toBeVisible();
  const narrow = await single.boundingBox();
  if (!narrow) throw new Error("Missing narrow quota bounds");
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(700);
  await page.screenshot({ path: testInfo.outputPath("accounts-narrow.png") });
  // Rendering the page only lists imports; nothing is copied without confirmation.
  expect(
    (await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls.imports)).every(
      (request: { action: string }) => request.action === "list",
    ),
  ).toBe(true);
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
