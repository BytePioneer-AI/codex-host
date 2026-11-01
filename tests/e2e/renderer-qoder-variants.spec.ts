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
      const availability = { qoder: "ready", "qoder-cn": "ready" };
      const control = mountRendererAgentPicker("qoder-variants", ["codex", "qoder", "qoder-cn"], (agent) => {
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
if (!bundle) throw new Error("Qoder picker test bundle was not generated");

test("Qoder and Qoder CN appear separately and select distinct Harness routes", async ({
  page,
}, testInfo) => {
  await page.setContent(
    '<!doctype html><body style="display:flex;align-items:flex-end;height:90vh"></body>',
  );
  await page.addScriptTag({ content: bundle });
  const trigger = page.locator('[data-codexhost-agent-control="qoder-variants"] > button');
  const global = page.getByRole("menuitemradio", { name: "Qoder", exact: true });
  const cn = page.getByRole("menuitemradio", { name: "Qoder CN", exact: true });
  await trigger.click();
  await expect(global).toBeEnabled();
  await expect(cn).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("qoder-variants.png") });
  await cn.click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "selectedHarness"))).toBe("qoder-cn");
  await expect(trigger).toHaveAttribute("aria-label", "Select Agent, current Qoder CN");
  await trigger.click();
  await global.click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "selectedHarness"))).toBe("qoder");
  await page.evaluate(() => Reflect.get(globalThis, "setAvailability")("qoder-cn", "notInstalled"));
  await trigger.click();
  await expect(global).toBeEnabled();
  await expect(cn).toBeDisabled();
  await page.getByRole("button", { name: "Install Qoder CN", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "installAgent"))).toBe("qoder-cn");
});
