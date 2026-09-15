import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createAppearanceSettingsPage } from "./packages/renderer-extension/src/settings/appearance-page.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
      import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";
      import { installIdleReleasePreferenceSync } from "./packages/renderer-extension/src/renderer-idle-release-preference.ts";
      globalThis.setupIdleRelease = (unsupported = false) => {
        const calls = [];
        const client = createRendererModelClient([{sendRequest: async (method, params) => {
          calls.push({method, params});
          if (unsupported) throw {code:-32601};
          return params;
        }}]);
        const sync = installIdleReleasePreferenceSync(window);
        sync.connect(client);
        const messages = rendererSettingsMessages("zh-CN");
        const registry = createRendererSettingsPageRegistry([createAppearanceSettingsPage(messages)]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, "appearance");
        globalThis.idleFixture = {calls, dispose: () => {shell.dispose(); sync.dispose();}};
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "idle-release-e2e-entry.ts",
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
if (!bundle) throw new Error("Missing settings fixture bundle");
async function setup(page: Page, unsupported = false) {
  await page.route("http://localhost/idle-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/idle-test");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((value) => Reflect.get(globalThis, "setupIdleRelease")(value), unsupported);
}

test("General groups appearance and idle release controls without dialogs or long text", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByRole("button", { name: "通用", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "换行显示思考文本" })).toBeVisible();
  const enabled = page.getByRole("switch", { name: "自动释放空闲会话" });
  const minutes = page.getByRole("spinbutton", { name: "空闲超时" });
  await expect(enabled).not.toBeChecked();
  await expect(minutes).toHaveValue("30");

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeHidden();
  await page.getByRole("button", { name: "自动释放空闲会话说明" }).hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("一并停止");

  await minutes.fill("9");
  await minutes.press("Tab");
  await expect(minutes).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("请输入 10～1440 之间的整数。")).toBeVisible();
  await minutes.fill("10");
  await minutes.press("Tab");
  await expect(minutes).toHaveAttribute("aria-invalid", "false");
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(globalThis, "idleFixture").calls.at(-1)?.params.timeoutMinutes,
      ),
    )
    .toBe(10);
  // Successful sync is silent; the scope badge is no longer shown.
  await expect(page.getByText("同步中…")).toBeHidden();
  await expect(page.getByText("仅本地 Host", { exact: true })).toHaveCount(0);

  // Enabling applies immediately; Playwright would auto-dismiss any unexpected dialog.
  await enabled.click();
  await expect(enabled).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "idleFixture").calls.at(-1)?.params.enabled),
    )
    .toBe(true);
  await expect(page.getByText("同步中…")).toBeHidden();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("codexhost.idle-release.v1") ?? "null"),
    ),
  ).toEqual({ enabled: true, timeoutMinutes: 10 });
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expect(minutes).toHaveValue("10");
  await page.reload();
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupIdleRelease")());
  await expect(enabled).not.toBeChecked();
  await expect(minutes).toHaveValue("10");
});

test("another window's change updates both the UI and the Host without stale cached settings", async ({
  page,
  context,
}) => {
  await setup(page);
  const other = await context.newPage();
  await setup(other);
  const enabled = page.getByRole("switch", { name: "自动释放空闲会话" });
  await enabled.check();
  const otherEnabled = other.getByRole("switch", { name: "自动释放空闲会话" });
  await expect(otherEnabled).toBeChecked();
  await otherEnabled.uncheck();
  await expect(enabled).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "idleFixture").calls.at(-1).params.enabled),
    )
    .toBe(false);
  await other.close();
});

test("unsupported Host is visible rather than reported as applied", async ({ page }) => {
  await setup(page, true);
  await expect(page.getByRole("status")).toContainText("当前 Host 不支持");
});
