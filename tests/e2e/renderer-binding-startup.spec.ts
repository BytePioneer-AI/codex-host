import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
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
          models: [{ ref: model, label: "Startup Model" }],
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
          return true;
        },
        {
          inspectHarness: async () => inspection,
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
      );

      setTimeout(() => {
        window.__codexhostDraftPrewarmPolicyV1 = {
          state: "ready",
          hostId: "local",
          select: async () => undefined,
          clear: async () => undefined,
        };
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
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer binding startup E2E bundle was not generated");

test("a new conversation shows the Harness command button before a Thread exists", async ({
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
  await trigger.click();
  const menu = page.locator("[data-codexhost-harness-command-menu]");
  await expect(menu).toBeVisible();
  await menu.locator('[data-command-id="pi.compact"]').click();
  await expect(page.locator("[data-codex-composer]")).toHaveText("/compact ");
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
  const menu = page.locator("[data-codexhost-harness-command-menu]");
  await trigger.click();
  await expect(menu.locator('[role="menuitem"]')).toHaveCount(3);
  await expect(menu.locator('[data-command-id="dsh.compact"]')).toBeDisabled();
  await expect(menu).toContainText("Start a conversation before running this command");
  for (const [id, invocation] of [
    ["dsh.goal", "/dsh-goal"],
    ["dsh.plan", "/plan"],
  ] as const) {
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

test("a draft waits for the Desktop prewarm policy before applying its Model", async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });

  const trigger = page.locator('[data-codexhost-model-control] > button[aria-haspopup="menu"]');
  await expect(trigger).toContainText("Startup Model");
  await expect(trigger).toBeEnabled();
  await expect(trigger).toHaveAttribute("title", "Startup Model");
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
