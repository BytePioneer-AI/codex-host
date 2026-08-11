import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";

      const threadId = "thread-usage-notification";
      const model = { id: "pi-model-v1.usage-notification" };
      const inspection = {
        status: "ready",
        catalog: {
          models: [{ ref: model, label: "Usage Model" }],
          defaultModel: model,
          thinkingOptions: [],
        },
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: false,
            selectPermissionMode: false,
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
      Object.defineProperty(editor, "__reactFiber$usage", {
        configurable: true,
        value: {
          updateQueue: {
            memoCache: {
              data: [
                [undefined, modelState, modelState],
                [{}, {}, threadId, modelState],
              ],
            },
          },
          return: null,
        },
      });
      const toolbar = document.createElement("div");
      const context = document.createElement("span");
      context.setAttribute("aria-label", "Context usage: 20%");
      const send = document.createElement("button");
      send.type = "submit";
      toolbar.append(context, send);
      composer.append(editor, toolbar);
      document.body.append(composer);

      const threadInspection = {
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        effectiveModel: model,
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
        usage: { cacheHitRatePercent: 27, totalCostUsd: 5.634 },
        locked: true,
      };
      const inspectThread = Reflect.get(globalThis, "deferUsageInspection") === true
        ? () => new Promise((resolve) => {
            Reflect.set(globalThis, "resolveUsageInspection", () => resolve(threadInspection));
          })
        : async () => threadInspection;
      let usageListener = null;
      const unavailable = async () => {
        throw new Error("unused fixed control");
      };
      const binding = installRendererBindingProbe({
        enabledAgents: ["codex", "pi"],
        defaultAgent: "codex",
      });
      binding.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "model-state" },
        undefined,
        () => true,
        {
          inspectHarness: async () => inspection,
          inspectThread,
          forkThread: unavailable,
          inspectThreadUsage: unavailable,
          subscribeThreadUsage: (listener) => {
            usageListener = listener;
            return () => {
              usageListener = null;
            };
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

      globalThis.pushRendererUsage = () => {
        if (!usageListener) throw new Error("Usage listener is unavailable");
        usageListener({
          threadId,
          usage: { cacheHitRatePercent: 97.9, totalCostUsd: 5.913 },
        });
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-usage-notification-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl" },
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Usage notification bundle was not generated");

async function pushUsage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const push = Reflect.get(globalThis, "pushRendererUsage");
    if (typeof push !== "function") throw new Error("Usage push is unavailable");
    push();
  });
}

test("applies pushed Usage to the matching Thread without a native context mutation", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });

  const context = page.locator('[aria-label="Context usage: 20%"]');
  await expect(page.locator("[data-codexhost-usage-control]")).toHaveText("CH 27% · $5.634");

  await pushUsage(page);

  await expect(page.locator("[data-codexhost-usage-control]")).toHaveText("CH 97.9% · $5.913");
  await expect(context).toHaveAttribute("aria-label", "Context usage: 20%");
});

test("does not let an older Thread inspection overwrite pushed Usage", async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.evaluate(() => Reflect.set(globalThis, "deferUsageInspection", true));
  await page.addScriptTag({ content: browserBundle });

  await pushUsage(page);
  await expect(page.locator("[data-codexhost-usage-control]")).toHaveText("CH 97.9% · $5.913");
  await page.evaluate(() => {
    const resolve = Reflect.get(globalThis, "resolveUsageInspection");
    if (typeof resolve !== "function") throw new Error("Usage inspection resolver is unavailable");
    resolve();
  });
  await page.waitForTimeout(50);

  await expect(page.locator("[data-codexhost-usage-control]")).toHaveText("CH 97.9% · $5.913");
});
