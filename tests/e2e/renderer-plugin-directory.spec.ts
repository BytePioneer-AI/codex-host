import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { readFile } from "node:fs/promises";

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

const iconPlugins = await Promise.all(
  ["pi", "kiro-cli", "hermes", "grok", "omp"].map(async (id) => {
    const root = path.resolve(import.meta.dirname, `../../packages/adapters/${id}`);
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const image = await readFile(path.join(root, manifest.icon));
    return {
      id,
      name: manifest.name,
      version: manifest.version,
      icon: `data:image/${manifest.icon.endsWith(".svg") ? "svg+xml" : "png"};base64,${image.toString("base64")}`,
      iconStyle: manifest.iconStyle,
    };
  }),
);
const iconFixture = await build({
  stdin: {
    contents: `
      import { createRendererAgentIcon } from "./packages/renderer-extension/src/renderer-agent-icon.ts";
      import { harnessPluginDescriptorSchema } from "@codexhost/shared-contracts";
      for (const data of ${JSON.stringify(iconPlugins)}) {
        const plugin = harnessPluginDescriptorSchema.parse(data);
        const row = document.createElement("div");
        row.id = plugin.id;
        row.style.cssText = "display:flex;align-items:center;gap:20px;margin:24px";
        for (const size of [14, 20, 26]) row.append(createRendererAgentIcon(plugin.id, size, document, plugin));
        row.append(plugin.name);
        document.getElementById("gallery").append(row);
      }
      document.getElementById("light").addEventListener("click", () => {
        document.body.style.background = "#ffffff";
        document.body.style.color = "#222222";
      });
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const iconFixtureBundle = iconFixture.outputFiles[0]?.text;
if (!iconFixtureBundle) throw new Error("Missing icon fixture bundle");

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

test("preserves original plugin artwork and Pi text coloring in both themes", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(`<!doctype html><body style="background:#202020;color:#eeeeee;font:16px system-ui">
    <button id="light">Light theme</button><div id="gallery"></div>
  </body>`);
  await page.addScriptTag({ content: iconFixtureBundle });
  const pi = page.locator("#pi > span").first();
  await expect(pi).toHaveCSS("background-color", "rgb(238, 238, 238)");
  await expect(pi).toHaveCSS("width", "14px");
  await expect(pi).toHaveCSS("mask-image", /^url\("data:image\/svg\+xml;base64,/);
  for (const id of ["kiro-cli", "hermes", "grok", "omp"]) {
    await expect(page.locator(`#${id} img`).first()).toBeVisible();
    await expect.poll(() => page.locator(`#${id} img`).first().evaluate(
      (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
    )).toBe(true);
  }
  await expect(page.locator("#hermes img").first()).toHaveCSS("padding", "1px");
  await page.screenshot({ path: info.outputPath("icons-dark.png") });
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect(pi).toHaveCSS("background-color", "rgb(34, 34, 34)");
  await page.screenshot({ path: info.outputPath("icons-light.png") });
  expect(errors).toEqual([]);
});
