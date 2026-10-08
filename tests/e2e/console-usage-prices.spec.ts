import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";
import type { HarnessUsageEntry } from "@codexhost/harness-adapter";
import type { ModelPriceOverride, ModelPriceSuggestion } from "@codexhost/shared-contracts";
import { UsageStatistics } from "../../packages/host-runtime/src/usage-statistics.js";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
// Worker-scoped options must stay at file scope; keep visible scrollbars and the custom binary.
test.use({
  launchOptions: {
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
    ignoreDefaultArgs: ["--hide-scrollbars"],
  },
});
test.use({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });

const { outputFiles } = await build({
  stdin: {
    contents: `import { startConsoleApp } from "./packages/renderer-extension/src/console/app.ts";
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      if (location.pathname === "/desktop") {
        const local = { hostId: "local", manager: {
          async sendRequest(method, params) {
            const response = await fetch("/api/host/request", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ method, params }),
            });
            const value = await response.json();
            if (value.error) throw new Error(value.error.message);
            return value.result;
          },
        } };
        const remote = { hostId: "remote", manager: {
          sendRequest() { throw new Error("Statistics must not use the active remote Host"); },
        } };
        window.__codexhostHostRoutingV1 = {
          forHost: (id) => id === "local" ? local : remote,
          current: () => remote,
          knownHostIds: () => ["local", "remote"],
        };
        installRendererBindingProbe();
      } else startConsoleApp(document);`,
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

function unmodeledRequest(id: string): HarnessUsageEntry {
  const entry = request(id);
  delete entry.model;
  return entry;
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
async function setup(page: Page, surface: "console" | "desktop" = "console") {
  const state = {
    prices: new Map<string, ModelPriceOverride>(),
    /** Entries per Harness; the default is one priced-on-demand request. */
    entries: new Map<string, HarnessUsageEntry[]>([["test-harness", [request("r1")]]]),
    modelLabels: new Map<string, Record<string, string>>(),
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
    suggestions: [] as ModelPriceSuggestion[],
    beforeDefault: () => Promise.resolve(),
    beforeRead: () => Promise.resolve(),
    beforeWrite: () => Promise.resolve(),
  };
  const statistics = new UsageStatistics({
    directory: cacheRoot,
    now: () => NOW,
    prices: {
      missing: () => undefined,
      lookup: async () => ({
        userPrice: (model: string) => {
          const price = state.prices.get(model);
          return price ? { cacheRead: 0, cacheWrite: 0, ...price } : null;
        },
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
        readModelLabels: async () => state.modelLabels.get(harness) ?? {},
      },
    })),
  );
  await page.route("http://console.test/**", async (route) => {
    const url = new URL(route.request().url());
    let value: unknown = {};
    if (url.pathname === "/" || url.pathname === "/desktop") {
      await route.fulfill({
        contentType: "text/html",
        body:
          surface === "desktop"
            ? `<!doctype html><html><head><style>
              body { margin: 0; display: flex; height: 100vh; }
              nav { width: 56px; display: flex; flex-direction: column; }
              nav button { width: 36px; height: 36px; }
              main { flex: 1; }
            </style></head><body>
              <nav data-app-navigation-rail><div>
                <button data-sidebar-destination="builtin:home" aria-current="page">H</button>
              </div></nav><main>Native content</main>
            </body></html>`
            : "<!doctype html><html><body></body></html>",
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
        await state.beforeDefault();
        result = {
          suggestions: state.suggestions,
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
  await page.goto(surface === "desktop" ? "http://console.test/desktop" : "http://console.test/");
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

async function expectTokenColumns(page: Page) {
  const layout = await tile(page, "tokens")
    .locator("[data-token-part]")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const column = node.getBoundingClientRect();
        const label = node
          .querySelector(".console-usage-tile__part-label")
          ?.getBoundingClientRect();
        const value = node
          .querySelector(".console-usage-tile__part-value")
          ?.getBoundingClientRect();
        return {
          top: column.top,
          width: column.width,
          labelAbove: !!label && !!value && label.bottom <= value.top,
          valueFits: !!value && value.left >= column.left && value.right <= column.right,
        };
      }),
    );
  expect(layout).toHaveLength(3);
  expect(layout.every((column) => column.labelAbove && column.valueFits)).toBe(true);
  expect(
    Math.max(...layout.map((column) => column.top)) -
      Math.min(...layout.map((column) => column.top)),
  ).toBeLessThan(1);
  expect(
    Math.max(...layout.map((column) => column.width)) -
      Math.min(...layout.map((column) => column.width)),
  ).toBeLessThan(1);
}
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

test("built-in settings reuse statistics, filters and prices through the local Host", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await setup(page, "desktop");
  await page.locator("[data-codexhost-settings-trigger] button").click();
  await openStatistics(page);
  await expect(tileValue(page, "cost")).toHaveText("—");
  await expect(tileValue(page, "tokens")).toHaveText("3,000,000 ≈ 300 万");
  await page.screenshot({ path: info.outputPath("desktop-statistics.png") });

  await group(page, "用量统计").getByRole("button", { name: "7 天", exact: true }).click();
  await expect.poll(() => state.lastParams.range).toBe("7d");
  await page.getByRole("button", { name: "设置价格", exact: true }).click();
  await inputPrice(page).fill("2");
  await outputPrice(page).fill("3");
  await page.getByRole("dialog").screenshot({ path: info.outputPath("desktop-price-dialog.png") });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(tileValue(page, "cost")).toHaveText("$8.00");
  expect(state.prices.get("custom-model")).toEqual({ input: 2, output: 3 });
  await page.screenshot({ path: info.outputPath("desktop-statistics-priced.png") });

  await page.locator('.settings-nav-button[data-page-id="appearance"]').click();
  const reads = state.statisticsReads;
  await expect(page.locator(".console-usage")).toHaveCount(0);
  await page.locator('.settings-nav-button[data-page-id="usage-statistics"]').click();
  await expect.poll(() => state.statisticsReads).toBeGreaterThan(reads);
  await expect(tileValue(page, "cost")).toHaveText("$8.00");
  await expect(
    group(page, "用量统计").getByRole("button", { name: "7 天", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: info.outputPath("desktop-statistics-return.png") });
  expect(errors).toEqual([]);
});

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

test("native model labels display and filter without changing the price identity", async ({
  page,
}, info) => {
  const state = await setup(page);
  state.entries = new Map([["qoder", [request("r1", { model: "internal-flash" })]]]);
  state.modelLabels.set("qoder", { "internal-flash": "Qwen3.8-Flash" });
  await openStatistics(page);
  await expect(
    table(page, "按模型").getByRole("button", { name: "Qwen3.8-Flash", exact: true }),
  ).toBeVisible();
  await table(page, "按模型").screenshot({ path: info.outputPath("model-label.png") });
  await choose(page, modelFilter(page), "Qwen3.8-Flash");
  await expect(modelFilter(page)).toHaveText("Qwen3.8-Flash");
  await expect.poll(() => state.lastParams.model).toBe("internal-flash");
  await page.screenshot({ path: info.outputPath("model-filter.png"), fullPage: true });
  await table(page, "按模型").getByRole("button", { name: "设置价格", exact: true }).click();
  await expect(modelInput(page)).toHaveValue("internal-flash");
  await page.screenshot({ path: info.outputPath("model-price-identity.png"), fullPage: true });
});

test("native credits appear as source-labelled details beneath USD without a separate panel", async ({
  page,
}, info) => {
  const state = await setup(page);
  state.entries = new Map([
    [
      "workbuddy",
      [
        request("a", { model: "default-model", credits: 14.81 }),
        request("b", { model: "default-model", credits: 0 }),
        request("c", { model: "default-model" }),
        request("d", { model: "priced-model", credits: 2 }),
      ],
    ],
    ["codebuddy", [request("a", { model: "hy4-preview-f", credits: 0 })]],
  ]);
  state.prices.set("priced-model", { input: 1, output: 2 });
  await openStatistics(page);
  await expect(page.getByRole("heading", { name: "原生 Credits", exact: true })).toHaveCount(0);
  const panel = table(page, "按模型");
  const modelCost = (name: string) =>
    panel
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name, exact: true }) })
      .locator(".console-usage-cost");
  const autoCost = modelCost("default-model");
  await expect(autoCost.locator(".console-usage-cost__source")).toHaveText("workbuddy");
  await expect(autoCost.locator(".console-usage-cost__amount")).toHaveText("14.81 credits");
  await expect(autoCost).toHaveAttribute("title", /2 \/ 3/);
  await expect(autoCost.locator(".is-secondary")).toHaveCount(0);
  const zeroCost = modelCost("hy4-preview-f");
  await expect(zeroCost.locator(".console-usage-cost__source")).toHaveText("codebuddy");
  await expect(zeroCost.locator(".console-usage-cost__amount")).toHaveText("0 credits");
  const priced = modelCost("priced-model");
  await expect(priced.locator(".console-usage-cost__primary")).toHaveText("$5.00");
  await expect(priced.locator(".is-secondary .console-usage-cost__source")).toHaveText("workbuddy");
  await expect(priced.locator(".is-secondary .console-usage-cost__amount")).toHaveText("2 credits");
  const layout = await priced.evaluate((element) => {
    const primary = element.querySelector(".console-usage-cost__primary");
    const credit = element.querySelector(".console-usage-cost__credit");
    if (!primary || !credit) throw new Error("Missing cost hierarchy");
    return {
      primaryBottom: primary.getBoundingClientRect().bottom,
      creditTop: credit.getBoundingClientRect().top,
      primaryFont: parseFloat(getComputedStyle(primary).fontSize),
      creditFont: parseFloat(getComputedStyle(credit).fontSize),
    };
  });
  expect(layout.creditTop).toBeGreaterThan(layout.primaryBottom);
  expect(layout.creditFont).toBeLessThan(layout.primaryFont);
  await expect(table(page, "按 Harness").getByText("16.81 credits", { exact: true })).toBeVisible();
  await expect(table(page, "按 Harness").locator(".console-usage-cost__source")).toHaveCount(0);
  await expect(tileValue(page, "cost")).toHaveText("$5.00");
  await panel.screenshot({ path: info.outputPath("credits-inline.png") });
  await group(page, "Harness").getByRole("button", { name: "codebuddy", exact: true }).click();
  await expect(panel.getByText("14.81 credits", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("cell", { name: "0 credits", exact: true })).toBeVisible();
  await expect(panel.locator(".console-usage-cost__source")).toHaveCount(0);
  await panel.screenshot({ path: info.outputPath("credits-filtered.png") });
});

test("long inline credits do not push the cost column outside the table", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await setup(page);
  state.entries = new Map([
    [
      "workbuddy-long-display-name",
      [request("a", { model: "gpt-5.6-luna", credits: 12345.123456 })],
    ],
    [
      "codebuddy-long-display-name",
      [request("b", { model: "gpt-5.6-luna", credits: 98765.654321 })],
    ],
    [
      "qoder-cn-long-display-name",
      [request("c", { model: "gpt-5.6-luna", credits: 22222.222222 })],
    ],
    ["plain", [request("d", { model: "grok-4.7-build-fast" })]],
  ]);
  state.prices.set("gpt-5.6-luna", { input: 1000, output: 250 });
  state.prices.set("grok-4.7-build-fast", { input: 1, output: 2 });
  await openStatistics(page);
  const panel = table(page, "按模型");
  await panel.screenshot({ path: info.outputPath("long-cost.png") });
  const overflow = await panel
    .locator(".console-usage-table-scroll")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const costCell = panel
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "gpt-5.6-luna", exact: true }) })
    .getByRole("cell")
    .last();
  await expect(costCell).toContainText("12,345.123456");
  await expect(costCell).toContainText("98,765.654321");
  const bounds = await costCell.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    visibleRight:
      element.closest(".console-usage-table-scroll")?.getBoundingClientRect().right ?? 0,
    width: element.getBoundingClientRect().width,
  }));
  expect(bounds.right).toBeLessThanOrEqual(bounds.visibleRight + 1);
  expect(bounds.width).toBeLessThanOrEqual(280);
  const lines = costCell.locator(".console-usage-cost__credit");
  await expect(lines).toHaveCount(3);
  const lineBounds = await lines.evaluateAll((elements) =>
    elements.map((element) => {
      const amount = element.querySelector(".console-usage-cost__amount");
      if (!amount) throw new Error("Missing amount");
      return {
        top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom,
        amountWidth: amount.clientWidth,
        amountScrollWidth: amount.scrollWidth,
        nowrap: getComputedStyle(amount).whiteSpace,
        sourceLeft: element.querySelector(".console-usage-cost__source")?.getBoundingClientRect()
          .left,
        amountRight: amount.getBoundingClientRect().right,
      };
    }),
  );
  for (const [index, line] of lineBounds.entries()) {
    expect(line.amountScrollWidth).toBeLessThanOrEqual(line.amountWidth + 1);
    expect(line.nowrap).toBe("nowrap");
    expect(line.sourceLeft).toBe(lineBounds[0]?.sourceLeft);
    expect(line.amountRight).toBe(lineBounds[0]?.amountRight);
    if (index > 0) expect(line.top).toBeGreaterThan(lineBounds[index - 1]?.bottom ?? 0);
  }
});

test("similar catalog prices fill only the draft, remain editable and save to the original ID", async ({
  page,
}, info) => {
  const state = await setup(page);
  state.defaultAvailable = false;
  state.entries = new Map([["test-harness", [request("r1", { model: "deepseek-v4-flash-free" })]]]);
  state.suggestions = [
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      official: true,
      canonicalModelId: "deepseek/deepseek-v4.1-flash",
      price: { input: 1, output: 2, cacheRead: 0 },
    },
    {
      provider: "reseller",
      model: "deepseek-v4-flash",
      price: { input: 3, output: 4, cacheWrite: 5 },
    },
    {
      provider: "deepseek",
      model: "deepseek-flash",
      official: true,
      canonicalModelId: "deepseek/deepseek-v4.1-flash",
      price: { input: 1, output: 2, cacheRead: 0 },
    },
  ];
  await openStatistics(page);
  await page.getByRole("button", { name: "设置价格", exact: true }).click();
  const suggestions = page.getByRole("region", { name: "相似模型价格" });
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByText("官方", { exact: true })).toHaveCount(2);
  await expect(
    suggestions.getByText("目录关联模型：deepseek/deepseek-v4.1-flash", { exact: true }),
  ).toHaveCount(2);
  await expect(suggestions.locator("strong")).toHaveText([
    "deepseek-v4-flash",
    "deepseek-v4-flash",
    "deepseek-flash",
  ]);
  await expect(inputPrice(page)).toHaveValue("");
  expect(state.writes).toBe(0);
  await page.getByRole("dialog").screenshot({ path: info.outputPath("price-suggestions.png") });
  await suggestions.getByRole("button", { name: "填入此价格" }).nth(1).click();
  await expect(inputPrice(page)).toHaveValue("3");
  await expect(page.getByRole("textbox", { name: "缓存写入", exact: true })).toHaveValue("5");
  await suggestions.getByRole("button", { name: "填入此价格" }).first().click();
  await expect(inputPrice(page)).toHaveValue("1");
  await expect(page.getByRole("textbox", { name: "缓存写入", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "缓存读取", exact: true })).toHaveValue("0");
  await expect(modelInput(page)).toHaveValue("deepseek-v4-flash-free");
  await expect(modelInput(page)).not.toBeEditable();
  expect(state.writes).toBe(0);
  await inputPrice(page).fill("1.5");
  await page
    .getByRole("dialog")
    .screenshot({ path: info.outputPath("price-suggestion-draft.png") });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.prices.get("deepseek-v4-flash-free")).toEqual({
    input: 1.5,
    output: 2,
    cacheRead: 0,
  });
  expect(state.prices.has("deepseek-v4-flash")).toBe(false);
});

test("late suggestions do not overwrite a typed draft, and cancelling never saves", async ({
  page,
}) => {
  const state = await setup(page);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.beforeDefault = () => pending;
  state.suggestions = [
    { provider: "vendor", model: "custom-model-nearby", price: { input: 1, output: 2 } },
  ];
  await openStatistics(page);
  await page.getByRole("button", { name: "设置价格", exact: true }).click();
  await inputPrice(page).fill("8");
  release();
  await expect(page.getByRole("region", { name: "相似模型价格" })).toBeVisible();
  await expect(inputPrice(page)).toHaveValue("8");
  await page.getByRole("button", { name: "填入此价格", exact: true }).click();
  await page.keyboard.press("Escape");
  expect(state.writes).toBe(0);
  expect(state.prices.size).toBe(0);
});

test.describe("suggestion scrollbars", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`price suggestions have a slim persistent scrollbar in ${colorScheme} mode`, async ({
      page,
    }, info) => {
      const state = await setup(page);
      await page.emulateMedia({ colorScheme });
      state.suggestions = Array.from({ length: 6 }, (_, index) => ({
        provider: `provider-${index}`,
        model: `custom-model-${index}`,
        price: { input: index + 1, output: index + 2 },
      }));
      await openStatistics(page);
      await page.getByRole("button", { name: "设置价格", exact: true }).click();
      const region = page.getByRole("region", { name: "相似模型价格" });
      await expect(region).toBeVisible();
      await expect(region).toHaveCSS("overflow-y", "scroll");
      expect(
        await region.evaluate((element) => ({
          width: getComputedStyle(element, "::-webkit-scrollbar").width,
          overflowing: element.scrollHeight > element.clientHeight,
          gutter: (element as HTMLElement).offsetWidth - element.clientWidth,
        })),
      ).toEqual({ width: "6px", overflowing: true, gutter: 6 });
      await page.mouse.move(0, 0);
      await page.getByRole("dialog").screenshot({ path: info.outputPath("scrollbar-before.png") });
      await region.hover();
      await page.mouse.wheel(0, 300);
      await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await page.mouse.move(0, 0);
      await page.getByRole("dialog").screenshot({ path: info.outputPath("scrollbar-after.png") });
      expect(state.writes).toBe(0);
    });
  }
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
  state.entries.set("test-harness", [unmodeledRequest("r1")]);
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

for (const surface of ["console", "desktop"] as const) {
  test(`Chinese statistics show an exact Token total and 万/亿 units (${surface})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    const state = await setup(page, surface);
    state.entries.set("test-harness", [
      request("large", { inputTokens: 100_000_000, outputTokens: 16_222_990 }),
    ]);
    if (surface === "desktop") {
      await page.locator("[data-codexhost-settings-trigger] button").click();
    }
    await openStatistics(page);
    await expect(tileValue(page, "tokens")).toHaveText("116,222,990 ≈ 1.16 亿");
    await expect(tileValue(page, "tokens").locator("small")).toHaveText("≈ 1.16 亿");
    await expect(table(page, "按模型")).toContainText("1 亿");
    await expect(table(page, "按模型")).toContainText("1622.3 万");
    await page.screenshot({ path: info.outputPath("chinese-total.png") });

    await group(page, "趋势").getByRole("button", { name: "Token", exact: true }).click();
    const chart = page.locator(".console-usage-chart-wrap.is-selectable");
    await expect(chart.locator(".console-usage-chart__label")).toContainText([
      "0",
      "6000 万",
      "1.2 亿",
    ]);
    expect(
      await chart
        .locator(".console-usage-chart__label")
        .evaluateAll((labels) =>
          labels
            .slice(0, 3)
            .every((label) => label instanceof SVGGraphicsElement && label.getBBox().x >= 0),
        ),
    ).toBe(true);
    await chart.focus();
    await page.keyboard.press("End");
    await expect(page.locator(".console-usage-trend .console-usage-tooltip")).toContainText(
      "1.16 亿",
    );
    await page.screenshot({ path: info.outputPath("chinese-trend.png") });
  });
}

for (const surface of ["console", "desktop"] as const) {
  test(`three tiles show a cache-inclusive overview with input/output/cache (${surface})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    const state = await setup(page, surface);
    state.prices.set("custom-model", { input: 1, output: 1 });
    state.entries.set("test-harness", [
      request("cached", {
        inputTokens: 1_000_000,
        cachedInputTokens: 800_000,
        cacheWriteInputTokens: 50_000,
        outputTokens: 10_000,
        reasoningOutputTokens: 5_000,
      }),
      // Unpriced: cost still counts only what has a price, without a lower-bound mark.
      request("unpriced", { model: "mystery-model", inputTokens: 5_000, outputTokens: 0 }),
    ]);
    if (surface === "desktop")
      await page.locator("[data-codexhost-settings-trigger] button").click();
    await openStatistics(page);
    await expect(page.locator(".console-usage-tile")).toHaveCount(3);
    for (const [key, label, value] of [
      ["cost", "费用", "$0.160"],
      ["tokens", "总 Token", "1,015,000 ≈ 101.5 万"],
      ["cache", "缓存命中率", "79.6%"],
    ] as const) {
      await expect(tile(page, key).locator(":scope > *")).toHaveCount(key === "tokens" ? 3 : 2);
      await expect(tile(page, key).locator(".console-usage-tile__label")).toHaveText(label);
      await expect(tileValue(page, key)).toHaveText(value);
    }
    const parts = tile(page, "tokens").locator("[data-token-part]");
    await expect(parts).toHaveText(["输入 15.5 万", "输出 1 万", "缓存 85 万"]);
    await expectTokenColumns(page);
    await expect(tile(page, "tokens").locator(".console-usage-tile__breakdown")).not.toContainText(
      "/",
    );
    // Quantities are plain text: neither native title hints nor a question-mark cursor.
    await expect(tile(page, "tokens").locator("[title]")).toHaveCount(0);
    await tileValue(page, "tokens").hover();
    expect(
      await tileValue(page, "tokens").evaluate((node) => getComputedStyle(node).cursor),
    ).not.toBe("help");
    await tile(page, "tokens").locator('[data-token-part="cache"]').hover();
    expect(
      await parts.evaluateAll((nodes) =>
        nodes.some((node) => getComputedStyle(node).cursor === "help"),
      ),
    ).toBe(false);
    await expect(page.getByText("≥")).toHaveCount(0);
    await page
      .locator(".console-usage-tiles")
      .screenshot({ path: info.outputPath("token-summary-cards.png") });
    await page.screenshot({ path: info.outputPath("token-breakdown.png") });

    // Three aligned columns also stay intact on a narrow full-width card.
    await page.setViewportSize({ width: 420, height: 900 });
    await expectTokenColumns(page);
    expect(
      await parts.evaluateAll((nodes) =>
        nodes.every((node) => {
          const row = node.closest(".console-usage-tile")?.getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          return row && rect.left >= row.left && rect.right <= row.right;
        }),
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("token-breakdown-narrow.png") });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: info.outputPath("token-breakdown-dark.png") });

    // A GUI filter updates both the inclusive total and all three subfigures together.
    await table(page, "按模型").getByRole("button", { name: "custom-model", exact: true }).click();
    await expect(tileValue(page, "tokens")).toHaveText("1,010,000 ≈ 101 万");
    await expect(parts).toHaveText(["输入 15 万", "输出 1 万", "缓存 85 万"]);
    await expect(tileValue(page, "cost")).toHaveText("$0.160");
  });

  test(`billion-scale Token breakdown stays in three columns (${surface})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    const state = await setup(page, surface);
    state.entries.set("test-harness", [
      request("large-cache", {
        inputTokens: 14_103_712_122,
        cachedInputTokens: 13_522_000_000,
        cacheWriteInputTokens: 50_000_000,
        outputTokens: 60_020_200,
      }),
    ]);
    if (surface === "desktop")
      await page.locator("[data-codexhost-settings-trigger] button").click();
    await openStatistics(page);
    await expect(tileValue(page, "tokens")).toHaveText("14,163,732,322 ≈ 141.64 亿");
    await expect(tile(page, "tokens").locator("[data-token-part]")).toHaveText([
      "输入 5.32 亿",
      "输出 6002.02 万",
      "缓存 135.72 亿",
    ]);
    await expectTokenColumns(page);
    await tile(page, "tokens").screenshot({ path: info.outputPath("token-columns.png") });
    await page.setViewportSize({ width: 420, height: 900 });
    await expectTokenColumns(page);
    await tile(page, "tokens").screenshot({ path: info.outputPath("token-columns-narrow.png") });
  });

  test(`overview keeps unknown cache breakdown honest (${surface})`, async ({ page }) => {
    const state = await setup(page, surface);
    const unknown = request("unknown-cache", { inputTokens: 200, outputTokens: 20 });
    delete unknown.cachedInputTokens;
    delete unknown.cacheWriteInputTokens;
    state.entries.set("test-harness", [
      request("known-cache", {
        inputTokens: 1_050,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 50,
        outputTokens: 30,
      }),
      unknown,
    ]);
    if (surface === "desktop")
      await page.locator("[data-codexhost-settings-trigger] button").click();
    await openStatistics(page);
    await expect(tileValue(page, "tokens")).toHaveText("1,300");
    await expect(tile(page, "tokens").locator("[data-token-part]")).toHaveText([
      "输入 300",
      "输出 50",
      "缓存 950",
    ]);
    await expect(tile(page, "tokens").locator("[title]")).toHaveCount(0);
    await expect(tileValue(page, "cache")).toHaveText("85.7%");
  });

  test(`overview does not show unknown cache as zero (${surface})`, async ({ page }) => {
    const state = await setup(page, surface);
    const unknown = request("unknown-cache", { inputTokens: 200, outputTokens: 20 });
    delete unknown.cachedInputTokens;
    delete unknown.cacheWriteInputTokens;
    state.entries.set("test-harness", [unknown]);
    if (surface === "desktop")
      await page.locator("[data-codexhost-settings-trigger] button").click();
    await openStatistics(page);
    await expect(tileValue(page, "tokens")).toHaveText("220");
    await expect(tile(page, "tokens").locator("[data-token-part]")).toHaveText([
      "输入 200",
      "输出 20",
      "缓存 —",
    ]);
    await expect(tileValue(page, "cache")).toHaveText("—");
  });

  test(`overview shows missing Token counts as unknown (${surface})`, async ({ page }) => {
    const state = await setup(page, surface);
    state.entries.set("test-harness", [
      request("unmetered", {
        inputTokens: 0,
        outputTokens: 0,
        tokensUnknown: true,
      }),
    ]);
    if (surface === "desktop")
      await page.locator("[data-codexhost-settings-trigger] button").click();
    await openStatistics(page);
    await expect(tileValue(page, "tokens")).toHaveText("—");
    await expect(tile(page, "tokens").locator("[data-token-part]")).toHaveText([
      "输入 —",
      "输出 —",
      "缓存 —",
    ]);
    await expect(tileValue(page, "cost")).toHaveText("—");
  });
}

test.describe("English overview", () => {
  test.use({ locale: "en-US" });
  test("keeps compact totals without quantity hover hints", async ({ page }) => {
    const state = await setup(page);
    state.entries.set("test-harness", [
      request("cached", {
        inputTokens: 1_050,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 50,
        outputTokens: 30,
      }),
    ]);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Usage statistics", exact: true })
      .click();
    await expect(tileValue(page, "tokens")).toHaveText("1.1K");
    await expect(tile(page, "tokens").locator("[data-token-part]")).toHaveText([
      "Input 100",
      "Output 30",
      "Cache 950",
    ]);
    await expect(tile(page, "tokens").locator("[title]")).toHaveCount(0);
  });
});

test("models priced by the Harness's own record offer no price to set or edit", async ({
  page,
}) => {
  const state = await setup(page);
  state.entries.set("test-harness", [
    request("recorded", { model: "grok-4.6-build", costUsd: 0.25 }),
    request("listed", { model: "custom-model" }),
  ]);
  await openStatistics(page);
  const models = table(page, "按模型");
  const recorded = models.locator("tbody tr").filter({ hasText: "grok-4.6-build" });
  await expect(recorded).toContainText("$0.250");
  await expect(recorded.getByRole("button", { name: /设置价格|编辑价格/ })).toHaveCount(0);
  await expect(recorded).not.toContainText("未计价");
  // A model priced by a price list keeps its action.
  const listed = models.locator("tbody tr").filter({ hasText: "custom-model" });
  await expect(listed.getByRole("button", { name: "设置价格", exact: true })).toBeVisible();
});

test("requests without token counts show dashes, not zeros, and no price to set", async ({
  page,
}) => {
  const state = await setup(page);
  state.entries.set("test-harness", [
    request("credits-only", {
      model: "qfmodel",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      tokensUnknown: true,
    }),
    request("listed", { model: "custom-model" }),
  ]);
  await openStatistics(page);
  const row = table(page, "按模型").locator("tbody tr").filter({ hasText: "qfmodel" });
  // Input, cache read, output, hit rate and cost: all unknown.
  await expect(row.locator("td").filter({ hasText: /^—$/ })).toHaveCount(6);
  await expect(row.getByRole("button", { name: /设置价格|编辑价格/ })).toHaveCount(0);
  await expect(row).not.toContainText("未计价");
  // The request still counts.
  await expect(row.locator("td").nth(1)).toHaveText("1");
});

test("the model filter tells all models from the unknown model and searches", async ({ page }) => {
  const state = await setupDashboard(page);
  state.entries.get("pi")?.push(unmodeledRequest("no-model"));
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
  // Only the request without a model: 1M input and 2M output.
  await expect(tileValue(page, "tokens")).toHaveText("3,000,000 ≈ 300 万");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(modelFilter(page)).toHaveText("全部模型");
  expect(state.lastParams).not.toHaveProperty("model");
});

test("rows filter, sort, fold and show shares; unpriced rows are marked; the view is remembered", async ({
  page,
}) => {
  const state = await setupDashboard(page);
  await openStatistics(page);
  await expect(page.locator(".console-usage-tile")).toHaveCount(3);
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

test("the model table narrows to what needs a price", async ({ page }) => {
  await setupDashboard(page);
  await openStatistics(page);
  const toggle = page.getByRole("button", { name: "只看未计价", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
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
  await expect(tooltip).toContainText("Token");
  await expect(tooltip).not.toContainText("请求");
  // The trend measures cost or tokens, nothing else.
  await expect(group(page, "趋势").first().getByRole("button")).toHaveText(["费用", "Token"]);
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

test("session titles stay above muted projects with copying and filtering intact", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const copied: string[] = [];
  await page.exposeFunction("recordCopiedSession", (id: string) => copied.push(id));
  // This HTTP fixture has no secure-context clipboard; prepare the native API before launch.
  await page.addInitScript(`Object.defineProperty(navigator, "clipboard", {
    value: { writeText: window.recordCopiedSession }
  });`);
  const state = await setup(page);
  const longTitle = "修复 Hermes 连接检测并核对运行环境、构建依赖和会话恢复行为".repeat(3);
  state.entries = new Map([
    [
      "pi",
      [
        request("named", {
          sessionId: "named-session",
          sessionTitle: longTitle,
          cwd: "/work/codex-host",
        }),
        request("short", {
          sessionId: "short-session",
          sessionTitle: "理解项目背景",
          cwd: "/work/analysis",
        }),
        request("unnamed", { sessionId: "unnamed-session" }),
      ],
    ],
  ]);
  await openStatistics(page);
  for (const heading of ["最耗会话", "最近会话"]) {
    const panel = table(page, heading);
    const name = panel.locator(".console-usage-session").filter({ hasText: longTitle });
    await expect(name.locator(".is-title")).toHaveText(longTitle);
    await expect(name.locator(".is-title")).toHaveAttribute("title", new RegExp("named-session"));
    await expect(name.locator(".console-usage-row-filter")).toHaveText("codex-host");
    await expect(name.locator(".console-usage-row-filter")).toHaveAttribute(
      "title",
      /\/work\/codex-host/,
    );
    await expect(panel.getByRole("button", { name: "未命名", exact: true })).toBeVisible();
    const layout = await name.evaluate((element) => {
      const title = element.querySelector(".is-title");
      const project = element.querySelector(".console-usage-row-filter");
      if (!title || !project) throw new Error("Missing session hierarchy");
      return {
        titleBottom: title.getBoundingClientRect().bottom,
        projectTop: project.getBoundingClientRect().top,
        titleLeft: title.getBoundingClientRect().left,
        projectLeft: project.getBoundingClientRect().left,
        titleFont: parseFloat(getComputedStyle(title).fontSize),
        projectFont: parseFloat(getComputedStyle(project).fontSize),
        titleColor: getComputedStyle(title).color,
        projectColor: getComputedStyle(project).color,
        clipped: title.scrollWidth > title.clientWidth,
        ellipsis: getComputedStyle(title).textOverflow,
      };
    });
    expect(layout.projectTop).toBeGreaterThan(layout.titleBottom);
    expect(layout.projectLeft).toBe(layout.titleLeft);
    expect(layout.projectFont).toBeLessThan(layout.titleFont);
    expect(layout.projectColor).not.toBe(layout.titleColor);
    expect(layout.clipped).toBe(true);
    expect(layout.ellipsis).toBe("ellipsis");
    await panel.screenshot({ path: info.outputPath(`${heading}-session-hierarchy.png`) });
  }
  await table(page, "最近会话").getByRole("button", { name: longTitle, exact: true }).click();
  await expect.poll(() => copied).toEqual(["named-session"]);
  await expect(
    table(page, "最近会话").getByRole("button", { name: "已复制", exact: true }),
  ).toBeVisible();
  await table(page, "最近会话").getByRole("button", { name: "codex-host", exact: true }).click();
  await expect.poll(() => state.lastParams.project).toBe("/work/codex-host");
  await expect(table(page, "最近会话").locator("tbody tr")).toHaveCount(1);
  await expect(
    table(page, "最近会话").getByRole("button", { name: "codex-host", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await table(page, "最近会话").screenshot({ path: info.outputPath("session-project-filter.png") });
});

test("projects, sessions and CSV follow the filters", async ({ page }) => {
  const state = await setupDashboard(page);
  await openStatistics(page);
  await page.getByRole("button", { name: "7 天", exact: true }).click();
  await expect.poll(() => state.lastParams.range).toBe("7d");

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

  const recent = table(page, "最近会话");
  await expect(recent.locator("tbody tr").first()).toContainText("lib");
  await expect(recent.locator("thead")).toContainText("最近活跃");
  await expect(page.getByRole("heading", { name: /^(最近会话|最耗会话)$/ })).toHaveText([
    "最近会话",
    "最耗会话",
  ]);

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
