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
        mountRendererUsageControl,
        renderRendererUsageControl,
      } from "./packages/renderer-extension/src/renderer-usage-control.ts";

      globalThis.setupRendererUsage = () => {
        const toolbar = document.createElement("div");
        toolbar.style.display = "flex";
        toolbar.style.alignItems = "center";
        const anchor = document.createElement("button");
        anchor.type = "button";
        anchor.setAttribute("aria-label", "Context window usage");
        anchor.textContent = "native context";
        const nativeWrapper = document.createElement("span");
        nativeWrapper.append(anchor);
        toolbar.append(nativeWrapper);
        document.body.append(toolbar);

        const control = mountRendererUsageControl("usage-composer");
        control.place(anchor);
        renderRendererUsageControl(control, null);
        globalThis.updateRendererUsage = () => {
          renderRendererUsageControl(control, {
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

test("renders Usage immediately to the left of the native context control", async ({ page }) => {
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererUsage");
    if (typeof setup !== "function") throw new Error("Usage setup is unavailable");
    setup();
  });

  const anchor = page.locator('button[aria-label="Context window usage"]');
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
  const [usageBox, anchorBox] = await Promise.all([usage.boundingBox(), anchor.boundingBox()]);
  if (!usageBox || !anchorBox) throw new Error("Usage geometry is unavailable");
  expect(
    Math.abs(usageBox.y + usageBox.height / 2 - (anchorBox.y + anchorBox.height / 2)),
  ).toBeLessThanOrEqual(2);
  expect(usageBox.width).toBeLessThan(200);
  await expect(
    usage.locator("xpath=following-sibling::*[1]").locator('[aria-label="Context window usage"]'),
  ).toHaveCount(1);
  await expect(anchor).toHaveAttribute("aria-label", "Context window usage");
  await expect(anchor).toHaveText("native context");

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
