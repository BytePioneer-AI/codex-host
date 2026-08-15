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
        mountRendererCreditsControl,
        renderRendererCreditsControl,
      } from "./packages/renderer-extension/src/renderer-credits-control.ts";
      import {
        mountRendererUsageControl,
        renderRendererUsageControl,
      } from "./packages/renderer-extension/src/renderer-usage-control.ts";

      globalThis.setupRendererUsage = () => {
        const toolbar = document.createElement("div");
        toolbar.style.display = "flex";
        toolbar.style.alignItems = "center";
        const plus = document.createElement("button");
        plus.type = "button";
        plus.setAttribute("aria-label", "Add files");
        plus.textContent = "+";
        const model = document.createElement("div");
        model.setAttribute("data-codexhost-model-control", "usage-composer");
        const modelButton = document.createElement("button");
        modelButton.type = "button";
        modelButton.setAttribute("aria-label", "Model: gpt-test");
        modelButton.textContent = "gpt-test";
        model.append(modelButton);
        toolbar.append(plus, model);
        document.body.append(toolbar);

        const usage = mountRendererUsageControl("usage-composer");
        const credits = mountRendererCreditsControl("usage-composer");
        usage.place(model);
        credits.place(plus);
        renderRendererUsageControl(usage, null);
        renderRendererCreditsControl(credits, null);
        globalThis.updateRendererUsage = () => {
          renderRendererUsageControl(usage, {
            cacheHitRatePercent: 99.9,
            cachedInputTokens: 375000,
            cacheWriteInputTokens: 1200,
            inputTokens: 87000,
            outputTokens: 6700,
            totalCostUsd: 0.822,
            contextUsedTokens: 79700,
            contextWindowTokens: 272000,
          });
        };
        globalThis.updateRendererCreditsUsage = () => {
          renderRendererUsageControl(usage, { cacheHitRatePercent: 99.3, totalCostUsd: 0.822 });
          renderRendererCreditsControl(credits, { usedPercent: 47, periodType: "weekly" });
        };
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-usage-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Usage bundle was not generated");

test("renders Usage immediately to the left of the model control", async ({ page }) => {
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererUsage");
    if (typeof setup !== "function") throw new Error("Usage setup is unavailable");
    setup();
  });

  const model = page.locator('[data-codexhost-model-control="usage-composer"]');
  const usage = page.locator('[data-codexhost-usage-control="usage-composer"]');
  await expect(usage).toBeHidden();
  await page.evaluate(() => {
    const update = Reflect.get(globalThis, "updateRendererUsage");
    if (typeof update !== "function") throw new Error("Usage update is unavailable");
    update();
  });
  await expect(usage).toBeVisible();
  await expect(usage).toHaveText("CH 99.9% · $0.822");
  await expect(usage.locator("button")).toHaveAttribute(
    "aria-label",
    "Thread Usage: CH 99.9% · $0.822",
  );
  await expect(usage.locator("button")).toHaveClass(/text-token-text-tertiary/u);
  await expect(usage.locator("svg")).toHaveCount(0);
  const [usageBox, modelBox] = await Promise.all([usage.boundingBox(), model.boundingBox()]);
  if (!usageBox || !modelBox) throw new Error("Usage geometry is unavailable");
  expect(
    Math.abs(usageBox.y + usageBox.height / 2 - (modelBox.y + modelBox.height / 2)),
  ).toBeLessThanOrEqual(2);
  expect(usageBox.width).toBeLessThan(200);
  await expect(usage.locator("xpath=following-sibling::*[1]")).toHaveAttribute(
    "data-codexhost-model-control",
    "usage-composer",
  );
  await expect(model).toHaveText("gpt-test");

  await usage.hover();
  const popover = page.locator('[role="dialog"][aria-label="Thread Usage details"]');
  await expect(popover).toBeVisible();
  const [popoverBox, triggerBox] = await Promise.all([
    popover.boundingBox(),
    usage.locator("button").boundingBox(),
  ]);
  if (!popoverBox || !triggerBox) throw new Error("Usage popover geometry is unavailable");
  expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(triggerBox.y + 1);
  await expect(popover).toContainText("Context");
  await expect(popover).toContainText("29.3% / 272k");
  await expect(popover).toContainText("Latest cache hit");
  await expect(popover).toContainText("Cache read");
  await expect(popover).toContainText("375k");
  await expect(popover).toContainText("Cache write");
  await expect(popover).toContainText("1.2k");
  await expect(popover).toContainText("Input / output");
  await expect(popover).toContainText("87k / 6.7k");
  await expect(popover).toContainText("Session cost estimate");
  await expect(popover).toContainText("$0.822");
});

test("keeps Usage in place and shows credits after the leading composer control", async ({
  page,
}) => {
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererUsage");
    if (typeof setup !== "function") throw new Error("Usage setup is unavailable");
    setup();
    const update = Reflect.get(globalThis, "updateRendererUsage");
    if (typeof update !== "function") throw new Error("Usage update is unavailable");
    update();
  });

  const model = page.locator('[data-codexhost-model-control="usage-composer"]');
  const usage = page.locator('[data-codexhost-usage-control="usage-composer"]');
  const credits = page.locator('[data-codexhost-credits-control="usage-composer"]');
  const trigger = usage.locator("button");
  await expect(usage).toHaveText("CH 99.9% · $0.822");
  await expect(credits).toBeHidden();
  await expect(trigger).toHaveCSS("max-width", "180px");
  await expect(usage.locator("xpath=following-sibling::*[1]")).toHaveAttribute(
    "data-codexhost-model-control",
    "usage-composer",
  );

  await page.evaluate(() => {
    const update = Reflect.get(globalThis, "updateRendererCreditsUsage");
    if (typeof update !== "function") throw new Error("Credits usage update is unavailable");
    update();
  });
  await expect(usage).toHaveText("CH 99.3% · $0.822");
  await expect(credits).toBeVisible();
  await expect(credits).toHaveText("47%");
  await expect(credits.locator("button")).toHaveAttribute("aria-label", "Weekly limit 47%");
  await expect(credits.locator("[data-codexhost-credits-dot]")).toHaveCount(1);
  await expect(trigger).toHaveCSS("max-width", "180px");
  await expect(credits.locator("xpath=preceding-sibling::*[1]")).toHaveAttribute(
    "aria-label",
    "Add files",
  );
  await expect(usage.locator("xpath=following-sibling::*[1]")).toHaveAttribute(
    "data-codexhost-model-control",
    "usage-composer",
  );
  const [creditsBox, usageBox, modelBox] = await Promise.all([
    credits.boundingBox(),
    usage.boundingBox(),
    model.boundingBox(),
  ]);
  if (!creditsBox || !usageBox || !modelBox) throw new Error("Credits geometry is unavailable");
  expect(creditsBox.x + creditsBox.width).toBeLessThanOrEqual(usageBox.x + 1);
  expect(usageBox.x + usageBox.width).toBeLessThanOrEqual(modelBox.x + 1);

  await credits.hover();
  const popover = page.locator('[role="dialog"][aria-label="Account limit details"]');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Weekly limit");
  await expect(popover).toContainText("47%");
});
