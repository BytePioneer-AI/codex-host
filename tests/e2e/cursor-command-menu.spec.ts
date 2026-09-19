import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import type { HarnessAdapter } from "../../packages/harness-adapter/src/index.js";
import { createHarnessAdapter } from "../../packages/adapters/cursor-cli/src/plugin.js";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `import { mountRendererHarnessCommandControl } from "./packages/renderer-extension/src/renderer-harness-command-control.ts";
const control = mountRendererHarnessCommandControl(document.body, null, command => { globalThis.selectedCommand = command.id; });
control.setCommands(globalThis.commandCatalog.commands, globalThis.hasSession);`,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Missing command control bundle");

for (const managedRemoteHost of [false, true])
  for (const hasSession of [false, true]) {
    test(`cursor command button opens its real adapter catalog (hasSession=${hasSession}, managedRemoteHost=${managedRemoteHost})`, async ({
      page,
    }) => {
      const adapter: HarnessAdapter = createHarnessAdapter({
        platform: "darwin",
        managedRemoteHost,
        environment: { PATH: "" },
      });
      try {
        // This is the same adapter metadata read by the Host's command inspection RPC.
        const catalog = adapter.commandCatalog ?? { commands: [] };
        await page.setContent("<!doctype html><body></body>");
        await page.evaluate(
          ({ catalog, hasSession }) => {
            Reflect.set(globalThis, "commandCatalog", catalog);
            Reflect.set(globalThis, "hasSession", hasSession);
          },
          { catalog, hasSession },
        );
        await page.addScriptTag({ content: bundle });
        const trigger = page.locator("[data-codexhost-harness-command-control] > button");
        await expect(trigger).toBeEnabled();
        await trigger.click();
        const menu = page.locator("[data-codexhost-harness-command-menu]");
        await expect(menu).toBeVisible();
        await expect(menu.locator('[role="menuitem"]')).toHaveCount(1);
        const cost = menu.locator('[data-command-id="cursor.copy-request-id"]');
        if (hasSession) {
          await cost.click();
          expect(await page.evaluate(() => Reflect.get(globalThis, "selectedCommand"))).toBe(
            "cursor.copy-request-id",
          );
        } else {
          await expect(cost).toBeDisabled();
        }
      } finally {
        await adapter.close();
      }
    });
  }
