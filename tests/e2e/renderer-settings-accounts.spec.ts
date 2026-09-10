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

      globalThis.setupAccounts = (delayInitialUsage = false) => {
        const accounts = [
          { accountId:"native", label:"Personal", email:"personal@example.com", planType:"pro" },
          { accountId:"team", label:"Team", email:"team@example.com", planType:"team" },
        ];
        const calls = { inspect:[], switch:[], login:[], cancel:[], deleted:[] };
        let currentAccountId = "native";
        let revision = 1;
        let accountListener;
        let loginListener;
        let releaseInitialUsage;
        let shouldDelayInitialUsage = delayInitialUsage;
        let failRefreshAccountId;
        const snapshot = () => ({
          version:2, currentAccountId, phase:"ready", revision,
          capabilities:{manage:true,switch:true,login:true,delete:true}, accounts,
        });
        const publish = () => accountListener?.(snapshot());
        const client = {
          listCodexAccounts: async () => snapshot(),
          refreshCodexAccounts: async () => snapshot(),
          subscribeCodexAccounts: listener => { accountListener=listener; return () => { accountListener=undefined; }; },
          inspectCodexAccountUsage: async ({accountId,refresh}) => {
            calls.inspect.push(accountId);
            if (refresh && failRefreshAccountId === accountId) throw new Error("synthetic refresh failure");
            if (shouldDelayInitialUsage) {
              shouldDelayInitialUsage = false;
              await new Promise(resolve => { releaseInitialUsage = resolve; });
            }
            return {
              accountId,
              usage:null,
              freshness:"live",
              observedAt:"2026-09-10T03:00:00.000Z",
              accountCredits:{usedPercent:accountId === "native" ? 17 : 83,periodType:"weekly"},
            };
          },
          switchCodexAccount: async ({accountId}) => {
            calls.switch.push(accountId);
            currentAccountId=accountId; revision++; publish();
            return {currentAccountId,phase:"ready",revision};
          },
          deleteCodexAccount: async ({accountId}) => {
            calls.deleted.push(accountId);
            const index=accounts.findIndex(account=>account.accountId===accountId);
            if(index>=0) accounts.splice(index,1);
            revision++; publish();
            return {deletedAccountId:accountId};
          },
          startCodexAccountLogin: async (params) => {
            calls.login.push(params);
            return {accountId:"new-account",loginId:"login-1",verificationUrl:"https://example.com/device",userCode:"ABCD-EFGH"};
          },
          cancelCodexAccountLogin: async ({loginId}) => {
            calls.cancel.push(loginId);
            loginListener?.({accountId:"new-account",loginId,success:false,error:null});
            return {cancelled:true};
          },
          subscribeCodexAccountLogin: listener => { loginListener=listener; return () => { loginListener=undefined; }; },
          listHarnessAccounts: async () => ({accounts:[{
            harnessId:"claude-code",harnessName:"Claude Code",email:"claude@example.com",plan:"max",
            credits:{usedPercent:50,periodType:"weekly"},
          }]}),
        };
        globalThis.accountsFixture={
          calls,
          snapshot,
          releaseInitialUsage:()=>releaseInitialUsage?.(),
          failRefresh:(accountId)=>{failRefreshAccountId=accountId;},
        };
        const messages=rendererSettingsMessages("en-US");
        const registry=createRendererSettingsPageRegistry([createAccountsSettingsPage(messages,()=>client)]);
        const shell=mountRendererSettingsShell(registry,document,messages);
        shell.openSettings(undefined,"accounts");
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-accounts-global-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Account settings fixture bundle missing");
const bundleText: string = bundle;

async function setup(page: Page, delayInitialUsage = false): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: bundleText });
  await page.evaluate(
    (delay) => Reflect.get(globalThis, "setupAccounts")(delay),
    delayInitialUsage,
  );
  await expect(page.locator('[data-account-id="native"]')).toBeVisible();
}

async function calls(page: Page, key: string): Promise<unknown[]> {
  return page.evaluate((key) => Reflect.get(globalThis, "accountsFixture").calls[key], key);
}

test("switches the Host current Account while retaining quota for every Account", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => calls(page, "inspect")).toEqual(["native", "team"]);
  const team = page.locator('[data-account-id="team"]');
  await team.getByRole("button", { name: "Switch account", exact: true }).click();
  await expect.poll(() => calls(page, "switch")).toEqual(["team"]);
  await expect.poll(() => calls(page, "inspect")).toContain("team");
  await expect(team).toContainText("Current");
});

test("preserves an inactive Account's last-good quota when manual refresh fails", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => calls(page, "inspect")).toHaveLength(2);
  const team = page.locator('[data-account-id="team"]');
  await expect(team).toContainText("17%");
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").failRefresh("team"));
  await page.getByRole("button", { name: "Refresh limits", exact: true }).click();
  await expect.poll(() => calls(page, "inspect")).toHaveLength(4);
  await expect(team).toContainText("17%");
  await expect(team).not.toContainText("Could not load limits");
});

test("honors an immediate switch click after waiting for the page's own quota read", async ({
  page,
}) => {
  await setup(page, true);
  await expect.poll(() => calls(page, "inspect")).toEqual(["native", "team"]);
  await page
    .locator('[data-account-id="team"]')
    .getByRole("button", { name: "Switch account", exact: true })
    .click();
  await expect.poll(() => calls(page, "switch")).toEqual([]);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").releaseInitialUsage());
  await expect.poll(() => calls(page, "switch")).toEqual(["team"]);
  await expect(page.locator('[data-account-id="team"]')).toContainText("Current");
});

test("cancels device login without creating a duplicate connected Account", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Add Account", exact: true }).click();
  await expect.poll(() => calls(page, "login")).toEqual([{}]);
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-account-id]")).toHaveCount(2);
  expect(await calls(page, "cancel")).toEqual(["login-1"]);
});

test("keeps other Harness Account quota read-only while Codex switches", async ({ page }) => {
  await setup(page);
  const harness = page.locator('[data-harness-id="claude-code"]');
  await expect(harness).toContainText("claude@example.com");
  await expect(harness.getByRole("button")).toHaveCount(0);
  await page
    .locator('[data-account-id="team"]')
    .getByRole("button", { name: "Switch account", exact: true })
    .click();
  await expect(harness).toContainText("claude@example.com");
  await expect(harness.getByRole("button")).toHaveCount(0);
});

test("does not allow deleting the current Account", async ({ page }) => {
  await setup(page);
  await expect(page.getByRole("button", { name: "Delete: personal@example.com" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete: team@example.com" })).toHaveCount(1);
});
