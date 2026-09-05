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

      const model = { id: "pi-model-v1.startup" };
      const inspection = {
        status: "ready",
        catalog: {
          models: [{ ref: model, label: "Startup Model" }],
          defaultModel: model,
          thinkingOptions: [],
        },
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: false,
            selectPermissionMode: false,
            permissionModeScope: "live" as const,
          },
          history: {
            fork: true,
            forkAcrossCwd: true,
            rollbackLastTurn: true,
            replacementFence: true,
          },
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
      const binding = installRendererBindingProbe({
        enabledAgents: ["codex", "pi", "deepseek-harness", "opencode", "claude-code", "grok", "omp"],
        defaultAgent: globalThis.startupAgent ?? "pi",
      });
      binding.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "model-state" },
        undefined,
        () => true,
        {
          inspectHarness: async () => inspection,
          inspectHarnessCommands: async (input) => {
            globalThis.commandCatalogRequests.push(input);
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
