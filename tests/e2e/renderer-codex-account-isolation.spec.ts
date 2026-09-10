import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";

      let hostId = globalThis.startRemote ? "remote" : "local";
      let routeReady = !globalThis.delayedHost;
      const calls = [];
      const pending = new Map();
      const paused = new Set();
      const current = { local: "default", remote: "default" };
      const revision = { local: 1, remote: 1 };
      const subscribers = { local: new Set(), remote: new Set() };
      let failNextSwitch = false;
      const accounts = (host) => ["default", "other"].map((accountId) => ({
        accountId, label: host + "-" + accountId,
        email: host + "-" + accountId + "@example.com",
      }));
      const accountList = (host) => ({
        version: 2, currentAccountId: current[host], phase: "ready", revision: revision[host],
        capabilities: { manage: true, switch: true, login: true, delete: true },
        accounts: accounts(host),
      });
      const unavailable = async () => { throw new Error("unsupported test control"); };
      const request = async (host, method, result) => {
        calls.push({ host, method });
        const key = host + ":" + method;
        if (paused.has(key)) await new Promise(resolve => {
          const waiters = pending.get(key) ?? [];
          waiters.push(resolve);
          pending.set(key, waiters);
        });
        return result();
      };
      const clients = Object.fromEntries(["local", "remote"].map(host => [host, {
        listCodexAccounts: () => request(host, "accounts", () => {
          if (host === "remote" && globalThis.remoteUnsupported) throw new Error("Method not found");
          return accountList(host);
        }),
        switchCodexAccount: ({accountId}) => request(host, "switch:" + accountId, () => {
          if (failNextSwitch) { failNextSwitch = false; throw new Error("synthetic rollback failure"); }
          current[host] = accountId;
          revision[host]++;
          const snapshot = accountList(host);
          for (const listener of subscribers[host]) listener(snapshot);
          return { currentAccountId: accountId, phase: "ready", revision: revision[host] };
        }),
        subscribeCodexAccounts: (listener) => {
          subscribers[host].add(listener);
          return () => subscribers[host].delete(listener);
        },
        inspectCodexAccountUsage: (input) => request(host, "usage:" + input.accountId, () => ({
          accountId: input.accountId, usage: null,
          freshness: "live", observedAt: "2026-09-10T03:00:00.000Z",
          accountCredits: { usedPercent: host === "local" ? 17 : 83, periodType: "weekly" },
        })),
        inspectHarness: createRendererModelClient([{
          sendRequest: (_method, params) => request(host, "harness:" + params.harnessId, () => {
            if (host === "remote" && globalThis.remoteHarnessUnsupported) {
              throw Object.assign(new Error("Method not found"), { code: -32601 });
            }
            return { status: "notInstalled", error: { code: "notInstalled", message: "not installed", retryable: false } };
          }),
        }]).inspectHarness,
        inspectThread: createRendererModelClient([{
          sendRequest: (method, params) => request(host, method === "codexhost/thread/inspect" ? "ownership" : method, () => {
            if (method === "thread/read") {
              return { thread: { id: params.threadId, modelProvider: "custom", cliVersion: "0.151.0" } };
            }
            if (host === "remote" && globalThis.remoteNative) {
              throw Object.assign(new Error("Invalid request: unknown variant \`codexhost/thread/inspect\`"), { code: -32600 });
            }
            if (globalThis.ownershipError) throw new Error("Method not found");
            return { owner: "codex", locked: true };
          }),
        }]).inspectThread,
        inspectThreadUsage: async ({ threadId }) => ({ threadId, usage: null }),
        inspectHarnessCommands: async () => ({ commands: [] }),
        inspectThreadCommands: async () => ({ commands: [] }),
        listThreadOwnership: async () => ({ threads: [] }),
        subscribeThreadUsage: () => () => {},
        checkUpdate: unavailable, readUpdateStatus: unavailable, startUpdate: unavailable,
      }]));
      const facade = Object.fromEntries(Object.keys(clients.local).map(method => [
        method, (...args) => clients[hostId][method](...args),
      ]));
      facade.currentHostId = () => routeReady ? hostId : null;
      facade.clientForHost = (host) => clients[host];
      const installPolicy = () => {
        const owner = hostId;
        window.__codexhostDraftPrewarmPolicyV1 = {
          state: "ready", hostId: owner,
          select: () => true,
          clear: () => request(owner, "clear", () => undefined),
        };
      };
      installPolicy();
      const composer = document.createElement("form");
      composer.setAttribute("data-codex-composer-root", "true");
      composer.style.cssText = "position:fixed;bottom:40px;left:300px;width:600px";
      composer.innerHTML = '<div data-codex-composer contenteditable="true" role="textbox"></div><button type="submit">Send</button>';
      const editor = composer.querySelector("[role=textbox]");
      const modelState = {
        atom: {}, get: () => ({ isManuallyChanged: false, modelSettings: null, serviceTier: null }),
        set: () => undefined,
      };
      Object.defineProperty(editor, "__reactFiber$accounts", { value: {
        updateQueue: { memoCache: { data: [
          [undefined, modelState, modelState],
          [{}, {}, "client-new-thread:accounts", modelState, undefined, modelState, modelState],
        ] } }, return: null,
      } });
      if (globalThis.boundThread) {
        const portal = document.createElement("div");
        portal.setAttribute("data-above-composer-portal", "true");
        portal.setAttribute("data-above-composer-conversation-id", "synthetic-thread");
        composer.append(portal);
      }
      composer.addEventListener("submit", (event) => {
        event.preventDefault();
        calls.push({ host: hostId, method: "submit" });
      });
      document.body.append(composer);
      const binding = installRendererBindingProbe({ enabledAgents: ["codex", "pi"], defaultAgent: "codex" });
      const adapterStatus = { state: routeReady ? "ready" : "installing", reason: "ready", modelUpdates: 0, hook: "request-bridge" };
      binding.setAdapter(
        adapterStatus,
        undefined, () => true, facade,
      );
      globalThis.accountsFixture = {
        calls,
        ready: (event) => {
          routeReady = true;
          adapterStatus.state = "ready";
          window.dispatchEvent(new Event(event));
        },
        pause: (key) => paused.add(key),
        pending: (key) => pending.get(key)?.length ?? 0,
        reconnectLocal: () => {
          clients.local = {
            ...clients.local,
            listCodexAccounts: () => request("local", "replacement-accounts", () => ({
              ...accountList("local"),
              accounts: [{ ...accounts("local")[0], email: "reconnected@example.com" }],
            })),
          };
          installPolicy();
          window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
        },
        release: (key) => {
          paused.delete(key);
          for (const resolve of pending.get(key) ?? []) resolve();
          pending.delete(key);
        },
        focus: () => window.dispatchEvent(new Event("focus")),
        notify: ([host, next]) => {
          current[host] = next.currentAccountId;
          revision[host] = next.revision;
          for (const listener of subscribers[host]) listener(next);
        },
        switchAccount: (accountId) => {
          const owner = hostId;
          revision[owner]++;
          const changing = { ...accountList(owner), phase: "changing", revision: revision[owner] };
          for (const listener of subscribers[owner]) listener(changing);
          void clients[owner].switchCodexAccount({ accountId }).catch(() => {
            revision[owner]++;
            const restored = accountList(owner);
            for (const listener of subscribers[owner]) listener(restored);
          });
        },
        failSwitch: () => { failNextSwitch = true; },
        switchHost: (next) => {
          hostId = next;
          installPolicy();
          window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
        },
        dispose: () => binding.dispose(),
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "renderer-codex-account-isolation-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Account isolation bundle was not generated");
const browserBundleText: string = browserBundle;

async function setup(page: Page, options: Record<string, boolean> = {}): Promise<void> {
  await page.setContent("<!doctype html><body></body>");
  await page.evaluate((flags) => Object.assign(globalThis, flags), options);
  await page.addScriptTag({ content: browserBundleText });
  if (options.delayedHost) return;
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-default@example.com/);
  await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
}

async function action(page: Page, method: string, value?: unknown): Promise<void> {
  await page.evaluate(
    ({ method, value }) => {
      const fixture = Reflect.get(globalThis, "accountsFixture");
      fixture[method](value);
    },
    { method, value },
  );
}

const trigger = '[data-codexhost-agent-control] > button[aria-haspopup="menu"]';

async function switchToOtherAccount(page: Page): Promise<void> {
  await action(page, "switchAccount", "other");
}

async function calls(page: Page) {
  return page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls);
}

test("a Settings-style Host Account switch updates the Composer without adding Account choices", async ({
  page,
}) => {
  await setup(page);
  await page.locator(trigger).click();
  await expect(page.locator('button[data-agent="codex"]')).toBeVisible();
  await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
  await page.locator(trigger).click();
  await switchToOtherAccount(page);
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-other/);
  await expect.poll(() => calls(page)).toContainEqual({ host: "local", method: "switch:other" });
  await expect.poll(() => calls(page)).toContainEqual({ host: "local", method: "usage:other" });
  await page.locator('button[type="submit"]').click();
  expect(await calls(page)).toContainEqual({ host: "local", method: "submit" });
  expect(JSON.stringify(await calls(page))).not.toContain("accountId");
});

test("current Accounts stay isolated by Host and never become cross-Host draft overrides", async ({
  page,
}) => {
  await setup(page);
  await switchToOtherAccount(page);
  await action(page, "switchHost", "remote");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
  await expect.poll(() => calls(page)).toContainEqual({ host: "remote", method: "usage:default" });
  expect(await calls(page)).not.toContainEqual({ host: "remote", method: "usage:other" });
  await action(page, "switchHost", "local");
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-other/);
});

test("a late Account refresh from the previous Host cannot overwrite the active Host", async ({
  page,
}) => {
  await setup(page);
  await action(page, "pause", "local:accounts");
  await action(page, "focus");
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "accountsFixture").pending("local:accounts")),
    )
    .toBeGreaterThan(0);
  await action(page, "switchHost", "remote");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
  await action(page, "release", "local:accounts");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
});

test("SSH-style unsupported Account management does not retain local Account controls", async ({
  page,
}) => {
  await setup(page, { remoteUnsupported: true });
  await action(page, "switchHost", "remote");
  await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
  await expect(page.locator(trigger)).toHaveAttribute("aria-busy", "false");
  await action(page, "switchHost", "local");
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-default@example.com/);
  await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
});

test("a busy Account switch stays visible and is never replayed as a second switch", async ({
  page,
}) => {
  await setup(page);
  await action(page, "pause", "local:switch:other");
  await switchToOtherAccount(page);
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "accountsFixture").pending("local:switch:other")),
    )
    .toBeGreaterThan(0);
  await expect(page.locator(trigger)).toHaveAttribute("aria-busy", "true");
  await action(page, "release", "local:switch:other");
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-other/);
  expect(
    (await calls(page)).filter((call: { method: string }) => call.method === "switch:other"),
  ).toHaveLength(1);
});

test("a failed replacement or rollback does not display a false current Account", async ({
  page,
}) => {
  await setup(page);
  await action(page, "failSwitch");
  await switchToOtherAccount(page);
  await expect.poll(() => calls(page)).toContainEqual({ host: "local", method: "switch:other" });
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-default/);
});

test("a replacement protocol client discards the previous Account response", async ({ page }) => {
  await setup(page);
  await action(page, "pause", "local:accounts");
  await action(page, "focus");
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "accountsFixture").pending("local:accounts")),
    )
    .toBeGreaterThan(0);
  await action(page, "reconnectLocal");
  await expect(page.locator(trigger)).toHaveAttribute("title", /reconnected@example.com/);
  await action(page, "release", "local:accounts");
  await expect(page.locator(trigger)).toHaveAttribute("title", /reconnected@example.com/);
});

test("two Renderer windows consume the same Host current-Account revision", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  await Promise.all([setup(page), setup(second)]);
  const snapshot = {
    version: 2,
    currentAccountId: "other",
    phase: "ready",
    revision: 2,
    capabilities: {
      supportsMultipleAccounts: true,
      supportsAddAccount: true,
      supportsSwitchAccount: true,
      supportsDeleteAccount: true,
      supportsLiveQuota: true,
    },
    accounts: [
      { accountId: "default", email: "local-default@example.com", label: "local-default" },
      { accountId: "other", email: "local-other@example.com", label: "local-other" },
    ],
  };
  await Promise.all([
    action(page, "notify", ["local", snapshot]),
    action(second, "notify", ["local", snapshot]),
  ]);
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-other/);
  await expect(second.locator(trigger)).toHaveAttribute("title", /local-other/);
});
