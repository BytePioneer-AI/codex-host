import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { pluginDescriptor, testPluginIds } from "../fixtures/harness-plugin-descriptors.js";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createAgentGroupPreferenceStore } from "./packages/renderer-extension/src/agent-group-preference.ts";
      import { createConnectionsSettingsPage } from "./packages/renderer-extension/src/settings/connections-page.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
      const plugins = ${JSON.stringify(testPluginIds.map(pluginDescriptor))};
      globalThis.setupFeedback = (bulk = false, manual = false) => {
        let checking = false;
        const listeners = new Set();
        const agents = plugins.map(plugin => plugin.id);
        const metrics = { rebuilds: 0, lastPaintedInspector: "", checks: [], updates: [], agents };
        const pendingChecks = [];
        const pendingUpdates = [];
        globalThis.finishVersionChecks = () => pendingChecks.splice(0).forEach(resolve => resolve());
        globalThis.finishNextUpdate = () => pendingUpdates.shift()?.();
        const replace = Element.prototype.replaceChildren;
        Element.prototype.replaceChildren = function(...children) {
          if (this.classList.contains("settings-connections-content")) metrics.rebuilds++;
          return replace.apply(this, children);
        };
        const store = createAgentGroupPreferenceStore(null);
        store.setSyncStatus("ready");
        const sampleFrame = () => {
          metrics.lastPaintedInspector = document.querySelector("[data-codexhost-settings-shell]")?.shadowRoot?.querySelector(".settings-connection-inspector__header strong")?.textContent ?? "";
          requestAnimationFrame(sampleFrame);
        };
        requestAnimationFrame(sampleFrame);
        const diagnostics = {
          snapshot: () => ({
            adapter: {state:"ready",reason:"ready",modelUpdates:1,hook:"request-bridge"},
            hosts: (bulk ? ["local", ...Array.from({length:8}, (_,i)=>"remote-long-host-"+i)] : ["local"]).map(hostId=>({hostId,active:hostId === "local",agents:agents.map(agent=>({
              agent, plugin:plugins.find(plugin => plugin.id === agent), availability:checking ? "checking" : manual && agent === "workbuddy" ? "unavailable" : "ready", error:manual && agent === "workbuddy" ? {code:"nativeFailure",message:"WorkBuddy: ACP connection closed",retryable:false} : null,
            }))})),
          }),
          subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
          refresh: async () => {
            for (let i=0; i<200; i++) {
              checking = i % 2 === 0;
              for (const listener of listeners) listener();
              await Promise.resolve();
            }
          },
          installation: async (hostId, agent, action) => {
            if (action === "update") {
              metrics.updates.push({hostId, agent});
              if (bulk) await new Promise(resolve => pendingUpdates.push(resolve));
              return {currentVersion:"1.3.0",latestVersion:"1.3.0",updateAvailable:false,canUpdate:true};
            }
            metrics.checks.push({agent, paintedInspector:metrics.lastPaintedInspector});
            // Model synchronous route discovery on the first request to this Host.
            if (metrics.checks.length === 1) {
              const until = performance.now() + 350;
              while (performance.now() < until) {}
            }
            await new Promise(resolve => pendingChecks.push(resolve));
            if (manual && agent === "workbuddy") return {
              currentVersion:"5.5.2",latestVersion:"5.8.4",updateAvailable:true,canUpdate:false,versionKind:"application",
              manualUpdateUrl:"https://download.codebuddy.ai/workbuddy/test/WorkBuddy.dmg",
              notice:{en:"Download the official installer, complete installation, then reopen Connections to verify the version.","zh-CN":"此处显示 WorkBuddy 桌面应用版本，内置 CLI 随应用更新。请下载官方安装包并完成安装，再重新打开连接页确认版本。"},
            };
            const updateAvailable = agent === "pi" || (bulk && ["claude-code", "opencode"].includes(agent));
            return {currentVersion:"1.2.16",latestVersion:updateAvailable ? "1.3.0" : "1.2.16",updateAvailable,canUpdate:!(bulk && agent === "opencode")};
          },
        };
        const messages = rendererSettingsMessages("zh-CN");
        const registry = createRendererSettingsPageRegistry([createConnectionsSettingsPage(messages,()=>diagnostics,store)]);
        const shell = mountRendererSettingsShell(registry,document,messages);
        shell.openSettings(undefined,"connections");
        globalThis.feedbackMetrics = metrics;
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Connection feedback fixture missing");

async function setup(page: Page, bulk = false, manual = false) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/connections-feedback", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/connections-feedback");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    ({ bulk, manual }) => Reflect.get(globalThis, "setupFeedback")(bulk, manual),
    { bulk, manual },
  );
  await expect(page.locator('[data-connection-item="antigravity"] button')).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const metrics = Reflect.get(globalThis, "feedbackMetrics");
        return metrics.checks.length === metrics.agents.length;
      }),
    )
    .toBe(true);
}

test("checks the list after painting and coalesces diagnosis bursts while checks are pending", async ({
  page,
}, testInfo) => {
  await setup(page);
  const before = await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics").rebuilds);
  await page.getByRole("button", { name: "重新诊断连接" }).click();
  await expect(page.getByRole("button", { name: "重新诊断连接" })).toBeEnabled();
  const rebuilds = await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics").rebuilds);
  expect(rebuilds - before).toBeLessThanOrEqual(3);
  await page.screenshot({ path: testInfo.outputPath("diagnosis-settled.png") });
  const row = page.locator('[data-connection-item="antigravity"]');
  await row.getByRole("cell").first().click();
  await expect(row).toHaveAttribute("data-connection-selected", "true", { timeout: 300 });
  await expect(page.locator(".settings-connection-inspector__header")).toContainText(
    "Antigravity CLI",
    { timeout: 300 },
  );
  await expect(page.locator('.settings-harness-version [role="status"]')).toContainText("正在检查");
  await page.screenshot({ path: testInfo.outputPath("selection-checking.png") });
  await page.evaluate(() => Reflect.get(globalThis, "finishVersionChecks")());
  await expect(page.locator(".settings-harness-version")).toContainText("当前版本: 1.2.16");
  await page.screenshot({ path: testInfo.outputPath("selection-ready.png") });
  const metrics = await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics"));
  expect(metrics.checks.map((check: { agent: string }) => check.agent)).toEqual(metrics.agents);
  expect(
    metrics.checks.every(
      (check: { paintedInspector: string }) => check.paintedInspector.length > 0,
    ),
  ).toBe(true);
  expect(metrics.updates).toEqual([]);
  console.log(JSON.stringify({ diagnosticNotifications: 200, layoutRebuilds: rebuilds - before }));
});

test("switches inspectors while checks are pending and reuses their panels", async ({
  page,
}, testInfo) => {
  await setup(page);
  const antigravity = page.locator('[data-connection-item="antigravity"]');
  await antigravity.getByRole("cell").first().click();
  await expect(page.locator('.settings-harness-version [role="status"]')).toContainText("正在检查");
  await page
    .getByRole("row", { name: /^Pi 正常/ })
    .getByRole("cell")
    .first()
    .click();
  await expect(page.locator(".settings-connection-inspector__header")).toContainText("Pi");
  await page.screenshot({ path: testInfo.outputPath("selection-switched.png") });
  await antigravity.getByRole("cell").first().click();
  await page.evaluate(() => Reflect.get(globalThis, "finishVersionChecks")());
  await expect(page.locator(".settings-harness-version")).toContainText("当前版本: 1.2.16");
  const metrics = await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics"));
  expect(metrics.checks.map((check: { agent: string }) => check.agent)).toEqual(metrics.agents);
  await page.screenshot({ path: testInfo.outputPath("selection-reused.png") });
});

test("shows updates without selecting a Harness and runs the update from its row", async ({
  page,
}, testInfo) => {
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "finishVersionChecks")());
  const pi = page.locator('[data-connection-item="pi"]');
  await expect(pi).toHaveAttribute("data-connection-selected", "false");
  const hint = pi.locator(".settings-connection-version-available");
  const update = pi.getByRole("button", { name: "更新: Pi", exact: true });
  await expect(hint).toHaveText("有更新");
  await expect(hint).toHaveAttribute("title", "当前版本: 1.2.16\n最新版本: 1.3.0");
  await expect(pi.locator(".settings-connection-row__status")).toHaveText("正常");
  await expect(pi).not.toContainText("1.3.0");
  await expect(update).toBeEnabled();
  for (const width of [1440, 820]) {
    await page.setViewportSize({ width, height: 1000 });
    const hintBounds = await hint.boundingBox();
    const updateBounds = await update.boundingBox();
    const piBounds = await pi.boundingBox();
    const claudeBounds = await page.locator('[data-connection-item="claude-code"]').boundingBox();
    if (!hintBounds || !updateBounds || !piBounds || !claudeBounds) {
      throw new Error("Expected visible version hints and rows");
    }
    expect(hintBounds.x + hintBounds.width).toBeLessThanOrEqual(updateBounds.x);
    expect(updateBounds.x + updateBounds.width).toBeLessThanOrEqual(piBounds.x + piBounds.width);
    expect(piBounds.height).toBe(claudeBounds.height);
  }
  await page.screenshot({ path: testInfo.outputPath("update-available.png") });
  await update.click();
  await expect(page.locator(".settings-harness-version")).toContainText("当前版本: 1.3.0");
  await expect(hint).toHaveCount(0);
  await expect(pi.getByRole("button", { name: "更新: Pi", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics").updates)).toEqual([
    { hostId: "local", agent: "pi" },
  ]);
});

test("updates all eligible Harnesses from the Host header and keeps the button beside scrolling tabs", async ({
  page,
}, testInfo) => {
  await setup(page, true);
  const updateAll = page.locator('[data-connection-action="update-all"]');
  await expect(updateAll).toBeDisabled();
  await page.evaluate(() => Reflect.get(globalThis, "finishVersionChecks")());
  await expect(updateAll).toHaveText("全部更新 (2)");
  await expect(updateAll).toBeEnabled();
  for (const width of [1440, 820]) {
    await page.setViewportSize({ width, height: 1000 });
    const header = await page.locator(".settings-connection-host-header").boundingBox();
    const button = await updateAll.boundingBox();
    const strip = await page.locator(".settings-connection-host-strip").boundingBox();
    if (!header || !button || !strip) throw new Error("Expected a visible Host header");
    expect(strip.x + strip.width).toBeLessThanOrEqual(button.x);
    expect(button.x + button.width).toBeLessThanOrEqual(header.x + header.width);
    const row = page.locator('[data-connection-item="pi"]');
    const rowBounds = await row.boundingBox();
    const updateBounds = await row.locator('[data-connection-action="update"]').boundingBox();
    if (!rowBounds || !updateBounds) throw new Error("Expected a visible row update button");
    expect(updateBounds.x + updateBounds.width).toBeLessThanOrEqual(rowBounds.x + rowBounds.width);
    await expect(page.locator(".settings-connection-host-strip")).toHaveAttribute(
      "data-connection-host-overflow",
      "true",
    );
  }
  await page.screenshot({ path: testInfo.outputPath("update-all-ready.png") });
  await updateAll.click();
  await expect(updateAll).toHaveText("更新中 0/2");
  await expect(updateAll).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics").updates)).toEqual([
    { hostId: "local", agent: "claude-code" },
    { hostId: "local", agent: "pi" },
  ]);
  for (const agent of ["pi", "claude-code"]) {
    await expect(
      page.locator(`[data-connection-item="${agent}"] .settings-connection-row__status`),
    ).toHaveText("更新中");
  }
  await page.evaluate(() => Reflect.get(globalThis, "finishNextUpdate")());
  await expect(updateAll).toHaveText("更新中 1/2");
  await page.screenshot({ path: testInfo.outputPath("update-all-running.png") });
  await page.evaluate(() => Reflect.get(globalThis, "finishNextUpdate")());
  await expect(page.locator(".settings-connection-update-result")).toHaveText(
    "已更新 2 项，0 项失败。",
  );
  await expect(updateAll).toHaveText("全部更新");
  await expect(updateAll).toBeDisabled();
  await expect(page.locator('[data-connection-item="opencode"]')).toContainText("有更新");
  expect(await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics").updates)).toEqual([
    { hostId: "local", agent: "claude-code" },
    { hostId: "local", agent: "pi" },
  ]);
  await page.screenshot({ path: testInfo.outputPath("update-all-completed.png") });
});

test("offers the WorkBuddy installer without submitting an automatic update", async ({
  page,
}, testInfo) => {
  await setup(page, false, true);
  await page.evaluate(() => Reflect.get(globalThis, "finishVersionChecks")());
  const row = page.locator('[data-connection-item="workbuddy"]');
  await row.click();
  const panel = page.locator('[data-harness-version="workbuddy"]');
  await expect(page.locator(".settings-connection-inspector")).toContainText(
    "ACP connection closed",
  );
  await expect(panel).toContainText("应用版本");
  await expect(panel).toContainText("当前版本: 5.5.2");
  await expect(panel).toContainText("最新版本: 5.8.4");
  await expect(row).toContainText("有更新");
  await expect(row.locator('[data-connection-action="update"]')).toHaveCount(0);
  const download = panel.getByRole("link", { name: "下载更新", exact: true });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute(
    "href",
    "https://download.codebuddy.ai/workbuddy/test/WorkBuddy.dmg",
  );
  await expect(panel.locator('[data-harness-version-action="update"]')).toBeHidden();
  await expect(page.locator('[data-connection-action="update-all"]')).toHaveText("全部更新 (1)");
  await page.route("https://download.codebuddy.ai/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Official installer test" }),
  );
  const popupPromise = page.waitForEvent("popup");
  await download.click();
  const popup = await popupPromise;
  await popup.close();
  expect(await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics").updates)).toEqual([]);
  await expect(panel).toContainText("当前版本: 5.5.2");
  await expect(panel).not.toContainText("已确认更新成功");
  await page.screenshot({ path: testInfo.outputPath("workbuddy-manual-update.png") });
});
