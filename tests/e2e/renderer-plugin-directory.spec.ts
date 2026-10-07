import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

if (process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH) {
  test.use({ launchOptions: { executablePath: process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH } });
}

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountRendererAgentPicker, renderRendererAgentPicker } from "./packages/renderer-extension/src/renderer-agent-picker.ts";
      import { harnessPluginDescriptorSchema } from "@codexhost/shared-contracts";
      import { modelSelectionForAgent } from "./packages/renderer-extension/src/versioned-renderer-adapter.ts";
      import { restoredThreadOwnership } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      const plugins = location.hash === "#empty" ? [] : [harnessPluginDescriptorSchema.parse({
        id: "never-compiled-harness", name: "Independent Harness", version: "1.0.0",
        icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#4277ef"/><path d="M7 6h3v12H7zm7 0h3v12h-3z" fill="white"/></svg>'),
        links: { installation: "https://example.com/install" },
      })];
      const state = { agent: "codex", phase: "draft" };
      const availability = Object.fromEntries(plugins.map(({id}) => [id, "ready"]));
      const output = document.getElementById("selection");
      const control = mountRendererAgentPicker("dynamic-plugin", ["codex", ...plugins.map(({id}) => id)], agent => {
        state.agent = agent;
        if (agent !== "codex") {
          const selection = modelSelectionForAgent(null, null, agent, {id: "native-model"}, "high", "ask");
          const owner = restoredThreadOwnership({ owner: "external", harnessId: agent, transportModelId: selection.model, locked: true,
            history: {fork: false, forkAcrossCwd: false, rollbackLastTurn: false} });
          output.textContent = owner.agent + " / " + owner.model.id + " / " + owner.thinkingOptionId + " / " + owner.permissionModeId;
        } else output.textContent = "Official Codex";
        renderRendererAgentPicker(control, state, "ready", false, availability);
      }, () => {}, undefined, undefined, plugins);
      document.getElementById("composer").prepend(control.root);
      renderRendererAgentPicker(control, state, "ready", false, availability);
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "plugin-directory-e2e.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Missing Renderer fixture bundle");

test("unknown plugin presentation and configuration work without a Renderer registration", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(`<!doctype html><body style="margin:0;background:#202020;color:#eee;font:16px system-ui">
    <h1 style="margin:32px">Host plugin directory fixture</h1>
    <p id="selection" style="margin:32px">Official Codex</p>
    <section id="composer" style="position:fixed;left:80px;bottom:80px;padding:16px;border:1px solid #555;border-radius:12px;display:flex;align-items:center;gap:16px">New Thread</section>
  </body>`);
  await page.addScriptTag({ content: bundle });
  const trigger = page.getByRole("button", { name: "Select Agent, current Codex", exact: true });
  await expect(trigger).toBeVisible();
  await page.screenshot({ path: info.outputPath("01-initial.png") });
  await trigger.click();
  const plugin = page.getByRole("menuitemradio", { name: "Independent Harness", exact: true });
  await expect(plugin).toBeVisible();
  await expect(plugin.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  await page.screenshot({ path: info.outputPath("02-directory.png") });
  await plugin.click();
  await expect(
    page.getByRole("button", { name: "Select Agent, current Independent Harness", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#selection")).toHaveText(
    "never-compiled-harness / native-model / high / ask",
  );
  await page.screenshot({ path: info.outputPath("03-selected.png") });
  expect(errors).toEqual([]);
});
