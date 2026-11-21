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
      import { installDelegationCapacityPreferenceSync } from "./packages/renderer-extension/src/renderer-delegation-capacity-preference.ts";
      const METHOD = "codexhost/settings/delegation-capacity/set";
      globalThis.setupDelegationCapacity = (unsupported = false) => {
        const calls = [];
        const client = createRendererModelClient([{sendRequest: async (method, params) => {
          if (method === METHOD) calls.push(params);
          if (unsupported && method === METHOD) throw {code:-32601};
          return params;
        }}]);
        const idle = installIdleReleasePreferenceSync(window);
        const capacity = installDelegationCapacityPreferenceSync(window);
        idle.connect(client);
        capacity.connect(client);
        const messages = rendererSettingsMessages("zh-CN");
        const registry = createRendererSettingsPageRegistry([createAppearanceSettingsPage(messages)]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, "appearance");
        globalThis.capacityFixture = {calls, dispose: () => {shell.dispose(); capacity.dispose(); idle.dispose();}};
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "delegation-capacity-e2e-entry.ts",
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
  await page.route("http://localhost/delegation-capacity-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/delegation-capacity-test");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    (value) => Reflect.get(globalThis, "setupDelegationCapacity")(value),
    unsupported,
  );
}
function lastSent(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(globalThis, "capacityFixture").calls.at(-1) ?? null);
}

test("the delegation limit is off by default and edits apply to the Host at once", async ({
  page,
}) => {
  await setup(page);
  const region = page.getByRole("region", { name: "委派", exact: true });
  const enabled = region.getByRole("switch", { name: "限制同时运行的委派" });
  const limit = region.getByRole("spinbutton", { name: "同时运行上限" });
  await expect(enabled).not.toBeChecked();
  // The limit has no effect while the switch is off, so it is not shown.
  await expect(limit).toBeHidden();
  await expect.poll(() => lastSent(page)).toEqual({ enabled: false, maxRunning: 4 });

  await region.getByRole("button", { name: "同时运行的委派上限说明" }).hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("子代理不计入");
  await expect(tooltip).toContainText("排队中的委派在 Host 重启后保留");

  await enabled.click();
  await expect(enabled).toBeChecked();
  await expect(limit).toBeVisible();
  await expect(limit).toHaveValue("4");
  await expect(limit).toHaveAttribute("min", "1");
  await expect(limit).toHaveAttribute("max", "32");
  await expect.poll(() => lastSent(page)).toEqual({ enabled: true, maxRunning: 4 });

  await limit.fill("0");
  await limit.press("Tab");
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  await expect(region.getByText("请输入 1～32 之间的整数。")).toBeVisible();
  await expect.poll(() => lastSent(page)).toEqual({ enabled: true, maxRunning: 4 });
  await limit.fill("2");
  await limit.press("Tab");
  await expect(limit).toHaveAttribute("aria-invalid", "false");
  await expect.poll(() => lastSent(page)).toEqual({ enabled: true, maxRunning: 2 });
  // Successful sync is silent.
  await expect(region.getByText("同步中…")).toBeHidden();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("codexhost.delegation-capacity.v1") ?? "null"),
    ),
  ).toEqual({ enabled: true, maxRunning: 2 });

  await page.reload();
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupDelegationCapacity")());
  await expect(enabled).toBeChecked();
  await expect(limit).toHaveValue("2");
  await expect.poll(() => lastSent(page)).toEqual({ enabled: true, maxRunning: 2 });
});

test("a Host without the delegation limit is reported rather than shown as applied", async ({
  page,
}) => {
  await setup(page, true);
  await expect(
    page.getByRole("region", { name: "委派", exact: true }).getByRole("status"),
  ).toHaveText("当前 Host 不支持");
});
