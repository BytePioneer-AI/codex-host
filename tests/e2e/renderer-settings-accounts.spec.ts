import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

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
          { accountId:"team",label:"Team",email:"chongwen623@gmail.com",planType:"team" },
          { accountId:"pending",label:"Pending login" },
        ];
        let currentAccountId = "native";
        let revision = 1;
        const accountSnapshot = (selected = accounts) => ({
          version:2,currentAccountId,phase:"ready",revision,instanceId:"settings-host",
          capabilities: scenario === "legacy"
            ? {manage:false,switch:false,login:false,delete:false,logout:false,recover:false,reason:"migration-required"}
            : {manage:true,switch:true,login:true,delete:true,logout:true,recover:true},
          accounts:scenario === "legacy" ? selected.slice(0,1) : selected,
        });
        const snapshots = {
          native: { usedPercent:9,periodType:"seven_day",resetsAt:"2026-09-13T13:16:00Z",resetCredits:{availableCount:2,nextExpiresAt:"2026-10-04T01:54:00Z",expiresAt:["2026-10-04T01:54:00Z","2026-10-08T01:54:00Z"]} },
          team: { usedPercent:91,periodType:"five_hour",resetsAt:"2026-09-10T08:34:00Z",productUsage:[{product:"7-day window",usagePercent:0,resetsAt:"2026-09-13T13:44:00Z"},{product:"GPT-5.3-Codex-Spark weekly limit",usagePercent:25}],resetCredits:{availableCount:1} },
        };
        let harnessAccounts = [
          {harnessId:"grok",harnessName:"Grok Build",email:"grok@example.com",credits:{usedPercent:0,periodType:"weekly",resetsAt:"2026-09-17T03:32:00Z"}},
          {harnessId:"antigravity",harnessName:"Antigravity",credits:{label:"Gemini Models · Weekly window",usedPercent:10,periodType:"weekly"}},
          {harnessId:"claude-code",harnessName:"Claude Code",email:"claude@example.com",plan:"max",credits:{usedPercent:0,periodType:"five_hour",productUsage:[{product:"7-day window",usagePercent:50}]}},
        ];
        let failUsage = scenario === "error";
        let loginListener;
        let accountListener;
        let resolveLive;
        let resolveNative;
        let resolveTeam;
        let resolveReset;
        let resolveActivation;
        let resolveLoginStart;
        const activationCompletion = new Promise(resolve => { resolveActivation = resolve; });
        const loginStart = new Promise(resolve => { resolveLoginStart = resolve; });
        const teamUsage = new Promise(resolve => { resolveTeam = resolve; });
        const resetCompletion = new Promise(resolve => { resolveReset = resolve; });
        const live = new Promise(resolve => { resolveLive = resolve; });
        const native = new Promise(resolve => { resolveNative = resolve; });
        const calls = { inspect:[],deleted:[],reset:[],activate:[],login:[],recover:[] };
        const client = {
          ...(scenario === "external" ? {listHarnessAccounts: async () => ({accounts:harnessAccounts})} : {}),
          listCodexAccounts: async () => accountSnapshot(scenario === "late" ? accounts.slice(0,1) : accounts),
          refreshCodexAccounts: async () => scenario === "late" ? live : accountSnapshot(),
          inspectCodexAccountUsage: async ({accountId}) => {
            calls.inspect.push(accountId);
            if ((scenario === "late" || scenario === "slow") && accountId === "native") return native;
            if (scenario === "slow-team" && accountId === "team") return teamUsage;
            if (accountId === "team" && failUsage) throw new Error("offline");
            return {accountId,usage:null,accountCredits:snapshots[accountId],freshness:"cached",observedAt:"2026-09-10T08:20:00.000Z"};
          },
          switchCodexAccount: async ({accountId}) => {
            calls.activate.push(accountId);
            if (scenario.startsWith("slow-activation")) {
              await activationCompletion;
              if (scenario === "slow-activation-error") throw new Error("Activation failed");
            }
            currentAccountId = accountId;
            revision += 1;
            return {currentAccountId:accountId,phase:"ready",revision};
          },
          deleteCodexAccount: async ({accountId}) => {
            calls.deleted.push(accountId);
            const index=accounts.findIndex(account=>account.accountId===accountId);
            if(index>=0) accounts.splice(index,1);
            return {deletedAccountId:accountId};
          },
          logoutCodexAccount: async () => { currentAccountId=null; revision+=1; return {currentAccountId:null,phase:"ready",revision}; },
          recoverCodexAccounts: async () => { calls.recover.push("recover"); revision+=1; return accountSnapshot(); },
          consumeCodexAccountResetCredit: async input => {
            calls.reset.push(input);
            if (scenario === "slow-reset") await resetCompletion;
            return {accountId:input.accountId,outcome:"reset",accountCredits:{...snapshots[input.accountId],usedPercent:0,resetCredits:{availableCount:1}}};
          },
          startCodexAccountLogin: async ({accountId}={}) => {
            accountId = accountId ?? "new";
            calls.login.push(accountId);
            if (scenario === "early-login") return loginStart;
            return {accountId,loginId:"login-new",verificationUrl:"https://example.com/device",userCode:"ABCD-EFGH"};
          },
          cancelCodexAccountLogin: async () => ({cancelled:true}),
          subscribeCodexAccountLogin: listener => { loginListener=listener; return () => { loginListener=undefined; }; },
          subscribeCodexAccounts: listener => { accountListener=listener; return () => { accountListener=undefined; }; },
        };
        globalThis.accountsFixture = {
          calls,
          recover: () => { failUsage=false; },
          requireAccountRecovery: () => accountListener?.({
            ...accountSnapshot(),phase:"unavailable",cleanupRequired:true,
            pendingOperation:{operationId:"recover-1",kind:"recovery"},
            capabilities:{...accountSnapshot().capabilities,reason:"recovery-required"},
          }),
          clearHarnessAccounts: () => { harnessAccounts=[]; },
          deliverLive: () => resolveLive(accountSnapshot()),
          deliverNative: () => resolveNative({accountId:"native",usage:null,accountCredits:snapshots.native,freshness:"live",observedAt:"2026-09-10T08:20:00.000Z"}),
          deliverTeam: () => resolveTeam({accountId:"team",usage:null,accountCredits:snapshots.team,freshness:"live",observedAt:"2026-09-10T08:20:00.000Z"}),
          completeReset: () => resolveReset(),
          completeActivation: () => resolveActivation(),
          completeEarlyLogin: () => {
            loginListener?.({accountId:"deduplicated",loginId:"login-new",success:true,saved:true,error:null});
            resolveLoginStart({accountId:"new",loginId:"login-new",verificationUrl:"https://example.com/device",userCode:"SHOULD-NOT-SHOW"});
          },
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
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Account settings fixture bundle missing");

async function setup(page: Page, options = {}) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Use a trustworthy origin like Desktop so native crypto.randomUUID is
  // available for reset idempotency keys; about:blank is not a secure context.
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
async function calls(page: Page, key: string) {
  return page.evaluate((key) => Reflect.get(globalThis, "accountsFixture").calls[key], key);
}
const nativeRow = '[data-account-id="native"]';
const teamRow = '[data-account-id="team"]';

test("explains native legacy compatibility without enabling managed account actions", async ({
  page,
}) => {
  await setup(page, { locale: "en", scenario: "legacy" });
  await expect(page.locator(".settings-account-status")).toContainText(
    "Native compatibility mode: Codex uses the existing official home.",
  );
  await expect(page.locator(".settings-account-status")).toContainText(
    "Other account homes and their history have not been merged",
  );
  await expect(page.getByRole("button", { name: "Add Codex account", exact: true })).toBeDisabled();
  expect(await calls(page, "login")).toEqual([]);
  expect(await calls(page, "activate")).toEqual([]);
});

async function openAccountActions(page: Page, row = teamRow) {
  await page.locator(`${row} [data-account-focus$=":more"]`).click();
  return page.locator(`${row} .settings-account-dialog[open]`);
}

test("shows detected Harness quota read-only and removes rows when authentication has no data", async ({
  page,
}) => {
  await setup(page, { scenario: "external" });
  const section = page.locator(".settings-account-table");
  const nativeAccounts = section.locator("tr[data-harness-id]");
  await expect(page.locator(".settings-harness-accounts")).toHaveCount(0);
  await expect(page.locator(".settings-account-table")).toHaveCount(1);
  await expect(nativeAccounts).toHaveCount(3);
  await expect(section.locator(".settings-account-row")).toHaveCount(6);
  await expect(page.locator(".settings-account-count")).toHaveText("账号6");
  await expect(section.locator(".settings-harness-account__logo img")).toHaveCount(2);
  await expect(
    section.locator('[data-harness-id="claude-code"] .settings-harness-account__logo svg'),
  ).toHaveCount(1);
  await expect(section).not.toContainText("请在原生 Agent 中管理登录");
  await expect(
    nativeAccounts.getByRole("button", { name: /切换|删除|使用重置|登录$/ }),
  ).toHaveCount(0);
  await expect(
    section.locator('[data-harness-id="antigravity"] .settings-account-metadata'),
  ).toHaveCount(0);
  const info = section.getByRole("button", { name: "Grok Build · 原生管理", exact: true });
  await info.click();
  const nativeInfo = section.locator('[data-harness-id="grok"] dialog[open]');
  await expect(nativeInfo).toContainText("登录、退出和切换请在其原生客户端中完成");
  await page.keyboard.press("Escape");
  await expect(nativeInfo).toHaveCount(0);
  await expect(info).toBeFocused();
  await expect(section).not.toContainText("当前登录账号");
  await expect(section).not.toContainText("更新于");
  const longEmail = "very.long.account.name.with.many.characters@example.com";
  const emailTitle = section.locator('[data-harness-id="grok"] strong');
  await emailTitle.evaluate((element, text) => {
    element.textContent = text;
  }, longEmail);
  await expect(emailTitle).toHaveCSS("text-overflow", "ellipsis");
  expect(await emailTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
    true,
  );
  await emailTitle.evaluate((element) => {
    element.textContent = "grok@example.com";
  });
  await expect(emailTitle).toHaveAttribute("title", "grok@example.com");
  await expect(section.locator('[data-harness-id="claude-code"] strong')).toHaveText(
    "claude@example.com",
  );
  await expect(section.locator('[data-harness-id="grok"] strong')).toHaveText("grok@example.com");
  await expect(section.locator('[data-harness-id="antigravity"] strong')).toHaveText("Antigravity");
  await expect(
    section.locator('[data-harness-id="claude-code"] .settings-account-metadata').first(),
  ).toContainText("Claude Code·max");
  await expect(section).toContainText("Gemini Models · Weekly window");
  await expect(section.locator('[data-harness-id="grok"] [role="meter"]')).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  await page.getByRole("button", { name: "已用", exact: true }).click();
  await expect(section.locator('[data-harness-id="grok"] [role="meter"]')).toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  await page.getByRole("searchbox").fill("claude@example.com");
  await expect(section.locator(".settings-account-row")).toHaveCount(1);
  await expect(page.locator(".settings-account-empty")).toHaveCount(0);
  await expect(page.locator(".settings-account-count")).toHaveText("账号6");
  await expect(section).toContainText("Claude Code");
  await page.getByRole("searchbox").fill("");
  await page.setViewportSize({ width: 500, height: 850 });
  await expect(nativeAccounts).toHaveCount(3);
  expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").clearHarnessAccounts());
  await page.getByRole("button", { name: "刷新额度", exact: true }).click();
  await expect(nativeAccounts).toHaveCount(0);
  await expect(page.locator(".settings-account-count")).toHaveText("账号3");
  expect(await calls(page, "activate")).toEqual([]);
  expect(await calls(page, "deleted")).toEqual([]);
});

test("uses four columns and only reported windows, with equal-width bars and no invented subscription data", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".settings-account-table th")).toHaveText([
    "账号",
    "5 小时剩余",
    "7 天剩余",
    "管理",
  ]);
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveCount(1);
  await expect(page.locator(`${teamRow} [role="meter"]`)).toHaveCount(3);
  await expect(page.locator(`${nativeRow} .settings-account-usage__missing`)).toContainText("—");
  await expect(page.locator(`${nativeRow} .settings-account-usage__missing`)).not.toContainText(
    "未提供此窗口",
  );
  await expect(
    page.locator(`${nativeRow} .settings-account-usage-cell`).nth(0).getByRole("meter"),
  ).toHaveCount(0);
  await expect(
    page.locator(`${nativeRow} .settings-account-usage-cell`).nth(1).getByRole("meter"),
  ).toHaveAttribute("aria-valuenow", "91");
  await expect(page.locator(`${nativeRow} .settings-account-active`)).toHaveText("当前");
  await expect(page.locator(`${nativeRow} .settings-account-email`)).toHaveText(
    "zhaobin_jiang@163.com",
  );
  await expect(page.locator(`${nativeRow} .settings-account-metadata`)).toContainText("Codex");
  await expect(page.locator(`${nativeRow} .settings-account-plan`)).toHaveText("Pro 20x");
  await expect(page.locator(`${nativeRow} .settings-account-plan`)).toHaveClass(
    /settings-account-plan--highlighted/,
  );
  await expect(page.locator(`${teamRow} .settings-account-plan`)).toHaveText("Team");
  await expect(page.locator(`${nativeRow} .settings-account-row__mark svg`)).toHaveCount(1);
  await expect(page.locator(`${nativeRow} .settings-account-row__mark img`)).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCSS("border-top-width", "0px");
  await expect(page.locator(teamRow).getByRole("button", { name: "切换", exact: true })).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".settings-account-count")).toHaveText("账号3");
  await expect(
    page.getByText(
      "默认设置仅影响新的 Codex 任务，已有任务保持原账号；其他 Agent 的登录与切换由其原生客户端管理。",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "登录前须知", exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      "登录前，请先在 Web 端的“设置 → 账号安全与登录”中开启“为 Codex 启用设备代码授权”。",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(page.locator(".settings-account-device-code-note")).toHaveCount(0);
  await expect(
    page.locator(`${teamRow} .settings-account-usage-cell .settings-account-usage__title`),
  ).toHaveText(["5 小时", "7 天"]);
  await expect(page.locator(`${teamRow} .settings-account-extra-usage`)).toContainText(
    "GPT-5.3-Codex-Spark weekly limit",
  );
  await expect(page.locator(".settings-account-table")).not.toContainText("未返回此窗口");
  await expect(page.locator(".settings-account-table")).not.toContainText("Pro 5x");
  await expect(page.locator(".settings-account-table")).not.toContainText("续期");
  await expect(page.locator('[data-account-id="pending"] [role="meter"]')).toHaveCount(0);
  const widths = await page
    .locator('.settings-account-usage-cell [role="meter"]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  await expect(page.getByRole("button", { name: "剩余", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveAttribute("aria-valuenow", "91");
  await expect(
    page.locator(`${teamRow} .settings-account-usage-cell [role="meter"]`).first(),
  ).toHaveAttribute("aria-valuenow", "9");
  await expect(
    page.locator(`${teamRow} .settings-account-usage-cell [role="meter"]`).first(),
  ).toHaveClass(/--hot/);
  await expect(page.locator(`${nativeRow} .settings-account-active`)).toHaveCount(1);
  await expect(
    page.locator(nativeRow).getByRole("button", { name: "切换", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(`${nativeRow} .settings-account-reset-summary`)).toContainText(
    "重置卡",
  );
  await page.getByRole("searchbox").fill("gmail");
  await expect(page.locator(".settings-account-row")).toHaveCount(1);
  await page.getByRole("searchbox").fill("no-match");
  await expect(page.locator(".settings-account-empty")).toHaveText("没有匹配的账号。");
});

test("expands reset details in-place, confirms consumption and preserves expanded state across rendering", async ({
  page,
}) => {
  await setup(page);
  const summary = page.locator(`${nativeRow} .settings-account-reset-summary`);
  await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  const details = page.locator(".settings-account-details-row:not([hidden])");
  await expect(details.locator("li")).toHaveCount(2);
  await page.getByRole("button", { name: "已用", exact: true }).click();
  await expect(page.locator(`${nativeRow} .settings-account-reset-summary`)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await details.getByRole("button", { name: "使用重置", exact: true }).click();
  expect(await calls(page, "reset")).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await details.getByRole("button", { name: "使用重置", exact: true }).click();
  await expect.poll(() => calls(page, "reset")).toHaveLength(1);
  expect((await calls(page, "reset"))[0]).toMatchObject({
    accountId: "native",
    idempotencyKey: expect.any(String),
  });
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveAttribute("aria-valuenow", "0");
  await expect(page.locator(`${nativeRow} .settings-account-reset-summary`)).toContainText("1 张");
});

test("protects only the current Account from deletion and confirms deleting a non-current Account", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(`${nativeRow} .settings-account-delete`)).toHaveCount(0);
  await page.locator(teamRow).getByRole("button", { name: "切换", exact: true }).click();
  await expect(page.locator(`${teamRow} .settings-account-active`)).toHaveCount(1);
  await expect(page.locator(`${teamRow} .settings-account-delete`)).toHaveCount(0);
  const remove = page.getByRole("button", { name: "删除: zhaobin_jiang@163.com", exact: true });
  await openAccountActions(page, nativeRow);
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  expect(await calls(page, "deleted")).toHaveLength(0);
  await openAccountActions(page, nativeRow);
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(page.locator(nativeRow)).toHaveCount(0);
  expect(await calls(page, "deleted")).toEqual(["native"]);
  await expect(page.locator(`${teamRow} .settings-account-active`)).toHaveCount(1);
  await expect(page.getByRole("searchbox")).toBeFocused();
});

for (const input of ["mouse", "keyboard"] as const) {
  for (const outcome of ["success", "error"] as const) {
    test(`keeps focus on the account row during global switching (${input}/${outcome})`, async ({
      page,
    }) => {
      await setup(page, {
        scenario: outcome === "error" ? "slow-activation-error" : "slow-activation",
      });
      const row = page.locator(teamRow);
      const activate = row.getByRole("button", { name: "切换", exact: true });
      if (input === "mouse") await activate.click();
      else {
        await activate.focus();
        await page.keyboard.press("Enter");
      }
      await expect(activate).toBeDisabled();
      await expect(page.getByRole("searchbox")).not.toBeFocused({ timeout: 800 });
      await expect(row).toBeFocused();
      await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").completeActivation());
      if (outcome === "success") {
        await expect(row.locator(".settings-account-active")).toHaveText("当前");
        await expect(activate).toHaveCount(0);
      } else {
        await expect(activate).toBeEnabled();
        await expect(page.locator(".settings-account-status")).toHaveText("Activation failed");
      }
      await expect(row).toBeFocused();
      await expect(page.getByRole("searchbox")).not.toBeFocused();
      // The row is programmatically focusable, not an extra permanent tab stop.
      await expect(row).toHaveAttribute("tabindex", "-1");
    });
  }
}

test("shows load failures with retry, and refreshes every saved Account", async ({ page }) => {
  await setup(page, { scenario: "error" });
  await expect(page.locator(teamRow)).toContainText("额度读取失败");
  await expect(page.locator(`${teamRow} [role="meter"]`)).toHaveCount(0);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").recover());
  await page.locator(teamRow).getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(`${teamRow} [role="meter"]`)).toHaveCount(3);
  await page.getByRole("button", { name: "刷新额度", exact: true }).click();
  await expect
    .poll(() => calls(page, "inspect"))
    .toEqual(["native", "team", "pending", "team", "native", "team", "pending"]);
  await expect(page.getByRole("button", { name: "刷新额度", exact: true })).toBeEnabled();
});

test("does not strand an earlier usage request when metadata adds another signed-in account", async ({
  page,
}) => {
  await setup(page, { scenario: "late" });
  await expect(page.locator(nativeRow)).toContainText("正在读取额度");
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").deliverLive());
  await expect(page.locator(`${teamRow} [role="meter"]`)).toHaveCount(3);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").deliverNative());
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "刷新额度", exact: true })).toBeEnabled();
});

test("keeps add, native device login and cancellation available", async ({ page }) => {
  await setup(page);
  await page.getByRole("searchbox").fill("gmail");
  await page.getByRole("button", { name: "添加 Codex 账号", exact: true }).click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(page.getByRole("searchbox")).toBeDisabled();
  await expect(page.locator(".settings-account-verification")).toContainText("ABCD-EFGH");
  await expect(page.locator(".settings-account-verification a")).toHaveAttribute(
    "href",
    "https://example.com/device",
  );
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(page.locator(".settings-account-verification")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加 Codex 账号", exact: true })).toBeEnabled();
});

test("reconciles login completion delivered before the start response", async ({ page }) => {
  await setup(page, { scenario: "early-login" });
  await page.getByRole("button", { name: "添加 Codex 账号", exact: true }).click();
  await expect.poll(() => calls(page, "login")).toEqual(["new"]);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").completeEarlyLogin());
  await expect(page.locator(".settings-account-status")).toHaveText("登录成功。");
  await expect(page.locator(".settings-account-verification")).toHaveCount(0);
  await expect(page.getByText("SHOULD-NOT-SHOW", { exact: true })).toHaveCount(0);
});

test("surfaces saved cleanup work and provides a usable recovery action", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").requireAccountRecovery());
  await expect(page.locator(".settings-account-status")).toContainText("账号变更已保存");
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect.poll(() => calls(page, "recover")).toEqual(["recover"]);
  await expect(page.locator(".settings-account-status")).not.toContainText("账号变更已保存");
});

test("renders completed accounts without waiting for a slower window request", async ({ page }) => {
  await setup(page, { scenario: "slow" });
  await expect(page.locator(`${teamRow} [role="meter"]`)).toHaveCount(3);
  await expect(page.locator(nativeRow)).toContainText("正在读取额度");
  await page.locator(`${teamRow} .settings-account-reset-summary`).focus();
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").deliverNative());
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveCount(1);
  await expect(page.locator(`${teamRow} .settings-account-reset-summary`)).toBeFocused();
});

test("ignores late usage for a deleted account and unlocks refresh", async ({ page }) => {
  await setup(page, { scenario: "slow-team" });
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveCount(1);
  await expect(page.locator(teamRow)).toContainText("正在读取额度");
  await openAccountActions(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(`${teamRow} .settings-account-delete`).click();
  await expect(page.locator(teamRow)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "刷新额度", exact: true })).toBeEnabled();
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").deliverTeam());
  await expect(page.locator(teamRow)).toHaveCount(0);
  await expect(page.locator('[role="meter"]')).toHaveCount(1);
});

test("does not let another mutation supersede an in-flight reset", async ({ page }) => {
  await setup(page, { scenario: "slow-reset" });
  await page.locator(`${nativeRow} .settings-account-reset-summary`).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "使用重置", exact: true }).click();
  await expect.poll(() => calls(page, "reset")).toHaveLength(1);
  await expect(
    page.locator(teamRow).getByRole("button", { name: "切换", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(`${teamRow} .settings-account-delete`)).toBeDisabled();
  await expect(page.getByRole("button", { name: "添加 Codex 账号", exact: true })).toBeDisabled();
  await page.locator(`${teamRow} .settings-account-reset-summary`).click();
  await expect(page.getByRole("button", { name: "使用重置", exact: true })).toHaveCount(0);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").completeReset());
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveAttribute("aria-valuenow", "100");
  await expect(
    page.locator(teamRow).getByRole("button", { name: "切换", exact: true }),
  ).toBeEnabled();
});

test("updates compact countdowns without requests, replacing rows, or inventing a reset", async ({
  page,
}) => {
  await setup(page);
  const countdown = page
    .locator(`${teamRow} .settings-account-usage-cell [data-resets-at]`)
    .first();
  const timestamp = page.locator(`${nativeRow} time`).first();
  await expect(countdown).toHaveText("14m");
  await expect(page.locator(`${nativeRow} [data-resets-at]`).first()).toHaveText("3d4h");
  await expect(timestamp).toHaveText("09/13 21:16");
  await expect(timestamp).toHaveAttribute("datetime", "2026-09-13T13:16:00.000Z");
  await expect(timestamp).toHaveAttribute("title", /额度重置时间：.*2026.*GMT\+8/);
  await expect(countdown).toHaveAttribute("aria-label", "距重置还有 14分钟");
  const originalNode = await countdown.elementHandle();
  const inspect = await calls(page, "inspect");
  const summary = page.locator(`${teamRow} .settings-account-reset-summary`);
  await summary.focus();
  await page.keyboard.press("Enter");
  await page.clock.runFor(60_000);
  await expect(countdown).toHaveText("13m");
  expect(await originalNode?.evaluate((node) => node.isConnected)).toBe(true);
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await page.clock.runFor(13 * 60_000);
  await expect(countdown).toHaveText("待刷新");
  await expect(
    page.locator(`${teamRow} .settings-account-usage-cell [role="meter"]`).first(),
  ).toHaveAttribute("aria-valuenow", "9");
  expect(await calls(page, "inspect")).toEqual(inspect);
});

test("stops the local countdown clock when settings are disposed", async ({ page }) => {
  await setup(page);
  const countdown = await page.locator(`${teamRow} [data-resets-at]`).first().elementHandle();
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").dispose());
  await page.clock.runFor(60_000);
  expect(await countdown?.evaluate((node) => node.textContent)).toBe("14m");
});

test("keeps row order stable across global switches, display mode and refresh, and searches Agent or plan", async ({
  page,
}) => {
  await setup(page, { scenario: "external" });
  const rows = page.locator(".settings-account-row");
  const order = () =>
    rows.evaluateAll((nodes) =>
      nodes.map(
        (node) => node.getAttribute("data-account-id") ?? node.getAttribute("data-harness-id"),
      ),
    );
  await expect(rows).toHaveCount(6);
  const initial = await order();
  expect(initial).toEqual(["native", "team", "pending", "antigravity", "claude-code", "grok"]);
  await page.locator(teamRow).getByRole("button", { name: "切换", exact: true }).click();
  await page.getByRole("button", { name: "已用", exact: true }).click();
  await expect(page.locator(".settings-account-table th")).toHaveText([
    "账号",
    "5 小时已用",
    "7 天已用",
    "管理",
  ]);
  await page.getByRole("button", { name: "刷新额度", exact: true }).click();
  expect(await order()).toEqual(initial);
  await page.getByRole("searchbox").fill("Codex");
  await expect(rows).toHaveCount(3);
  await page.getByRole("searchbox").fill("max");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute("data-harness-id", "claude-code");
  await page.getByRole("searchbox").fill("Pro 20x");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute("data-account-id", "native");
  await page.getByRole("searchbox").fill("no-such-account");
  await expect(page.locator(".settings-account-empty")).toHaveCount(1);
  await expect(page.locator(".settings-account-count")).toHaveText("账号6");
});

test("supports keyboard account details and per-account refresh without exposing protected deletion", async ({
  page,
}) => {
  await setup(page);
  const trigger = page.locator(`${nativeRow} [data-account-focus$=":more"]`);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator(`${nativeRow} dialog[open]`);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "登录", exact: true })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /删除/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "刷新额度", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => calls(page, "inspect")).toEqual(["native", "team", "pending", "native"]);
  await expect(trigger).toBeFocused();
});

test("keeps account details and keyboard focus through another account's async quota update", async ({
  page,
}) => {
  await setup(page, { scenario: "slow" });
  const dialog = await openAccountActions(page);
  const refresh = dialog.getByRole("button", { name: "刷新额度", exact: true });
  await refresh.focus();
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").deliverNative());
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`${teamRow} [data-account-focus$=":more"]`)).toBeFocused();
});

for (const locale of ["zh-CN", "en"]) {
  for (const theme of ["light", "dark"]) {
    test(`fits the real settings shell in ${locale}/${theme} on desktop and mobile`, async ({
      page,
    }) => {
      await setup(page, { locale, theme, scenario: "external" });
      await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveCount(1);
      await page.screenshot({
        path: test.info().outputPath(`accounts-${locale}-${theme}-desktop.png`),
      });
      await page.locator('[data-harness-id="grok"]').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath(`accounts-${locale}-${theme}-native.png`),
      });
      for (const width of [1440, 900, 720, 500, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const list = page.locator(".settings-account-list:has(.settings-account-table)");
        expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(
          await list
            .locator(".settings-account-usage__meter")
            .evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth)),
        ).toBe(true);
        for (const selector of [
          ".settings-account-reset-summary",
          '[data-account-focus$=":more"]',
        ]) {
          const control = page.locator(`${teamRow} ${selector}`);
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeVisible();
          const [controlBox, listBox] = await Promise.all([
            control.boundingBox(),
            list.boundingBox(),
          ]);
          if (!controlBox || !listBox) throw new Error("Missing layout");
          expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(
            listBox.x + listBox.width + 1,
          );
        }
      }
      await page.screenshot({
        path: test.info().outputPath(`accounts-${locale}-${theme}-mobile.png`),
      });
      const summary = page.locator(`${nativeRow} .settings-account-reset-summary`);
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(summary).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Enter");
      await expect(summary).toHaveAttribute("aria-expanded", "false");
    });
  }
}
