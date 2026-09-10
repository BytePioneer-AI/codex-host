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
        let exactRefreshes = 0;
        usage.onOpen = () => { exactRefreshes += 1; };
        globalThis.rendererUsageExactRefreshes = () => exactRefreshes;
        globalThis.updateKiroUsage = (value) => renderRendererUsageControl(usage, value, "zh-CN");
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
          renderRendererCreditsControl(credits, {
            usedPercent: 47,
            periodType: "weekly",
            resetsAt: "2026-08-31T16:00:00.000Z",
            productUsage: [
              { product: "GrokBuild", usagePercent: 82, resetsAt: "2027-03-15T10:00:00.000Z" },
              { product: "GrokChat", usagePercent: 45 },
            ],
          });
        };
        globalThis.updateRendererCreditsChinese = () => {
          renderRendererCreditsControl(credits, {
            usedPercent: 27,
            periodType: "five_hour",
            resetsAt: "2026-08-31T16:00:00.000Z",
            productUsage: [
              { product: "7-day window", usagePercent: 73, resetsAt: "2026-09-05T18:00:00.000Z" },
            ],
          }, "zh-CN");
        };
        globalThis.updateRendererUsagePlanWindow = () => {
          renderRendererUsageControl(usage, {
            cacheHitRatePercent: 99,
            totalCostUsd: 1.373,
            planFiveHourUsedPercent: 45,
            planSevenDayUsedPercent: 12,
            planFiveHourResetsAtUnix: 1_756_130_400,
          });
        };
        globalThis.updateRendererUsageChinese = () => {
          renderRendererUsageControl(usage, {
            cacheHitRatePercent: 92.9,
            cachedInputTokens: 482800,
            cacheWriteInputTokens: 0,
            totalTokens: 552700,
            inputTokens: 62300,
            outputTokens: 7600,
            totalCostUsd: 0.780,
            contextUsedTokens: 57664,
            contextWindowTokens: 272000,
          }, "zh-CN");
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

for (const width of [1280, 375]) {
  test(`Kiro credits and context popover at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 600 });
    await page.setContent(
      '<!doctype html><body style="margin:12px;padding-top:280px;color-scheme:dark;background:#222;color:white;font:14px system-ui"></body>',
    );
    await page.addScriptTag({ content: browserBundle });
    await page.evaluate(() => {
      const setup = Reflect.get(globalThis, "setupRendererUsage");
      setup();
      const update = Reflect.get(globalThis, "updateKiroUsage");
      update({ totalCredits: 0.058778444510779446, contextUsagePercent: 9.594499588012695 });
    });
    const usage = page.locator('[data-codexhost-usage-control="usage-composer"]');
    await expect(usage).toBeVisible();
    await expect(usage).toHaveText("0.059 credits");
    await expect(usage.locator("svg")).toHaveCount(0);
    await expect(usage.locator("button")).toHaveAttribute(
      "aria-label",
      "对话用量: 0.059 credits; 上下文 9.6%",
    );
    await usage.hover();
    const popover = page.getByRole("dialog", { name: "对话用量详情" });
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("已记录消耗");
    await expect(popover).toContainText("0.059 credits");
    await expect(popover).toContainText("上下文");
    await expect(popover).toContainText("9.6%");
    await expect(popover.locator(":scope > div").nth(1)).toContainText("上下文");
    await expect(popover.locator(":scope > div").last()).toContainText("已记录消耗");
    const clipped = await usage
      .locator("span")
      .first()
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(clipped).toBe(false);
    for (const unavailable of ["$", "输入 / 输出", "缓存读取", "缓存写入", "会话费用估算"]) {
      await expect(popover).not.toContainText(unavailable);
    }
    const box = await popover.boundingBox();
    if (!box) throw new Error("Usage popover has no bounds");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath("kiro-usage.png") });
    await page.evaluate(() => Reflect.get(globalThis, "updateKiroUsage")(null));
    await expect(usage).toBeHidden();
    await expect(popover).toBeHidden();
  });
}

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
  await expect
    .poll(() =>
      page.evaluate(() => {
        const reads = Reflect.get(globalThis, "rendererUsageExactRefreshes");
        return typeof reads === "function" ? reads() : -1;
      }),
    )
    .toBe(1);
  await usage.hover();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const reads = Reflect.get(globalThis, "rendererUsageExactRefreshes");
        return typeof reads === "function" ? reads() : -1;
      }),
    )
    .toBe(1);
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
  await expect(credits).toHaveText("53%");
  await expect(credits.locator("button")).toHaveAttribute("aria-label", "Weekly limit 53%");
  await expect(credits.locator("[data-codexhost-credits-ring] svg")).toHaveCount(1);
  await expect(trigger).toHaveCSS("max-width", "180px");
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
  await expect(popover).toContainText("Remaining 53%");
  await expect(popover).toContainText("Build");
  await expect(popover).toContainText("Remaining 18%");
  await expect(popover).toContainText("Chat");
  // The headline percent gets its own progress bar too, alongside each product's.
  await expect(popover.locator("[data-codexhost-credits-bar]")).toHaveCount(3);
  // One "Resets" line under the headline, one under the Build tile (Chat has none).
  await expect(popover.getByText("Resets", { exact: false })).toHaveCount(2);
});

test("renders remaining five-hour and seven-day credits clearly in Chinese", async ({ page }) => {
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererUsage");
    if (typeof setup !== "function") throw new Error("Usage setup is unavailable");
    setup();
    const update = Reflect.get(globalThis, "updateRendererCreditsChinese");
    if (typeof update !== "function") throw new Error("Chinese Credits update is unavailable");
    update();
  });

  const credits = page.locator('[data-codexhost-credits-control="usage-composer"]');
  await expect(credits).toHaveText("73%");
  await credits.hover();
  const popover = page.locator('[role="dialog"][aria-label="账号额度详情"]');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("5 小时额度");
  await expect(popover).toContainText("剩余 73%");
  await expect(popover).toContainText("7 天额度");
  await expect(popover).toContainText("剩余 27%");
  await expect(popover.getByText("重置", { exact: false })).toHaveCount(2);
  await expect(popover).not.toContainText("5-hour limit");
  await expect(popover).not.toContainText("7-day window");
});

test("renders the Usage popover in Chinese when the settings locale is Chinese", async ({
  page,
}) => {
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererUsage");
    if (typeof setup !== "function") throw new Error("Usage setup is unavailable");
    setup();
    const update = Reflect.get(globalThis, "updateRendererUsageChinese");
    if (typeof update !== "function") throw new Error("Chinese Usage update is unavailable");
    update();
  });

  const usage = page.locator('[data-codexhost-usage-control="usage-composer"]');
  await expect(usage.locator("button")).toHaveAttribute(
    "aria-label",
    "对话用量: CH 92.9% · $0.780",
  );
  await usage.hover();
  const popover = page.locator('[role="dialog"][aria-label="对话用量详情"]');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("用量");
  await expect(popover).toContainText("上下文");
  await expect(popover).toContainText("最近缓存命中率");
  await expect(popover).toContainText("缓存读取");
  await expect(popover).toContainText("缓存写入");
  await expect(popover).toContainText("Token 总数");
  await expect(popover).toContainText("输入 / 输出");
  await expect(popover).toContainText("会话费用估算");
  await expect(popover).not.toContainText("Latest cache hit");
});

test("omits plan limits from the Usage trigger and popover", async ({ page }) => {
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererUsage");
    if (typeof setup !== "function") throw new Error("Usage setup is unavailable");
    setup();
    const update = Reflect.get(globalThis, "updateRendererUsagePlanWindow");
    if (typeof update !== "function") throw new Error("Plan window update is unavailable");
    update();
  });

  const usage = page.locator('[data-codexhost-usage-control="usage-composer"]');
  await expect(usage).toBeVisible();
  await expect(usage).toHaveText("CH 99% · $1.373");
  await expect(usage).not.toContainText("5-hour");
  await expect(usage).not.toContainText("45%");

  await usage.hover();
  const popover = page.locator('[role="dialog"][aria-label="Thread Usage details"]');
  await expect(popover).toBeVisible();
  await expect(popover).not.toContainText("5-hour limit");
  await expect(popover).not.toContainText("45%");
  await expect(popover).not.toContainText("12%");
  await expect(popover).not.toContainText("7-day limit");
});
