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
      globalThis.setupFeedback = () => {
        let checking = false;
        const listeners = new Set();
        const agents = plugins.map(plugin => plugin.id);
        const metrics = { rebuilds: 0, lastPaintedInspector: "", checks: [], updates: [], agents };
        const pendingChecks = [];
        globalThis.finishVersionChecks = () => pendingChecks.splice(0).forEach(resolve => resolve());
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
            hosts: [{hostId:"local",active:true,agents:agents.map(agent=>({
              agent, plugin:plugins.find(plugin => plugin.id === agent), availability:checking ? "checking" : "ready", error:null,
            }))}],
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
              return {currentVersion:"1.3.0",latestVersion:"1.3.0",updateAvailable:false,canUpdate:true};
            }
            metrics.checks.push({agent, paintedInspector:metrics.lastPaintedInspector});
            // Model synchronous route discovery on the first request to this Host.
            if (metrics.checks.length === 1) {
              const until = performance.now() + 350;
              while (performance.now() < until) {}
            }
            await new Promise(resolve => pendingChecks.push(resolve));
            return {currentVersion:"1.2.16",latestVersion:agent === "pi" ? "1.3.0" : "1.2.16",updateAvailable:agent === "pi",canUpdate:true};
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

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/connections-feedback", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/connections-feedback");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupFeedback")());
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
  await expect(pi).toContainText("有新版本: 1.3.0");
  await expect(pi.getByRole("button", { name: "更新: Pi", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("update-available.png") });
  await pi.getByRole("button", { name: "更新: Pi", exact: true }).click();
  await expect(page.locator(".settings-harness-version")).toContainText("当前版本: 1.3.0");
  await expect(pi).not.toContainText("有新版本");
  await expect(pi.getByRole("button", { name: "更新: Pi", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, "feedbackMetrics").updates)).toEqual([
    { hostId: "local", agent: "pi" },
  ]);
});
