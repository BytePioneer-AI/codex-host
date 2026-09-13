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
      const accounts = (host) => ["default", "other"].map((accountId) => ({
        accountId, label: host + "-" + accountId,
        email: host + "-" + accountId + "@example.com",
      }));
      const accountList = (host) => ({
        version:2,currentAccountId:current[host],phase:"ready",revision:revision[host],
        instanceId:host + "-epoch",
        capabilities:{manage:true,switch:true,login:true,delete:true,logout:true,recover:true},
        accounts:accounts(host),
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
        subscribeCodexAccounts: (listener) => {
          subscribers[host].add(listener);
          return () => subscribers[host].delete(listener);
        },
        inspectCodexAccountUsage: (input) => request(host, "usage:" + input.accountId, () => ({
          accountId: input.accountId, usage: null,
          freshness:"live",observedAt:"2026-09-11T00:00:00.000Z",
          accountCredits: { usedPercent: host === "local" ? 17 : 83, periodType:"weekly" },
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
        notify: ([owner, snapshot]) => {
          current[owner] = snapshot.currentAccountId;
          revision[owner] = snapshot.revision;
          for (const listener of subscribers[owner]) listener(snapshot);
        },
        switchAccount: ([owner, accountId]) => {
          current[owner] = accountId;
          revision[owner] += 1;
          const snapshot = accountList(owner);
          for (const listener of subscribers[owner]) listener(snapshot);
        },
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
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.route("http://localhost/account-isolation", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("http://localhost/account-isolation");
  await page.evaluate((flags) => Object.assign(globalThis, flags), options);
  await page.addScriptTag({ content: browserBundleText });
  if ((await page.evaluate(() => Reflect.get(globalThis, "accountsFixture"))) === undefined) {
    throw new Error(pageErrors.join("\n") || "Account isolation fixture did not initialize");
  }
  if (options.delayedHost) return;
  if (!options.ownershipError) {
    await expect(page.locator(trigger)).toHaveAttribute("title", /local-default@example.com/);
  }
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

async function selectOtherAccount(page: Page): Promise<void> {
  await action(page, "switchAccount", ["local", "other"]);
}

async function calls(page: Page) {
  return page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls);
}

test("Usage shows the global current Account and follows Host changes without token data", async ({
  page,
}) => {
  await setup(page);
  const details = page.getByRole("dialog", { name: "Thread Usage details" });
  await page.getByRole("button", { name: "Thread Usage: Usage", exact: true }).hover();
  await expect(details).toBeVisible();
  await expect(details).toContainText("local-default@example.com");
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await selectOtherAccount(page);
  await page.getByRole("button", { name: "Thread Usage: Usage", exact: true }).hover();
  await expect(details).toContainText("local-other@example.com");
  await expect(details).not.toContainText("local-default@example.com");
  await page.mouse.move(0, 0);
  await action(page, "switchHost", "remote");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
  await page.getByRole("button", { name: "Thread Usage: Usage", exact: true }).hover();
  await expect(details).toContainText("remote-default@example.com");
  await expect(details).not.toContainText("local-other@example.com");
});

async function waitForPending(page: Page, key: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((key) => Reflect.get(globalThis, "accountsFixture").pending(key), key),
    )
    .toBeGreaterThan(0);
}

for (const host of ["local", "remote"]) {
  for (const event of [
    "codexhost:renderer-adapter-status",
    "codexhost:draft-prewarm-policy-changed",
  ]) {
    test(`the first ${host} draft shows Accounts when its Host becomes ready via ${event}`, async ({
      page,
    }) => {
      await setup(page, { delayedHost: true, startRemote: host === "remote" });
      await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
      await action(page, "ready", event);
      await expect.poll(() => calls(page)).toContainEqual({ host, method: "accounts" });
      await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
      await expect(page.locator(trigger)).toHaveAttribute("title", new RegExp(host + "-default"));
    });
  }
}

test("a cold remote draft with no Account API never adopts local Accounts", async ({ page }) => {
  await setup(page, { delayedHost: true, startRemote: true, remoteUnsupported: true });
  await action(page, "ready", "codexhost:renderer-adapter-status");
  await expect.poll(() => calls(page)).toContainEqual({ host: "remote", method: "accounts" });
  await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
  await page.locator(trigger).click();
  await expect(page.getByRole("menuitemradio", { name: "Codex", exact: true })).toBeVisible();
  expect(await calls(page)).not.toContainEqual({ host: "local", method: "accounts" });
});

test("an unsupported remote Account API does not retain the local Account menu", async ({
  page,
}) => {
  await setup(page, { remoteUnsupported: true });
  await action(page, "pause", "remote:accounts");
  await action(page, "switchHost", "remote");
  await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
  await action(page, "release", "remote:accounts");
  await expect(page.locator(trigger)).toHaveAttribute("aria-busy", "false");
  await page.locator(trigger).click();
  await expect(page.getByRole("menuitemradio", { name: "Codex", exact: true })).toBeVisible();
  await action(page, "switchHost", "local");
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-default@example.com/);
});

test("global current Accounts and quota requests stay on their Host even when IDs match", async ({
  page,
}) => {
  await setup(page);
  await selectOtherAccount(page);
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-other/);
  await action(page, "switchHost", "remote");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
  await expect.poll(() => calls(page)).toContainEqual({ host: "remote", method: "usage:default" });
  expect(await calls(page)).not.toContainEqual({ host: "remote", method: "usage:other" });
  await action(page, "switchHost", "local");
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-other/);
  await page.locator('button[type="submit"]').click();
  expect(await calls(page)).toContainEqual({ host: "local", method: "submit" });
});

test("switching Hosts does not add an Account input to draft submission", async ({ page }) => {
  await setup(page);
  await selectOtherAccount(page);
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-other/);
  await page.locator('button[type="submit"]').click();
  await action(page, "switchHost", "remote");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
  await page.locator('button[type="submit"]').click();
  expect(await calls(page)).toContainEqual({ host: "remote", method: "submit" });
  expect(JSON.stringify(await calls(page))).not.toContain("accountId");
});

test("a global Account change never invokes the draft prewarm policy", async ({ page }) => {
  await setup(page);
  await selectOtherAccount(page);
  await action(page, "switchHost", "remote");
  await expect(page.locator(trigger)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
  expect(
    (await calls(page)).filter((call: { method: string }) => call.method === "select"),
  ).toEqual([]);
});

test("late local Account and quota responses cannot overwrite the remote Composer", async ({
  page,
}) => {
  await setup(page);
  await action(page, "pause", "local:usage:default");
  await action(page, "focus");
  await waitForPending(page, "local:usage:default");
  await action(page, "pause", "local:accounts");
  await action(page, "focus");
  await waitForPending(page, "local:accounts");
  await action(page, "switchHost", "remote");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
  const credits = page.locator("[data-codexhost-credits-label]");
  await expect(credits).toHaveText("17%");
  await action(page, "release", "local:accounts");
  await action(page, "release", "local:usage:default");
  await expect(page.locator(trigger)).toHaveAttribute("title", /remote-default/);
  await expect(credits).toHaveText("17%");
});

test("rejects stale revisions but accepts a fresh Host epoch with a reset revision", async ({
  page,
}) => {
  await setup(page);
  const capabilities = { manage: true, switch: true, login: true, delete: true };
  const accounts = [
    { accountId: "default", label: "local-default", email: "local-default@example.com" },
    { accountId: "other", label: "local-other", email: "local-other@example.com" },
  ];
  await action(page, "notify", [
    "local",
    {
      version: 2,
      currentAccountId: "other",
      phase: "ready",
      revision: 0,
      instanceId: "local-epoch",
      capabilities,
      accounts,
    },
  ]);
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-default/);
  await action(page, "notify", [
    "local",
    {
      version: 2,
      currentAccountId: "other",
      phase: "ready",
      revision: 0,
      instanceId: "local-new-epoch",
      capabilities,
      accounts,
    },
  ]);
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-other/);
});

test("a replacement client for the same Host does not inherit old Account responses", async ({
  page,
}) => {
  await setup(page);
  await action(page, "pause", "local:accounts");
  await action(page, "focus");
  await waitForPending(page, "local:accounts");
  await action(page, "reconnectLocal");
  await expect(page.locator(trigger)).not.toHaveAttribute("title", /local-default@example.com/);
  await action(page, "release", "local:accounts");
  await expect(page.locator(trigger)).toHaveAttribute("title", /reconnected@example.com/);
  await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
});

test("a native remote Thread remains usable without codexhost ownership or Account APIs", async ({
  page,
}) => {
  await setup(page, { boundThread: true, remoteNative: true, remoteUnsupported: true });
  await action(page, "switchHost", "remote");
  await expect(page.locator(trigger)).toHaveAttribute("title", "Agent: Codex (locked)");
  await expect(page.locator(trigger)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-codex-account-id]")).toHaveCount(0);
  await expect.poll(() => calls(page)).toContainEqual({ host: "remote", method: "thread/read" });
  await page.locator('button[type="submit"]').click();
  expect(await calls(page)).toContainEqual({ host: "remote", method: "submit" });
  expect(await calls(page)).not.toContainEqual({ host: "local", method: "thread/read" });
});

test("a late native ownership read cannot replace the Composer after switching back to local", async ({
  page,
}) => {
  await setup(page, {
    boundThread: true,
    remoteNative: true,
    remoteUnsupported: true,
    localBoundAccount: true,
  });
  await action(page, "pause", "remote:thread/read");
  await action(page, "switchHost", "remote");
  await waitForPending(page, "remote:thread/read");
  await action(page, "switchHost", "local");
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-default/);
  await action(page, "release", "remote:thread/read");
  await expect(page.locator(trigger)).toHaveAttribute("title", /local-default/);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
});

test("unsupported remote Harness probes are not resent by retries, focus, or Host switches", async ({
  page,
}) => {
  await page.clock.install();
  await setup(page, { remoteUnsupported: true, remoteHarnessUnsupported: true });
  await action(page, "switchHost", "remote");
  await expect.poll(() => calls(page)).toContainEqual({ host: "remote", method: "harness:pi" });
  await page.clock.runFor(30_000);
  await action(page, "focus");
  await action(page, "switchHost", "local");
  await action(page, "switchHost", "remote");
  await page.clock.runFor(30_000);
  expect(
    (await calls(page)).filter(
      (call: { host: string; method: string }) =>
        call.host === "remote" && call.method === "harness:pi",
    ),
  ).toHaveLength(1);
  await expect(page.locator(trigger)).toHaveAttribute("aria-busy", "false");
});

test("ownership errors stop spinning without permitting an unknown Thread to submit", async ({
  page,
}) => {
  await setup(page, { boundThread: true, ownershipError: true });
  await expect.poll(() => calls(page)).toContainEqual({ host: "local", method: "ownership" });
  await expect(page.locator(trigger)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(trigger)).toHaveAttribute("title", /unable|failed|无法|失败/i);
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  await page.evaluate(() => Reflect.set(globalThis, "ownershipError", false));
  await action(page, "focus");
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await expect(page.locator(trigger)).not.toHaveAttribute("title", /unable|failed|无法|失败/i);
});
