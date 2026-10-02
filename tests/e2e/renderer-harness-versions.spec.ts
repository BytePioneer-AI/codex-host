import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createHarnessVersionPanel } from "./packages/renderer-extension/src/settings/harness-version-panel.ts";
      globalThis.setupLocalizedVersion = (locale, latestVersion, messageCode) => {
        document.body.replaceChildren(createHarnessVersionPanel(
          document, rendererSettingsMessages(locale), new AbortController().signal, "hermes",
          { run: async () => ({
            currentVersion: "0.21.5+5355.g357f51c.dirty @ 357f51c4",
            latestVersion, messageCode, updateAvailable: true, canUpdate: false,
            message: "Use the native updater manually.",
          }) },
        ));
      };
      import { createConnectionsSettingsPage } from "./packages/renderer-extension/src/settings/connections-page.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
      globalThis.setupHarnessVersions = () => {
        const calls = [];
        let updated = false;
        let installAttempts = 0;
        const installedHosts = new Set();
        const diagnostics = {
          snapshot: () => ({
            adapter: { state:"ready", reason:"ready", modelUpdates:1, hook:"request-bridge" },
            hosts: ["local", "remote-test"].map(hostId => ({ hostId, active:hostId === "local", agents: [
              {agent:"pi",availability:"ready",error:null},
              {agent:"claude-code",availability:"ready",error:null},
              {agent:"omp",availability:installedHosts.has(hostId) ? "ready" : "notInstalled",error:null},
            ] })),
          }),
          subscribe: () => () => {},
          refresh: async () => {},
          installation: async (hostId, agent, action) => {
            calls.push({hostId,agent,action});
            if (agent === "claude-code") throw {code:-32078};
            if (action === "install") {
              installAttempts++;
              await new Promise(resolve => setTimeout(resolve, 1200));
              if (installAttempts === 1) throw new Error("Installation failed: check network and prerequisites.");
              installedHosts.add(hostId);
            }
            if (action === "update") {
              await new Promise(resolve => setTimeout(resolve, 1200));
              updated = true;
            }
            return {
              currentVersion: hostId === "local" ? updated ? "0.85.2" : "0.85.1" : "0.85.2",
              latestVersion:"0.85.2", updateAvailable:hostId === "local" && !updated, canUpdate:true,
            };
          },
        };
        const messages = rendererSettingsMessages("zh-CN");
        const registry = createRendererSettingsPageRegistry([createConnectionsSettingsPage(messages, () => diagnostics)]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, "connections");
        globalThis.versionFixture = { calls };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "harness-version-e2e.ts",
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
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Harness versions fixture bundle missing");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/harness-versions", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("http://localhost/harness-versions");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() =>
    (globalThis as unknown as { setupHarnessVersions(): void }).setupHarnessVersions(),
  );
});

test("renders version hints and adapter notes in the selected language", async ({ page }) => {
  for (const locale of ["zh-CN", "en"] as const) {
    await page.evaluate((locale) => {
      (
        globalThis as unknown as {
          setupLocalizedVersion(locale: string, latestVersion: string, messageCode: string): void;
        }
      ).setupLocalizedVersion(locale, "Tracking branch (new commits)", "hermes-manual-update");
    }, locale);
    const panel = page.locator(".settings-harness-version");
    await expect(panel).toContainText("0.21.5+5355.g357f51c.dirty @ 357f51c4");
    await expect(panel).toContainText(
      locale === "zh-CN" ? "跟踪分支（有新提交）" : "Tracking branch (new commits)",
    );
    await expect(panel).toContainText(
      locale === "zh-CN" ? "源码目录无未提交修改" : "clean source checkout",
    );
    if (locale === "zh-CN") await expect(panel).not.toContainText("Use the native updater");
    else await expect(panel).not.toContainText("请手动");
  }
});

test("checks automatically and updates explicitly in Connections, with separate remote Host versions", async ({
  page,
}, testInfo) => {
  await page.getByRole("row", { name: /^Pi 正常/ }).click();
  const panel = page.locator(".settings-harness-version");
  await expect(panel).toContainText("当前版本: 0.85.1");
  await expect(panel.getByRole("button", { name: "检查更新" })).toHaveCount(0);
  const update = panel.getByRole("button", { name: "更新", exact: true });
  await expect(update).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("versions-before.png") });
  await update.click();
  await expect(panel.getByRole("status")).toHaveText("正在更新…");
  await expect(
    page.locator('[data-connection-item="pi"] .settings-connection-row__status'),
  ).toHaveText("更新中");
  await expect(page.locator(".settings-connection-inspector__header")).toContainText("更新中");
  await expect(
    page.locator('[data-connection-item="claude-code"] .settings-connection-row__status'),
  ).toHaveText("正常");
  await expect(update).toBeDisabled();
  await expect(panel.getByRole("status")).toContainText("已确认更新成功");
  await expect(
    page.locator('[data-connection-item="pi"] .settings-connection-row__status'),
  ).toHaveText("正常");
  await expect(panel.getByRole("button", { name: "已是最新" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("versions-updated.png") });
  await page.getByRole("tab", { name: "remote-test" }).click();
  await expect(panel).toContainText("当前版本: 0.85.2");
  await page.screenshot({ path: testInfo.outputPath("versions-remote.png") });
  const calls = await page.evaluate(
    () => (globalThis as unknown as { versionFixture: { calls: unknown[] } }).versionFixture.calls,
  );
  expect(calls).toEqual([
    { hostId: "local", agent: "pi", action: "check" },
    { hostId: "local", agent: "pi", action: "update" },
    { hostId: "remote-test", agent: "pi", action: "check" },
  ]);
});

test("unsupported plugins show original instructions without disabling supported Harnesses", async ({
  page,
}, testInfo) => {
  await page.getByRole("row", { name: /^Claude Code 正常/ }).click();
  const panel = page.locator(".settings-harness-version");
  await expect(panel).toContainText("当前 Host 或插件不支持 CLI 版本管理");
  await expect(panel.getByRole("button", { name: "更新", exact: true })).toBeDisabled();
  await expect(panel.getByRole("link", { name: "查看安装指引" })).toHaveAttribute(
    "href",
    "https://code.claude.com/docs/en/quickstart",
  );
  await page.screenshot({ path: testInfo.outputPath("versions-unsupported.png") });
  await page.getByRole("row", { name: /^Pi 正常/ }).click();
  await expect(panel.getByRole("button", { name: "更新", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("versions-supported.png") });
});

test("downloads explicitly, shows progress and errors, and retries on the selected Host", async ({
  page,
}, testInfo) => {
  const row = page.locator('[data-connection-item="omp"]');
  const download = row.getByRole("button", { name: "安装: Oh My Pi", exact: true });
  await expect(download).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("install-before.png") });
  await download.click();
  await expect(row).toContainText("安装中");
  await expect(download).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("install-running.png") });
  await expect(page.locator('.settings-connection-inspector [role="alert"]')).toContainText(
    "Installation failed",
  );
  await expect(row).toContainText("错误");
  await expect(download).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("install-error.png") });
  await download.click();
  await expect(row).toContainText("安装中");
  await page.getByRole("tab", { name: "remote-test" }).click();
  await expect(row).toContainText("未安装");
  await page.getByRole("tab", { name: "本地", exact: true }).click();
  await expect(row).toContainText("正常");
  await expect(download).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("install-complete.png") });
  const calls = await page.evaluate(
    () =>
      (globalThis as unknown as { versionFixture: { calls: { action: string; hostId: string }[] } })
        .versionFixture.calls,
  );
  expect(calls.filter((call) => call.action === "install").map((call) => call.hostId)).toEqual([
    "local",
    "local",
  ]);
});

test("keeps installation guides for missing Harnesses and fits a narrow inspector", async ({
  page,
}, testInfo) => {
  await page.getByRole("row", { name: /^Oh My Pi 未安装/ }).click();
  await expect(page.locator(".settings-harness-installation")).toContainText(
    "https://omp.sh/install",
  );
  await expect(page.locator(".settings-harness-version")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("versions-not-installed.png") });
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.getByRole("row", { name: /^Pi 正常/ }).click();
  const panel = page.locator(".settings-harness-version");
  await expect(panel.getByRole("button", { name: "更新", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("versions-narrow.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
