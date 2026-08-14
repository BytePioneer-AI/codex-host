import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import {
        mountRendererModelPicker,
        renderRendererModelPicker,
      } from "./packages/renderer-extension/src/renderer-model-picker.ts";

      globalThis.setupRendererModelPicker = () => {
        const modelA = { id: "model-a" };
        const modelB = { id: "model-b" };
        const catalog = {
          models: [
            {
              ref: modelA,
              label: "Provider / Model A",
              supportedThinkingOptionIds: ["off", "low"],
            },
            {
              ref: modelB,
              label: "Provider / Model B",
              supportedThinkingOptionIds: ["off", "high", "xhigh"],
            },
          ],
          defaultModel: modelA,
          thinkingOptions: [
            { id: "off", label: "Off" },
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
          ],
          defaultThinkingOptionId: "low",
        };
        let view = {
          status: "ready",
          catalog,
          selected: modelA,
          selectedThinkingOptionId: "low",
        };
        let control;
        control = mountRendererModelPicker(
          "test-composer",
          undefined,
          (modelId) => {
            view = { ...view, status: "selecting" };
            renderRendererModelPicker(control, view, true);
            setTimeout(() => {
              view = {
                status: "ready",
                catalog,
                selected: modelId === modelB.id ? modelB : modelA,
                selectedThinkingOptionId: modelId === modelB.id ? "high" : "low",
              };
              renderRendererModelPicker(control, view, true);
            }, 250);
          },
          () => {},
        );
        document.body.append(control.root);
        renderRendererModelPicker(control, view, true);
      };

      globalThis.setupClaudeRendererModelPicker = () => {
        const alias = { id: "claude-model-v1.alias" };
        const concrete = { id: "claude-model-v1.concrete" };
        const catalog = {
          models: [
            {
              ref: alias,
              label: "Family alias",
              resolvedModelLabel: "Runtime custom",
              supportedThinkingOptionIds: ["low", "high"],
            },
            {
              ref: concrete,
              label: "Runtime custom",
              resolvedModelLabel: "Runtime custom",
            },
          ],
          defaultModel: alias,
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        };
        const view = {
          status: "ready",
          catalog,
          selected: alias,
          resolvedModelLabel: "Runtime custom",
          thinkingSelectionSupported: false,
        };
        const control = mountRendererModelPicker(
          "claude-composer",
          "native-model-trigger",
          () => {},
          () => {},
        );
        document.body.append(control.root);
        renderRendererModelPicker(control, view, true);
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-model-picker-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Model picker E2E bundle was not generated");

test("selecting a Model keeps the main menu open and refreshes Thinking options", async ({
  page,
}) => {
  await page.setContent(
    '<!doctype html><body style="display:flex;align-items:flex-end;min-height:100vh;margin:0"></body>',
  );
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererModelPicker");
    if (typeof setup !== "function") throw new Error("Model picker setup is unavailable");
    setup();
  });

  const root = page.locator('[data-codexhost-model-control="test-composer"]');
  const trigger = root.locator(':scope > button[aria-haspopup="menu"]');
  const mainMenu = root.locator('[aria-label="Model and Thinking"]');
  const modelMenu = root.locator('[aria-label="Model"]');

  await trigger.click();
  await expect(mainMenu).toBeVisible();
  const [triggerBox, mainBox] = await Promise.all([trigger.boundingBox(), mainMenu.boundingBox()]);
  if (!triggerBox || !mainBox) throw new Error("Model picker main menu geometry is unavailable");
  expect(mainBox.y + mainBox.height).toBeLessThanOrEqual(triggerBox.y + 1);
  await root.locator("button[data-open-model-menu]").click();
  await expect(modelMenu).toBeVisible();
  const [openedMainBox, modelBox] = await Promise.all([
    mainMenu.boundingBox(),
    modelMenu.boundingBox(),
  ]);
  if (!openedMainBox || !modelBox) throw new Error("Model picker submenu geometry is unavailable");
  expect(modelBox.x).toBeCloseTo(openedMainBox.x + openedMainBox.width + 4, 0);
  expect(modelBox.y + modelBox.height).toBeCloseTo(openedMainBox.y + openedMainBox.height, 0);
  expect(modelBox.height).toBeLessThanOrEqual(360);
  await modelMenu.locator('button[data-model-id="model-b"]').click();

  await expect(modelMenu).toBeHidden();
  await expect(mainMenu).toBeVisible();
  await expect(trigger).toBeDisabled();
  await expect(root.locator("button[data-thinking-option-id]:not(:disabled)")).toHaveCount(0);

  await expect(trigger).toBeEnabled();
  await expect(mainMenu).toBeVisible();
  const thinkingOptions = root.locator("button[data-thinking-option-id]");
  await expect(thinkingOptions).toHaveCount(3);
  await expect
    .poll(() =>
      thinkingOptions.evaluateAll((options) =>
        options.map((option) => option.getAttribute("data-thinking-option-id")),
      ),
    )
    .toEqual(["off", "high", "xhigh"]);
});

test("Claude aliases show actual runtime Model without exposing Thinking", async ({ page }) => {
  await page.setContent(`
    <!doctype html>
    <style>
      .native-model-trigger {
        display: flex;
        width: 100%;
        gap: 4px;
        padding: 4px 8px;
      }
    </style>
    <body style="display:flex;align-items:flex-end;min-height:100vh;margin:0"></body>
  `);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupClaudeRendererModelPicker");
    if (typeof setup !== "function") throw new Error("Claude Model picker setup is unavailable");
    setup();
  });

  const root = page.locator('[data-codexhost-model-control="claude-composer"]');
  const trigger = root.locator(':scope > button[aria-haspopup="menu"]');
  await expect(trigger).toContainText("Family alias");
  await expect(trigger).toContainText("Runtime custom");
  await expect(trigger).not.toContainText("\u2304");
  await expect(trigger).toHaveAttribute("aria-label", /Family alias, Runtime custom/u);
  const secondaryLabel = trigger.locator("span").last();
  const [labelTriggerBox, secondaryLabelBox] = await Promise.all([
    trigger.boundingBox(),
    secondaryLabel.boundingBox(),
  ]);
  if (!labelTriggerBox || !secondaryLabelBox)
    throw new Error("Model trigger geometry is unavailable");
  const trailingSpace =
    labelTriggerBox.x + labelTriggerBox.width - (secondaryLabelBox.x + secondaryLabelBox.width);
  expect(trailingSpace).toBeLessThanOrEqual(16);

  await trigger.click();
  await expect(root.locator("button[data-thinking-option-id]")).toHaveCount(0);
  await root.locator("button[data-open-model-menu]").click();
  const mainMenu = root.locator('[aria-label="Model and Thinking"]');
  const modelMenu = root.locator('[aria-label="Model"]');
  await expect(modelMenu.locator("button[data-model-id]")).toHaveCount(2);
  const geometry = await Promise.all([
    trigger.boundingBox(),
    mainMenu.boundingBox(),
    modelMenu.boundingBox(),
    page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth })),
  ]);
  const [claudeTriggerBox, mainBox, modelBox, viewport] = geometry;
  if (!claudeTriggerBox || !mainBox || !modelBox)
    throw new Error("Model picker geometry is unavailable");
  expect(mainBox.y + mainBox.height).toBeLessThanOrEqual(claudeTriggerBox.y + 1);
  expect(modelBox.x).toBeCloseTo(mainBox.x + mainBox.width + 4, 0);
  expect(modelBox.y + modelBox.height).toBeCloseTo(mainBox.y + mainBox.height, 0);
  expect(modelBox.height).toBeLessThanOrEqual(360);
  expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(viewport.width - 8);
  expect(modelBox.y).toBeGreaterThanOrEqual(8);
  expect(modelBox.y + modelBox.height).toBeLessThanOrEqual(viewport.height - 8);
  await expect(root).not.toContainText("claude-model-v1");
});
