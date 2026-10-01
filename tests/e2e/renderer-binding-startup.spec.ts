import { expect, test } from "@playwright/test";
import { decodePiTransportSelection } from "@codexhost/protocol-core";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

test.beforeEach(async ({ page }) => {
  // The production binding reads preferences from localStorage; about:blank's
  // opaque origin rejects that before any Composer can mount.
  await page.route("https://codexhost.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("https://codexhost.test/");
});

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      import { modelSelectionForAgent } from "./packages/renderer-extension/src/versioned-renderer-adapter.ts";
      import { createDraftPrewarmPolicyBridge } from "./packages/desktop-control/src/renderer-draft-prewarm-runtime.ts";
      import { parseKiroModelCatalog } from "./packages/adapters/kiro-cli/src/models.ts";
      import { KIRO_COMMAND_CATALOG } from "./packages/adapters/kiro-cli/src/commands.ts";

      const model = { id: "pi-model-v1.startup" };
      const kiro = globalThis.startupAgent === "kiro-cli";
      const inspection = {
        status: "ready",
        catalog: kiro ? parseKiroModelCatalog([{
          id: "model",
          currentValue: "auto",
          options: [
            { value: "auto", name: "Auto", _meta: { kiro: { hasEffort: false } } },
            { value: "adjustable", name: "Adjustable Kiro Model", _meta: { kiro: {
              hasEffort: true, effortLevels: ["low", "medium", "high"], defaultEffortLevel: "low",
            } } },
            { value: "fixed", name: "Fixed Kiro Model", _meta: { kiro: { hasEffort: false } } },
          ],
        }]) : {
          models: [{ ref: model, fastModel: { id: "pi-model-v1.startup-fast" }, label: "Startup Model" }],
          defaultModel: model,
          thinkingOptions: [],
        },
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: kiro,
            selectPermissionMode: false,
            permissionModeScope: "live" as const,
          },
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
        },
      };

      const composer = document.createElement("div");
      composer.setAttribute("data-codex-composer-root", "true");
      const editor = document.createElement("div");
      editor.setAttribute("data-codex-composer", "true");
      editor.setAttribute("contenteditable", "true");
      editor.setAttribute("role", "textbox");
      const modelState = {
        atom: {},
        get: () => ({ isManuallyChanged: false, modelSettings: null, serviceTier: null }),
        set: () => undefined,
      };
      Object.defineProperty(editor, "__reactFiber$startup", {
        configurable: true,
        value: {
          updateQueue: {
            memoCache: {
              data: [
                [undefined, modelState, modelState],
                [{}, {}, "client-new-thread:startup", modelState, undefined, modelState, modelState],
              ],
            },
          },
          return: null,
        },
      });
      const toolbar = document.createElement("div");
      const send = document.createElement("button");
      send.type = "submit";
      toolbar.append(send);
      composer.append(editor, toolbar);
      document.body.append(composer);

      const unavailable = async () => {
        throw new Error("unused fixed control");
      };
      globalThis.threadCommandRequests = [];
      globalThis.commandCatalogRequests = [];
      globalThis.appliedConfiguration = null;
      const binding = installRendererBindingProbe({
        enabledAgents: ["codex", "pi", "deepseek-harness", "opencode", "claude-code", "grok", "omp", "kiro-cli"],
        defaultAgent: globalThis.startupAgent ?? "pi",
      });
      binding.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "model-state" },
        undefined,
        (agent, model, thinkingOptionId) => {
          globalThis.appliedConfiguration = { agent, model, thinkingOptionId };
          window.__codexhostHostRoutingV1?.forComposer()?.policy.select(
            modelSelectionForAgent(null, null, agent, model, thinkingOptionId)?.model ?? null,
          );
          return true;
        },
        {
          inspectHarness: async (_input, options) => {
            if (globalThis.holdBackgroundInspections && options?.priority === "background") {
              await new Promise(() => {});
            }
            return inspection;
          },
          inspectHarnessCommands: async (input) => {
            globalThis.commandCatalogRequests.push(input);
            if (kiro) return KIRO_COMMAND_CATALOG;
            return { commands: globalThis.startupCommands ?? [{
              id: "pi.compact", invocation: "/compact", label: "Compact", argumentMode: "text",
            }] };
          },
          inspectThreadCommands: async (input) => {
            globalThis.threadCommandRequests.push(input);
            throw new Error("must not inspect a Thread for commands");
          },
          executeThreadCommand: async (input) => {
            globalThis.threadCommandRequests.push(input);
            throw new Error("must not execute a command before submit");
          },
          inspectThread: unavailable,
          forkThread: unavailable,
          inspectThreadUsage: unavailable,
          subscribeThreadUsage: () => {
            throw new Error("Usage notification transport is not ready");
          },
          listThreadOwnership: unavailable,
          selectThreadModel: unavailable,
          selectThreadThinking: unavailable,
          selectThreadPermissionMode: unavailable,
          checkUpdate: unavailable,
          startUpdate: unavailable,
          readUpdateStatus: unavailable,
        },
        () => globalThis.scopedAdapterReady === false
          ? { state: "installing", reason: "draft-routing-policy-unavailable", modelUpdates: 0, hook: null }
          : { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      );

      setTimeout(() => {
        globalThis.threadStartRequests = [];
        const bridge = {
          sendRequest: async (method, params) => {
            globalThis.threadStartRequests.push({ method, params });
            return { thread: { id: "fixture-thread" } };
          },
          prewarmThreadStart(params) { return this.sendRequest("thread/start", params); },
          enqueueRequest: unavailable,
          onResult: () => {},
          onError: () => {},
        };
        const policy = createDraftPrewarmPolicyBridge(
          { onNotification() {}, onRequest() {}, dispatchAppServerResponse() {} },
          bridge, "local", window, { discardAllPrewarmedThreads() {} },
        );
        window.__codexhostHostRoutingV1 = { forComposer: () => ({ hostId: "local", policy }) };
        globalThis.prewarmTestDraft = () => bridge.prewarmThreadStart({ cwd: "/fixture/workspace", model: "native" });
        document.addEventListener("click", (event) => {
          if (!event.defaultPrevented && event.target?.matches("button[type=submit]")) {
            void bridge.sendRequest("thread/start", { cwd: "/fixture/workspace", model: "native" });
          }
        });
      }, 100);
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-binding-startup-e2e-entry.ts",
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

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer binding startup E2E bundle was not generated");

test("a new conversation shows Harness commands but disables compact before a Thread exists", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });

  const trigger = page.locator("[data-codexhost-harness-command-control] > button");
  await expect(page.locator("[data-codexhost-harness-command-control]")).not.toHaveAttribute(
    "hidden",
    "",
  );
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled();
  await expect(trigger).toHaveAttribute("title", "Type # for commands, skills and agents");
  // The button types `#` into the Composer, which opens the # menu.
  await trigger.click();
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await expect(menu).toBeVisible();
  await expect(page.locator("[data-codex-composer]")).toHaveText("#");
  await expect(menu.locator('[aria-disabled="true"] [data-command-id="pi.compact"]')).toBeVisible();
  await expect(menu).toContainText("Start a conversation before running this command");
  expect(await page.evaluate(() => Reflect.get(globalThis, "threadCommandRequests"))).toEqual([]);
});

test("a DSH draft offers goal and plan but explains why compact cannot run", async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.evaluate(() => {
    Reflect.set(globalThis, "startupAgent", "deepseek-harness");
    Reflect.set(globalThis, "startupCommands", [
      { id: "dsh.compact", invocation: "/compact", label: "Compact", argumentMode: "none" },
      { id: "dsh.goal", invocation: "/dsh-goal", label: "Goal", argumentMode: "text" },
      { id: "dsh.plan", invocation: "/plan", label: "Plan", argumentMode: "text" },
    ]);
  });
  await page.addScriptTag({ content: browserBundle });
  const trigger = page.locator("[data-codexhost-harness-command-control] > button");
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await trigger.click();
  await expect(menu.locator("[data-command-id]")).toHaveCount(3);
  await expect(
    menu.locator('[aria-disabled="true"] [data-command-id="dsh.compact"]'),
  ).toBeVisible();
  await expect(menu).toContainText("Start a conversation before running this command");
  await page.keyboard.press("Escape");
  for (const [id, invocation] of [
    ["dsh.goal", "/dsh-goal"],
    ["dsh.plan", "/plan"],
  ] as const) {
    await page.locator("[data-codex-composer]").evaluate((editor) => {
      editor.textContent = "";
    });
    await trigger.click();
    await menu.locator(`[data-command-id="${id}"]`).click();
    await expect(page.locator("[data-codex-composer]")).toContainText(invocation);
  }
  expect(await page.evaluate(() => Reflect.get(globalThis, "threadCommandRequests"))).toEqual([]);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "commandCatalogRequests")),
  ).toContainEqual({ harnessId: "deepseek-harness" });
});

test("a native Codex draft hides the external Harness command button", async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.evaluate(() => Reflect.set(globalThis, "startupAgent", "codex"));
  await page.addScriptTag({ content: browserBundle });

  const root = page.locator("[data-codexhost-harness-command-control]");
  await expect(root).toHaveAttribute("hidden", "");
  await expect(root).toBeHidden();
});

for (const agent of ["codex", "pi"]) {
  test(`a disconnected Composer blocks external submission but preserves native ${agent} input`, async ({
    page,
  }) => {
    await page.evaluate((value) => Reflect.set(globalThis, "startupAgent", value), agent);
    await page.addScriptTag({ content: browserBundle });
    if (agent === "pi") {
      await expect(
        page.locator('[data-codexhost-model-control] > button[aria-haspopup="menu"]'),
      ).toContainText("Startup Model");
    }
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(globalThis, "prewarmTestDraft")))
      .toBe("function");
    await page.evaluate(() => {
      Reflect.set(globalThis, "scopedAdapterReady", false);
      window.dispatchEvent(new Event("codexhost:renderer-adapter-status"));
    });
    const send = page.locator('button[type="submit"]');
    if (agent === "pi") {
      await expect(send).toBeDisabled();
      await page.locator('[contenteditable="true"]').press("Enter");
      expect(await page.evaluate(() => Reflect.get(globalThis, "threadStartRequests"))).toEqual([]);
    } else {
      await page.locator('[contenteditable="true"]').fill("native input");
      await expect(send).toBeEnabled();
      await send.click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(globalThis, "threadStartRequests")))
        .toHaveLength(1);
    }
  });
}

test("a remounted draft keeps explicit Fast through submission, but a new draft starts without it", async ({
  page,
}) => {
  await page.route("http://startup.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("http://startup.test/");
  await page.evaluate(() =>
    localStorage.setItem(
      "codexhost.new-thread-preference.v1",
      JSON.stringify({
        version: 1,
        lastAgent: "pi",
        externalByAgent: {},
      }),
    ),
  );
  await page.addScriptTag({ content: browserBundle });
  const fast = page.locator("[data-codexhost-fast-toggle]:visible");
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => Reflect.get(globalThis, "prewarmTestDraft")());

  const remount = async (newDraft: boolean) => {
    await page.locator("[data-codex-composer-root]:visible").evaluate((original, newDraft) => {
      const originalEditor = original.querySelector("[data-codex-composer]");
      if (!originalEditor) throw new Error("Missing fixture editor");
      const originalFiber = Object.getOwnPropertyDescriptor(
        originalEditor,
        "__reactFiber$startup",
      )?.value;
      if (!originalFiber) throw new Error("Missing fixture Fiber");
      const data = originalFiber.updateQueue.memoCache.data.map((row: unknown[]) => [...row]);
      if (newDraft) data[1][2] = "client-new-thread:next";
      const fiber = { ...originalFiber, updateQueue: { memoCache: { data } } };
      const composer = document.createElement("div");
      composer.setAttribute("data-codex-composer-root", "true");
      const editor = originalEditor.cloneNode(true);
      Object.defineProperty(editor, "__reactFiber$startup", { configurable: true, value: fiber });
      const toolbar = document.createElement("div");
      const send = document.createElement("button");
      send.type = "submit";
      toolbar.append(send);
      composer.append(editor, toolbar);
      // Desktop can retain the old Composer or mount its replacement in another container;
      // neither produces a paired removal/addition MutationRecord.
      (original as HTMLElement).hidden = true;
      document.body.append(composer);
    }, newDraft);
  };
  await remount(false);
  await expect(fast).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-codex-composer-root]:visible button[type=submit]").click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "appliedConfiguration"))).toMatchObject({
    agent: "pi",
    model: { id: "pi-model-v1.startup-fast" },
  });
  const requests = await page.evaluate(() => Reflect.get(globalThis, "threadStartRequests"));
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.method).toBe("thread/start");
    expect(decodePiTransportSelection(request.params.model)?.model).toEqual({
      id: "pi-model-v1.startup-fast",
    });
  }
  await remount(true);
  await expect(fast).toHaveAttribute("aria-pressed", "false");
});

test("a draft waits for the Desktop prewarm policy before applying its Model", async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });

  const trigger = page.locator('[data-codexhost-model-control] > button[aria-haspopup="menu"]');
  await expect(trigger).toContainText("Startup Model");
  await expect(trigger).toBeEnabled();
  await expect(trigger).toHaveAttribute("title", "Startup Model");
});

test("the selected Model loads while its background Harness discovery remains queued", async ({
  page,
}, testInfo) => {
  await page.evaluate(() => Reflect.set(globalThis, "holdBackgroundInspections", true));
  await page.addScriptTag({ content: browserBundle });

  const trigger = page.locator('[data-codexhost-model-control] > button[aria-haspopup="menu"]');
  await expect(trigger).toContainText("Startup Model");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByRole("menu", { name: "Model", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("foreground-model-ready.png") });
});

test("restores the visible draft selection after a same-Host connection policy changes", async ({
  page,
}) => {
  await page.addScriptTag({ content: browserBundle });
  await expect(
    page.locator('[data-codexhost-model-control] > button[aria-haspopup="menu"]'),
  ).toContainText("Startup Model");
  await page.evaluate(() => {
    Reflect.set(globalThis, "appliedConfiguration", null);
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "appliedConfiguration")))
    .toMatchObject({ agent: "pi", model: { id: "pi-model-v1.startup" } });
});

test("Kiro selects Thinking inside the Model picker before a Thread exists", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.setContent(`<!doctype html>
    <style>
      body { margin:24px; background:#202020; color:#eee; font:14px system-ui; color-scheme:dark; }
      [data-codex-composer-root] { position:absolute; left:24px; bottom:24px; }
      [role=menu] { background:#282828; color:#eee; border-radius:8px; box-shadow:0 4px 20px #1118; }
      [role=menu] button { display:flex; align-items:center; gap:8px; width:100%; border:0; background:transparent; color:inherit; padding:8px; text-align:left; font:inherit; }
      [role=menu] button span:first-child { flex:1; }
      [role=menu] button:hover { background:#3b3b3b; }
      [role=presentation] { padding:8px; color:#aaa; }
      [role=separator] { border-top:1px solid #444; margin:4px 0; }
      input { box-sizing:border-box; width:100%; }
    </style><body></body>`);
  await page.evaluate(() => Reflect.set(globalThis, "startupAgent", "kiro-cli"));
  await page.addScriptTag({ content: browserBundle });
  const trigger = page.locator("[data-codexhost-model-control] > button");
  const mainMenu = page.getByRole("menu", { name: "Model and Thinking", exact: true });
  const modelMenu = page.getByRole("menu", { name: "Model", exact: true });
  await expect(trigger).toHaveAttribute("aria-label", "Model: Auto");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await modelMenu.locator('[data-model-id="adjustable"]').click();
  await expect(trigger).toHaveAttribute("aria-label", "Model: Adjustable Kiro Model, Low");
  await trigger.click();
  await expect(mainMenu).toBeVisible();
  await expect(mainMenu.locator("[data-thinking-option-id]")).toHaveText([
    "Low✓",
    "Medium✓",
    "High✓",
  ]);
  await mainMenu.locator('[data-thinking-option-id="high"]').click();
  await expect(trigger).toHaveAttribute("aria-label", "Model: Adjustable Kiro Model, High");
  expect(await page.evaluate(() => Reflect.get(globalThis, "appliedConfiguration"))).toEqual({
    agent: "kiro-cli",
    model: { id: "adjustable" },
    thinkingOptionId: "high",
  });
  await trigger.click();
  await mainMenu.locator("[data-open-model-menu]").hover();
  await expect(modelMenu).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("kiro-model-thinking-picker.png"),
    clip: { x: 0, y: 430, width: 600, height: 270 },
  });
  await modelMenu.locator('[data-model-id="fixed"]').click();
  await expect(trigger).toHaveAttribute("aria-label", "Model: Fixed Kiro Model");
  await trigger.click();
  await expect(modelMenu).toBeVisible();
  await expect(mainMenu).toBeHidden();
  expect(await page.evaluate(() => Reflect.get(globalThis, "appliedConfiguration"))).toEqual({
    agent: "kiro-cli",
    model: { id: "fixed" },
    thinkingOptionId: undefined,
  });
  expect(await page.evaluate(() => Reflect.get(globalThis, "threadCommandRequests"))).toEqual([]);
  await page.keyboard.press("Escape");
  await page.locator("[data-codexhost-harness-command-control] > button").click();
  await expect(page.locator('[data-command-id="kiro.effort"]')).toHaveCount(0);
  await expect(page.locator('[data-command-id="kiro.context"]')).toBeVisible();
});
