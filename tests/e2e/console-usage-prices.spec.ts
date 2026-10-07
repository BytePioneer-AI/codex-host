import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";
import type { HarnessUsageEntry } from "@codexhost/harness-adapter";
import type { ModelPriceOverride } from "@codexhost/shared-contracts";
import { UsageStatistics } from "../../packages/host-runtime/src/usage-statistics.ts";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
test.use({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });

const { outputFiles } = await build({
  stdin: {
    contents: `import { startConsoleApp } from "./packages/renderer-extension/src/console/app.ts";
      startConsoleApp(document);`,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "console-usage-prices-fixture.ts",
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
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Console fixture bundle missing");

/** Noon of 2026-09-18 in the Host's zone (the test runner's), the fixture's "now". */
const NOW = new Date(2026, 8, 18, 12).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function request(id: string, overrides: Partial<HarnessUsageEntry> = {}): HarnessUsageEntry {
  return {
    id,
    occurredAtMs: NOW,
    model: "custom-model",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 2_000_000,
    ...overrides,
  };
}

let cacheRoot: string;
test.beforeEach(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "console-usage-e2e-"));
});
test.afterEach(async () => {
  await rm(cacheRoot, { recursive: true, force: true });
});

/**
 * A console against a Host whose statistics come from the real aggregation over the given
 * entries; prices are the fixture's overrides, so a saved price restates the figures.
 */
async function setup(page: Page) {
  const state = {
    prices: new Map<string, ModelPriceOverride>(),
    /** Entries per Harness; the default is one priced-on-demand request. */
    entries: new Map<string, HarnessUsageEntry[]>([["test-harness", [request("r1")]]]),
    statisticsReads: 0,
    lastParams: {} as Record<string, unknown>,
    priceReads: 0,
    writes: 0,
    polling: false,
    oldHost: false,
    failRead: false,
    failWrite: false,
    invalidFile: false,
    defaultAvailable: true,
    beforeRead: () => Promise.resolve(),
    beforeWrite: () => Promise.resolve(),
  };
  const statistics = new UsageStatistics({
    directory: cacheRoot,
    now: () => NOW,
    prices: {
      missing: () => undefined,
      lookup: async () => ({
        find: (model: string) => {
          const price = state.prices.get(model);
          return price ? { cacheRead: 0, cacheWrite: 0, ...price } : null;
        },
      }),
    } as never,
  });
  statistics.attach(() =>
    [...state.entries].map(([harness, entries]) => ({
      harness,
      capability: {
        listSources: async () => [{ id: harness, fingerprint: JSON.stringify(entries) }],
        readSource: async () => entries,
      },
    })),
  );
  await page.route("http://console.test/**", async (route) => {
    const url = new URL(route.request().url());
    let value: unknown = {};
    if (url.pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
      return;
    }
    if (url.pathname === "/api/overview") {
      value = {
        console: { version: "test", distribution: null },
        inspect: { runtime: { running: true }, desktop: null },
        startup: [],
        controller: null,
        summary: { state: "running", detail: null },
        launchAvailable: false,
        issueUrl: "",
        hostAvailable: true,
      };
    } else if (url.pathname === "/api/announcement") {
      value = null;
    } else if (url.pathname === "/api/host/request") {
      const { method, params } = route.request().postDataJSON();
      let result: unknown = {};
      if (method === "codexhost/usage/statistics/get") {
        state.statisticsReads++;
        state.lastParams = params;
        await statistics.get(params);
        await statistics.settled();
        const fresh = await statistics.get(params);
        result = state.oldHost
          ? { range: params.range, from: null, to: "2026-09-18", rows: [] }
          : {
              ...fresh,
              reading: state.polling ? { complete: false, sources: 2, read: 1 } : fresh.reading,
            };
      } else if (method === "codexhost/usage/model-prices/get") {
        state.priceReads++;
        await state.beforeRead();
        if (state.failRead) {
          await route.fulfill({ json: { error: { code: -32603, message: "price read failed" } } });
          return;
        }
        // Deliberately overlap price and statistics reads: one must not cancel the other.
        await new Promise((resolve) => setTimeout(resolve, 100));
        result = priceView();
      } else if (method === "codexhost/usage/model-prices/default") {
        result = {
          price: state.defaultAvailable
            ? { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
            : null,
        };
      } else if (method === "codexhost/usage/model-prices/set") {
        state.writes++;
        await state.beforeWrite();
        if (state.failWrite) {
          await route.fulfill({ json: { error: { code: -32603, message: "price write failed" } } });
          return;
        }
        if (params.previousKey) state.prices.delete(params.previousKey);
        if (params.price === null) state.prices.delete(params.key);
        else state.prices.set(params.key, params.price);
        result = priceView();
      } else if (method === "codexhost/harness/plugins/list") {
        result = { plugins: [] };
      }
      value = { result };
    }
    await route.fulfill({ json: value });
  });
  function priceView() {
    return {
      path: "/isolated/pricing.json",
      entries: [...state.prices].map(([key, price]) => ({ key, price })),
      error: state.invalidFile ? "invalid JSON" : null,
    };
  }
  await page.goto("http://console.test/");
  await page.addScriptTag({ content: bundle });
  return state;
}

async function openStatistics(page: Page) {
  const navigation = page.getByRole("navigation", { name: "设置分类" });
  await expect(navigation.getByRole("button", { name: "模型价格", exact: true })).toHaveCount(0);
  await navigation.getByRole("button", { name: "用量统计", exact: true }).click();
  await expect(page.getByRole("heading", { name: "按模型", exact: true })).toBeVisible();
}

const modelInput = (page: Page) => page.getByRole("textbox", { name: "模型 ID", exact: true });
const inputPrice = (page: Page) => page.getByRole("textbox", { name: "输入", exact: true });
const outputPrice = (page: Page) => page.getByRole("textbox", { name: "输出", exact: true });
const tile = (page: Page, key: string) => page.locator(`.console-usage-tile[data-tile="${key}"]`);
const tileValue = (page: Page, key: string) => tile(page, key).locator("strong");
const group = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const modelFilter = (page: Page) => page.getByRole("button", { name: "按模型筛选", exact: true });
const projectFilter = (page: Page) => page.getByRole("button", { name: "按项目筛选", exact: true });
const table = (page: Page, heading: string) =>
  page
    .locator("section.console-panel")
    .filter({ has: page.getByRole("heading", { name: heading }) });

async function choose(page: Page, filter: ReturnType<typeof modelFilter>, option: string) {
  await filter.click();
  const list = page.getByRole("listbox", { name: (await filter.getAttribute("aria-label")) ?? "" });
  // A project option is named by its folder, followed by its full path.
  await list
    .getByRole("option", { name: new RegExp(`^${option}\\b`) })
    .first()
    .click();
}

test("row dialog saves prices without a header entry and preserves filters and a polling draft", async ({
  page,
}) => {
  const state = await setup(page);
  state.polling = true;
  state.defaultAvailable = false;
  await openStatistics(page);
  await expect(page.locator("details.console-model-prices")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "模型价格", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.priceReads).toBe(0);
  await page.getByRole("button", { name: "7 天", exact: true }).click();
  await group(page, "Harness").getByRole("button", { name: "test-harness" }).click();
  await choose(page, modelFilter(page), "custom-model");
  await group(page, "趋势").getByRole("button", { name: "Token", exact: true }).click();
  const url = page.url();
  await page.getByRole("button", { name: "设置价格", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "模型价格" })).toBeVisible();
  await expect(modelInput(page)).toHaveValue("custom-model");
  await expect(modelInput(page)).not.toBeEditable();
  await expect(page.getByRole("heading", { name: /自定义价格|已保存价格/ })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "添加价格", exact: true })).not.toBeVisible();
  await inputPrice(page).click();
  await inputPrice(page).pressSequentially("2");
  await outputPrice(page).click();
  await outputPrice(page).pressSequentially("3");
  await expect(page.getByText("默认价格表中没有该模型。", { exact: true })).toBeVisible();
  const before = state.statisticsReads;
  await expect.poll(() => state.statisticsReads).toBeGreaterThan(before);
  await expect(inputPrice(page)).toHaveValue("2");
  state.polling = false;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(modelInput(page)).toHaveCount(0);
  await expect(tileValue(page, "cost")).toHaveText("$8.00");
  await expect(page.getByRole("button", { name: "设置价格", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "7 天", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    group(page, "趋势").getByRole("button", { name: "Token", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(modelFilter(page)).toHaveText("custom-model");
  await expect(
    group(page, "Harness").getByRole("button", { name: "test-harness" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(state.lastParams).toEqual({ range: "7d", harness: "test-harness", model: "custom-model" });
  expect(page.url()).toBe(url);
  expect(state.prices.get("custom-model")).toEqual({ input: 2, output: 3 });
});

test("cancel and Escape discard the draft and restore focus to the row", async ({ page }) => {
  const state = await setup(page);
  await openStatistics(page);
  const action = page.getByRole("button", { name: "设置价格", exact: true });
  await action.click();
  await expect(inputPrice(page)).toBeFocused();
  await expect(page.getByText(/作用范围|配置文件|远程 Host|\/isolated\/pricing\.json/)).toHaveCount(
    0,
  );
  await inputPrice(page).fill("999");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(action).toBeFocused();
  await action.click();
  await expect(inputPrice(page)).toHaveValue("");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes).toBe(0);
});

test("a late read from a cancelled dialog cannot replace a reopened draft", async ({ page }) => {
  const state = await setup(page);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.beforeRead = () => (state.priceReads === 1 ? pending : Promise.resolve());
  await openStatistics(page);
  const action = page.getByRole("button", { name: "设置价格", exact: true });
  await action.click();
  await expect.poll(() => state.priceReads).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await action.click();
  await inputPrice(page).fill("9");
  const response = page.waitForResponse(
    (value) => value.request().postData()?.includes("model-prices/get") === true,
  );
  release();
  await response;
  await expect(inputPrice(page)).toHaveValue("9");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(state.writes).toBe(0);
});

test("unknown model buckets have no price action", async ({ page }) => {
  const state = await setup(page);
  state.entries.set("test-harness", [request("r1", { model: undefined })]);
  await openStatistics(page);
  await expect(page.getByRole("button", { name: /设置价格|编辑价格|模型价格/ })).toHaveCount(0);
  expect(state.priceReads).toBe(0);
});

test("priced rows can edit existing prices, fill defaults and confirm removal in the dialog", async ({
  page,
}) => {
  const state = await setup(page);
  state.prices.set("custom-model", { input: 4, output: 5, cacheWrite1h: 0 });
  await openStatistics(page);
  await page.getByRole("button", { name: "编辑价格", exact: true }).click();
  await expect(inputPrice(page)).toHaveValue("4");
  await expect(page.getByRole("textbox")).toHaveCount(5); // Model ID and four editable prices.
  await expect(page.getByText(/1 小时缓存写入|1h cache write/)).toHaveCount(0);
  await page.getByRole("button", { name: "填入默认价格", exact: true }).click();
  await expect(inputPrice(page)).toHaveValue("1");
  await expect(outputPrice(page)).toHaveValue("2");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(tileValue(page, "cost")).toHaveText("$5.00");
  expect(state.prices.get("custom-model")?.cacheWrite1h).toBe(0);
  await expect(page.getByText(/1 小时缓存写入|1h cache write/)).toHaveCount(0);
  await page.getByRole("button", { name: "编辑价格", exact: true }).click();
  await expect(inputPrice(page)).toHaveValue("1");
  await page.getByRole("button", { name: "移除", exact: true }).click();
  expect(state.prices.has("custom-model")).toBe(true);
  await page.getByRole("button", { name: "移除", exact: true }).click();
  await expect(page.getByRole("button", { name: "设置价格", exact: true })).toBeVisible();
  expect(state.prices.has("custom-model")).toBe(false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("pending saves block Escape and duplicate submissions, then close and refresh", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await setup(page);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.beforeWrite = () => pending;
  await openStatistics(page);
  await page.getByRole("button", { name: "设置价格", exact: true }).click();
  await expect(modelInput(page)).toHaveValue("custom-model");
  await inputPrice(page).fill("2");
  await outputPrice(page).fill("3");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => state.writes).toBe(1);
  await expect(page.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await expect(modelInput(page)).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(state.writes).toBe(1);
  release();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tileValue(page, "cost")).toHaveText("$8.00");
  expect(errors).toEqual([]);
});

test("price failures do not block statistics or discard the draft, and invalid files stay read-only", async ({
  page,
}) => {
  const state = await setup(page);
  state.failRead = true;
  await openStatistics(page);
  await page.getByRole("button", { name: "设置价格", exact: true }).click();
  await expect(page.getByText("price read failed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("heading", { name: "趋势", exact: true })).toBeVisible();
  state.failRead = false;
  await page.getByRole("button", { name: "设置价格", exact: true }).click();
  await expect(modelInput(page)).toHaveValue("custom-model");
  await inputPrice(page).fill("2");
  await outputPrice(page).fill("3");
  state.failWrite = true;
  const before = state.statisticsReads;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("price write failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  await expect(inputPrice(page)).toHaveValue("2");
  expect(state.statisticsReads).toBe(before);
  expect(state.prices.size).toBe(0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  state.invalidFile = true;
  await page.getByRole("navigation").getByRole("button", { name: "总览", exact: true }).click();
  await openStatistics(page);
  await page.getByRole("button", { name: "设置价格", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "invalid JSON" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await expect(modelInput(page)).toHaveCount(0);
});

// --- Dashboard -------------------------------------------------------------------------------

const HARNESSES = ["pi", "codex", "claude-code", "grok", "zcode", "opencode", "omp"];
const PROJECTS = ["/work/app", "/work/lib", "/tmp/wt-1/app"];

/**
 * Thirty days of usage across seven Harnesses, three projects and a handful of sessions, all
 * priced except one unknown model on Pi, plus a cache-heavy request mix.
 */
async function setupDashboard(page: Page) {
  const state = await setup(page);
  state.prices.set("custom-model", { input: 1, output: 1 });
  state.prices.set("gpt-6", { input: 2, output: 8, cacheRead: 0.2 });
  state.prices.set("claude-sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  state.entries = new Map();
  HARNESSES.forEach((harness, index) => {
    const entries: HarnessUsageEntry[] = [];
    for (let day = 0; day < 30; day++) {
      if (day % 4 === 3) continue;
      const scale = ((day % 7) + 1) * (HARNESSES.length - index);
      entries.push(
        request(`${harness}-${day}`, {
          occurredAtMs: NOW - day * DAY - (index + day) * HOUR,
          model: index === 2 ? "claude-sonnet" : "gpt-6",
          inputTokens: 900_000 * scale,
          cachedInputTokens: 800_000 * scale,
          cacheWriteInputTokens: 50_000 * scale,
          outputTokens: 10_000 * scale,
          sessionId: `${harness}-s${day % 3}`,
          cwd: PROJECTS[(index + day) % PROJECTS.length] ?? "/work/app",
        }),
      );
    }
    state.entries.set(harness, entries);
  });
  state.entries.get("pi")?.push(
    request("pi-unknown", {
      model: "mystery-model",
      inputTokens: 1_000,
      outputTokens: 1_000,
      sessionId: "pi-s0",
      cwd: "/work/app",
    }),
  );
  return state;
}

test("tokens leave cache reads and writes out, and the cache has its own tile", async ({
  page,
}) => {
  const state = await setup(page);
  state.prices.set("custom-model", { input: 1, output: 1 });
  state.entries.set("test-harness", [
    request("cached", {
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      cacheWriteInputTokens: 50_000,
      outputTokens: 10_000,
    }),
    // Its cache split is unknown: its input counts whole, and the tile says so.
    request("unknown-cache", {
      inputTokens: 5_000,
      cachedInputTokens: undefined,
      cacheWriteInputTokens: undefined,
      outputTokens: 0,
    }),
  ]);
  await openStatistics(page);
  await expect(tile(page, "tokens")).toContainText("不含缓存读取与写入");
  await expect(tileValue(page, "tokens")).toHaveText("165K");
  await expect(tile(page, "tokens")).toContainText("输入 155K · 输出 10K");
  await expect(tile(page, "tokens")).toContainText("5K 输入的缓存情况未知");
  await expect(tileValue(page, "cache")).toHaveText("800K");
  await expect(tile(page, "cache")).toContainText("命中率 80% · 写入 50K");
});

test("the model filter tells all models from the unknown model and searches", async ({ page }) => {
  const state = await setupDashboard(page);
  state.entries.get("pi")?.push(request("no-model", { model: undefined }));
  await openStatistics(page);
  await expect(modelFilter(page)).toHaveText("全部模型");
  await modelFilter(page).click();
  await page.getByRole("searchbox", { name: "搜索…" }).fill("未知");
  await expect(page.getByRole("listbox", { name: "按模型筛选" }).getByRole("option")).toHaveText([
    "未知模型",
  ]);
  await page.keyboard.press("Enter");
  await expect(modelFilter(page)).toHaveText("未知模型");
  expect(state.lastParams).toMatchObject({ model: null });
  await expect(tileValue(page, "requests")).toHaveText("1");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(modelFilter(page)).toHaveText("全部模型");
  expect(state.lastParams).not.toHaveProperty("model");
});

test("rows filter, sort, fold and show shares; unpriced rows are marked; the view is remembered", async ({
  page,
}) => {
  const state = await setupDashboard(page);
  await openStatistics(page);
  await expect(page.locator(".console-usage-tile")).toHaveCount(6);
  const harnesses = table(page, "按 Harness");
  // Seven Harnesses fold to six rows and a "1 more" button.
  await expect(harnesses.locator("tbody tr")).toHaveCount(6);
  await harnesses.getByRole("button", { name: "还有 1 个" }).click();
  await expect(harnesses.locator("tbody tr")).toHaveCount(7);
  await expect(harnesses.locator(".console-usage-share__value").first()).toHaveText(/\d+%/);
  // Sort by input, ascending on the second click.
  const sortInput = harnesses.getByRole("button", { name: /^输入/ });
  await sortInput.click();
  await expect(harnesses.locator("thead th[aria-sort]")).toHaveAttribute("aria-sort", "descending");
  await expect(harnesses.locator("tbody tr").first()).toContainText("pi");
  await sortInput.click();
  await expect(harnesses.locator("thead th[aria-sort]")).toHaveAttribute("aria-sort", "ascending");
  await expect(harnesses.locator("tbody tr").first()).toContainText("omp");

  // The unpriced model shows a badge instead of a share when measuring cost.
  const models = table(page, "按模型");
  await expect(models.locator("tbody tr").filter({ hasText: "mystery-model" })).toContainText(
    "未计价",
  );

  await harnesses.getByRole("button", { name: "codex", exact: true }).click();
  expect(state.lastParams).toMatchObject({ harness: "codex" });
  await expect(group(page, "Harness").getByRole("button", { name: "codex" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(harnesses.locator("tbody tr")).toHaveCount(1);
  await group(page, "趋势").getByRole("button", { name: "Token", exact: true }).click();
  await page.getByRole("button", { name: "90 天", exact: true }).click();

  await page.getByRole("navigation").getByRole("button", { name: "总览", exact: true }).click();
  await openStatistics(page);
  await expect(group(page, "Harness").getByRole("button", { name: "codex" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "90 天", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    group(page, "趋势").getByRole("button", { name: "Token", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // Clicking the selected row again clears its filter.
  await table(page, "按 Harness").getByRole("button", { name: "codex", exact: true }).click();
  await expect(
    group(page, "Harness").getByRole("button", { name: "全部 Harness" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("the unpriced link narrows the model table to what needs a price", async ({ page }) => {
  await setupDashboard(page);
  await openStatistics(page);
  await tile(page, "cost")
    .getByRole("button", { name: /次未计价/ })
    .click();
  const toggle = page.getByRole("button", { name: "只看未计价", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toBeFocused();
  await expect(table(page, "按模型").locator("tbody tr")).toHaveCount(1);
  await toggle.click();
  await expect(table(page, "按模型").locator("tbody tr")).toHaveCount(3);
});

test("the trend stacks Harnesses, labels its axes, and selects a day by click or keyboard", async ({
  page,
}) => {
  const state = await setupDashboard(page);
  await openStatistics(page);
  const legend = page.locator(".console-usage-legend__item");
  // Five series: the four largest Harnesses and "Others".
  await expect(legend).toHaveCount(5);
  await expect(legend.last()).toHaveText("其他");
  const chart = page.locator(".console-usage-chart-wrap");
  await expect(chart.locator(".console-usage-chart__grid")).toHaveCount(2);
  await expect(chart.locator("text.console-usage-chart__label").last()).toHaveText("9月18日");
  const box = await chart.boundingBox();
  if (!box) throw new Error("chart not laid out");
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  const tooltip = chart.locator(".console-usage-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("2026年9月18日");
  await expect(tooltip).toContainText("请求");
  await page.screenshot({ path: test.info().outputPath("dashboard.png"), fullPage: true });

  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await expect.poll(() => state.lastParams.date).toBe("2026-09-18");
  await expect(page.getByRole("button", { name: /2026年9月18日/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "按小时", exact: true })).toBeVisible();
  // Keyboard: one day back, Enter selects it; Escape returns to the range.
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect.poll(() => state.lastParams.date).toBe("2026-09-17");
  await expect(chart).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => state.lastParams.date).toBeUndefined();
  await expect(page.getByRole("heading", { name: "按时段", exact: true })).toBeVisible();
  await expect(page.locator(".console-usage-heatmap__cell")).toHaveCount(168);

  // A legend entry filters to its Harness.
  // Series follow the measure: by cost, the Harness on the priciest model leads.
  await expect(legend.first()).toHaveText("claude-code");
  await legend.first().click();
  await expect.poll(() => state.lastParams.harness).toBe("claude-code");
  await expect(page.locator(".console-usage-legend__item")).toHaveCount(0);

  await group(page, "趋势").getByRole("button", { name: "周", exact: true }).click();
  await expect(chart.locator(".console-usage-chart__column")).toHaveCount(5);
});

test("tiles compare with the previous period; projects, sessions and CSV follow the filters", async ({
  page,
}) => {
  const state = await setupDashboard(page);
  await openStatistics(page);
  await page.getByRole("button", { name: "7 天", exact: true }).click();
  await expect(tile(page, "cost").locator(".console-usage-delta")).toHaveText(/较上一周期 [↑↓→]/);
  await expect(tile(page, "cost").locator(".console-usage-delta")).toHaveAttribute(
    "title",
    /上一周期 9月5日 – 9月11日/,
  );
  await expect(tileValue(page, "projects")).toHaveText("3");
  await expect(tile(page, "sessions")).toContainText("中位");

  // Two projects share a folder name: they are told apart by their parent.
  const projects = table(page, "按项目");
  await expect(projects.getByRole("button", { name: "work/app", exact: true })).toBeVisible();
  await expect(projects.getByRole("button", { name: "wt-1/app", exact: true })).toBeVisible();
  await choose(page, projectFilter(page), "lib");
  expect(state.lastParams).toMatchObject({ project: "/work/lib" });
  await expect(projectFilter(page)).toHaveText("lib");

  const sessions = table(page, "最耗会话");
  await expect(sessions.locator("tbody tr").first()).toContainText("lib");
  await expect(sessions.locator("thead")).toContainText("最近活跃");

  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("codexhost-usage-7d-2026-09-18.csv");
  const csv = await readFile((await file.path()) ?? "", "utf8");
  expect(csv.split("\n")[0]).toBe(
    "date,harness,requests,input_without_cache,cache_read,cache_write,output,reasoning,cost_usd,unpriced_requests",
  );
  expect(csv).toContain("2026-09-18,");
});

test("refreshes keep focus and the chart's hover, and say when they happened", async ({ page }) => {
  const state = await setupDashboard(page);
  state.polling = true;
  await openStatistics(page);
  await expect(page.locator(".console-usage-updated")).toHaveText("更新于刚刚");
  const sort = table(page, "按 Harness").getByRole("button", { name: /^请求/ });
  await sort.focus();
  const reads = state.statisticsReads;
  await expect.poll(() => state.statisticsReads, { timeout: 10_000 }).toBeGreaterThan(reads + 1);
  await expect(table(page, "按 Harness").getByRole("button", { name: /^请求/ })).toBeFocused();

  const chart = page.locator(".console-usage-chart-wrap");
  const box = await chart.boundingBox();
  if (!box) throw new Error("chart not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(chart.locator(".console-usage-tooltip")).toBeVisible();
  const again = state.statisticsReads;
  await expect.poll(() => state.statisticsReads, { timeout: 10_000 }).toBeGreaterThan(again);
  await expect(page.locator(".console-usage-chart-wrap .console-usage-tooltip")).toBeVisible();

  state.polling = false;
  const auto = page.getByRole("button", { name: "自动刷新", exact: true });
  await expect(auto).toHaveText("自动刷新 · 关闭");
  await auto.click();
  const menu = page.getByRole("listbox", { name: "自动刷新" });
  await expect(menu).toBeFocused();
  await expect(menu.getByRole("option", { selected: true })).toHaveText("关闭");
  await page.screenshot({ path: test.info().outputPath("auto-refresh-menu.png") });
  // Keyboard: down to "every 30 seconds", Enter chooses it and closes the menu.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(auto).toHaveText("自动刷新 · 每 30 秒");
  await expect(auto).toBeFocused();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.locator(".console-usage-updated")).toHaveText("更新于刚刚");
});

test("an older Host is reported instead of a broken page", async ({ page }) => {
  const state = await setup(page);
  state.oldHost = true;
  const navigation = page.getByRole("navigation", { name: "设置分类" });
  await navigation.getByRole("button", { name: "用量统计", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(/请重启 codexhost/);
});
