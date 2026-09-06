import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

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
          { accountId:"native",label:"Native",email:"zhaobin_jiang@163.com",codexHome:"/private/native",active:true,isDefault:true },
          { accountId:"team",label:"Team",email:"chongwen623@gmail.com",codexHome:"/private/team",active:false,isDefault:false },
          { accountId:"pending",label:"Pending login",codexHome:"/private/pending",active:false,isDefault:false },
        ];
        const snapshots = {
          native: { usedPercent:9,periodType:"seven_day",resetsAt:"2026-09-13T13:16:00Z",resetCredits:{availableCount:2,nextExpiresAt:"2026-10-04T01:54:00Z",expiresAt:["2026-10-04T01:54:00Z","2026-10-08T01:54:00Z"]} },
          team: { usedPercent:91,periodType:"five_hour",resetsAt:"2026-09-07T18:44:00Z",productUsage:[{product:"7-day window",usagePercent:0,resetsAt:"2026-09-13T13:44:00Z"},{product:"GPT-5.3-Codex-Spark weekly limit",usagePercent:25}],resetCredits:{availableCount:1} },
        };
        let failUsage = scenario === "error";
        let loginListener;
        let resolveLive;
        let resolveNative;
        let resolveTeam;
        let resolveReset;
        let resolveActivation;
        const activationCompletion = new Promise(resolve => { resolveActivation = resolve; });
        const teamUsage = new Promise(resolve => { resolveTeam = resolve; });
        const resetCompletion = new Promise(resolve => { resolveReset = resolve; });
        const live = new Promise(resolve => { resolveLive = resolve; });
        const native = new Promise(resolve => { resolveNative = resolve; });
        const calls = { inspect:[],deleted:[],reset:[],activate:[],login:[] };
        const client = {
          listCodexAccounts: async () => ({accounts:scenario === "late" ? accounts.slice(0,1) : accounts}),
          refreshCodexAccounts: async () => scenario === "late" ? live : ({accounts}),
          inspectCodexAccountUsage: async ({accountId}) => {
            calls.inspect.push(accountId);
            if ((scenario === "late" || scenario === "slow") && accountId === "native") return native;
            if (scenario === "slow-team" && accountId === "team") return teamUsage;
            if (accountId === "team" && failUsage) throw new Error("offline");
            return {accountId,usage:null,accountCredits:snapshots[accountId]};
          },
          activateCodexAccount: async ({accountId}) => {
            calls.activate.push(accountId);
            if (scenario.startsWith("slow-activation")) {
              await activationCompletion;
              if (scenario === "slow-activation-error") throw new Error("Activation failed");
            }
            accounts.forEach(account => account.active = account.accountId === accountId);
            return {account:accounts.find(account => account.accountId === accountId)};
          },
          deleteCodexAccount: async ({accountId}) => {
            calls.deleted.push(accountId);
            return {deletedAccountId:accountId};
          },
          consumeCodexAccountResetCredit: async input => {
            calls.reset.push(input);
            if (scenario === "slow-reset") await resetCompletion;
            return {accountId:input.accountId,outcome:"reset",accountCredits:{...snapshots[input.accountId],usedPercent:0,resetCredits:{availableCount:1}}};
          },
          createCodexAccount: async () => ({account:{accountId:"new",label:"New account",codexHome:"/private/new",active:false,isDefault:false}}),
          startCodexAccountLogin: async ({accountId}) => {
            calls.login.push(accountId);
            return {accountId,loginId:"login-new",verificationUrl:"https://example.com/device",userCode:"ABCD-EFGH"};
          },
          cancelCodexAccountLogin: async () => ({cancelled:true}),
          subscribeCodexAccountLogin: listener => { loginListener=listener; return () => { loginListener=undefined; }; },
        };
        globalThis.accountsFixture = {
          calls,
          recover: () => { failUsage=false; },
          deliverLive: () => resolveLive({accounts}),
          deliverNative: () => resolveNative({accountId:"native",usage:null,accountCredits:snapshots.native}),
          deliverTeam: () => resolveTeam({accountId:"team",usage:null,accountCredits:snapshots.team}),
          completeReset: () => resolveReset(),
          completeActivation: () => resolveActivation(),
        };
        const messages=rendererSettingsMessages(locale);
        const registry=createRendererSettingsPageRegistry([createAccountsSettingsPage(messages,()=>client)]);
        const shell=mountRendererSettingsShell(registry,document,messages);
        shell.openSettings(undefined,"accounts");
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
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => Reflect.get(globalThis, "setupAccounts")(options), options);
}
async function calls(page: Page, key: string) {
  return page.evaluate((key) => Reflect.get(globalThis, "accountsFixture").calls[key], key);
}
const nativeRow = '[data-account-id="native"]';
const teamRow = '[data-account-id="team"]';

test("uses four columns and only reported windows, with equal-width bars and no invented subscription data", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".settings-account-table th")).toHaveText([
    "账号",
    "额度",
    "重置卡",
    "操作",
  ]);
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveCount(1);
  await expect(page.locator(`${teamRow} [role="meter"]`)).toHaveCount(3);
  await expect(page.locator(`${nativeRow} .settings-account-usage__title`)).toHaveText("7 天");
  await expect(page.locator(`${nativeRow} .settings-account-usage__title`)).toHaveCSS(
    "width",
    "48px",
  );
  await expect(page.locator(`${nativeRow} .settings-account-active`)).toHaveText("默认");
  await expect(page.locator(`${nativeRow} .settings-account-row__mark svg`)).toHaveCount(1);
  await expect(page.locator(`${nativeRow} .settings-account-row__mark img`)).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCSS("border-top-width", "0px");
  await expect(
    page.locator(teamRow).getByRole("button", { name: "设为默认", exact: true }),
  ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".settings-account-count")).toContainText("已连接账号2");
  const loginHelp = page.getByRole("button", { name: "登录前须知", exact: true });
  await loginHelp.click();
  await expect(page.locator(".settings-account-device-code-note")).toBeVisible();
  await loginHelp.click();
  await expect(page.locator(".settings-account-device-code-note")).toBeHidden();
  await expect(page.locator(`${teamRow} .settings-account-usage__title`)).toHaveText([
    "5 小时",
    "7 天",
    "GPT-5.3-Codex-Spark weekly limit",
  ]);
  await expect(page.locator(".settings-account-table")).not.toContainText("未返回此窗口");
  await expect(page.locator(".settings-account-table")).not.toContainText("Pro 5x");
  await expect(page.locator(".settings-account-table")).not.toContainText("续期");
  await expect(page.locator('[data-account-id="pending"] [role="meter"]')).toHaveCount(0);
  const widths = await page
    .locator('[role="meter"]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  await page.getByRole("button", { name: "剩余", exact: true }).click();
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveAttribute("aria-valuenow", "91");
  await expect(page.locator(`${teamRow} [role="meter"]`).first()).toHaveAttribute(
    "aria-valuenow",
    "9",
  );
  await expect(page.locator(`${teamRow} [role="meter"]`).first()).toHaveClass(/--hot/);
  await expect(page.locator(`${nativeRow} .settings-account-active`)).toHaveCount(1);
  await expect(page.locator(`${nativeRow} .settings-account-actions`)).toBeEmpty();
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
  await page.getByRole("button", { name: "剩余", exact: true }).click();
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
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveAttribute("aria-valuenow", "100");
  await expect(page.locator(`${nativeRow} .settings-account-reset-summary`)).toContainText("1 张");
});

test("keeps native-home deletion protection separate from the active account and confirms deletion", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(`${nativeRow} .settings-account-delete`)).toHaveCount(0);
  await page.locator(teamRow).getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(page.locator(`${teamRow} .settings-account-active`)).toHaveCount(1);
  await expect(page.locator(`${nativeRow} .settings-account-delete`)).toHaveCount(0);
  const remove = page.getByRole("button", { name: "删除: chongwen623@gmail.com", exact: true });
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  expect(await calls(page, "deleted")).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(page.locator(teamRow)).toHaveCount(0);
  expect(await calls(page, "deleted")).toEqual(["team"]);
  await expect(page.locator(`${nativeRow} .settings-account-active`)).toHaveCount(1);
  await expect(page.getByRole("searchbox")).toBeFocused();
});

for (const input of ["mouse", "keyboard"] as const) {
  for (const outcome of ["success", "error"] as const) {
    test(`keeps focus on the account row during default activation (${input}/${outcome})`, async ({
      page,
    }) => {
      await setup(page, {
        scenario: outcome === "error" ? "slow-activation-error" : "slow-activation",
      });
      const row = page.locator(teamRow);
      const activate = row.getByRole("button", { name: "设为默认", exact: true });
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
        await expect(row.locator(".settings-account-active")).toHaveText("默认");
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

test("shows load failures with retry, and refreshes only signed-in accounts", async ({ page }) => {
  await setup(page, { scenario: "error" });
  await expect(page.locator(teamRow)).toContainText("额度读取失败");
  await expect(page.locator(`${teamRow} [role="meter"]`)).toHaveCount(0);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").recover());
  await page.locator(teamRow).getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(`${teamRow} [role="meter"]`)).toHaveCount(3);
  await page.getByRole("button", { name: "刷新额度", exact: true }).click();
  await expect
    .poll(() => calls(page, "inspect"))
    .toEqual(["native", "team", "team", "native", "team"]);
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
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(page.getByRole("searchbox")).toBeDisabled();
  await expect(page.locator(".settings-account-verification")).toContainText("ABCD-EFGH");
  await expect(page.locator(".settings-account-verification a")).toHaveAttribute(
    "href",
    "https://example.com/device",
  );
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(page.locator(".settings-account-verification")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加账号", exact: true })).toBeEnabled();
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
    page.locator(teamRow).getByRole("button", { name: "设为默认", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(`${teamRow} .settings-account-delete`)).toBeDisabled();
  await expect(page.getByRole("button", { name: "添加账号", exact: true })).toBeDisabled();
  await page.locator(`${teamRow} .settings-account-reset-summary`).click();
  await expect(page.getByRole("button", { name: "使用重置", exact: true })).toBeDisabled();
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").completeReset());
  await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveAttribute("aria-valuenow", "0");
  await expect(
    page.locator(teamRow).getByRole("button", { name: "设为默认", exact: true }),
  ).toBeEnabled();
});

for (const locale of ["zh-CN", "en"]) {
  for (const theme of ["light", "dark"]) {
    test(`fits the real settings shell in ${locale}/${theme} on desktop and mobile`, async ({
      page,
    }) => {
      await setup(page, { locale, theme });
      await expect(page.locator(`${nativeRow} [role="meter"]`)).toHaveCount(1);
      await page.screenshot({
        path: test.info().outputPath(`accounts-${locale}-${theme}-desktop.png`),
      });
      for (const width of [1440, 900, 720, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const list = page.locator(".settings-account-list");
        expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        for (const selector of [".settings-account-reset-summary", ".settings-account-delete"]) {
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
      const summary = page.locator(`${nativeRow} .settings-account-reset-summary`);
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(summary).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Enter");
      await expect(summary).toHaveAttribute("aria-expanded", "false");
    });
  }
}
