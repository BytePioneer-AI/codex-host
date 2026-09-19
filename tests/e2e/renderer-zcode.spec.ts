import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountRendererAgentPicker, renderRendererAgentPicker } from "./packages/renderer-extension/src/renderer-agent-picker.ts";
      import { modelSelectionForAgent } from "./packages/renderer-extension/src/versioned-renderer-adapter.ts";
      import { decodeHarnessPluginRoute } from "@codexhost/shared-contracts";
      const state = { agent: "codex", phase: "draft" };
      const availability = { zcode: "ready" };
      const control = mountRendererAgentPicker("zcode", ["codex", "zcode"], (agent) => {
        state.agent = agent;
        const selection = modelSelectionForAgent(null, null, agent);
        globalThis.selectedHarness = decodeHarnessPluginRoute(selection.model).harnessId;
        render();
      }, (agent) => { globalThis.installAgent = agent; });
      function render() { renderRendererAgentPicker(control, state, "ready", false, availability); }
      globalThis.setAvailability = (agent, status) => { availability[agent] = status; render(); };
      document.body.append(control.root);
      render();
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  loader: { ".svg": "dataurl", ".png": "dataurl" },
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("ZCode picker test bundle was not generated");

test("ZCode selects its shared Harness route and offers installation when missing", async ({
  page,
}, testInfo) => {
  await page.setContent(
    '<!doctype html><body style="display:flex;align-items:flex-end;height:90vh"></body>',
  );
  await page.addScriptTag({ content: bundle });
  const trigger = page.locator('[data-codexhost-agent-control="zcode"] > button');
  const option = page.getByRole("menuitemradio", { name: "ZCode", exact: true });
  await trigger.click();
  await expect(option).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("zcode-picker.png") });
  await option.click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "selectedHarness"))).toBe("zcode");
  await expect(trigger).toHaveAttribute("aria-label", "Select Agent, current ZCode");
  await page.evaluate(() => Reflect.get(globalThis, "setAvailability")("zcode", "notInstalled"));
  await trigger.click();
  await expect(option).toBeDisabled();
  await page.getByRole("button", { name: "Install ZCode", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "installAgent"))).toBe("zcode");
});
