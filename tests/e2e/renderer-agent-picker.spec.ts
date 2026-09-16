import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import {
        mountRendererAgentPicker,
        renderRendererAgentPicker,
      } from "./packages/renderer-extension/src/renderer-agent-picker.ts";

      import { createAgentGroupPreferenceStore } from "./packages/renderer-extension/src/agent-group-preference.ts";

      globalThis.setupInstallationOrderPicker = () => {
        const preference = createAgentGroupPreferenceStore(null);
        const control = mountRendererAgentPicker(
          "installation-order", ["codex", "pi", "claude-code", "grok", "omp"],
          () => {}, () => {}, undefined, preference,
        );
        document.body.append(control.root);
        globalThis.updateInstallationOrderPicker = (availability) => {
          renderRendererAgentPicker(control, { agent: "codex", phase: "draft" }, "ready", false, availability);
        };
        globalThis.groupInstallationOrderPicker = () => {
          preference.moveAgent("pi", "more");
          preference.moveAgent("grok", "more");
        };
      };

      globalThis.setupRendererAgentPicker = () => {
        document.documentElement.style.setProperty("--codex-window-zoom", "1.6");

        const shell = document.createElement("div");
        shell.style.position = "fixed";
        shell.style.inset = "0";
        shell.style.display = "flex";
        shell.style.alignItems = "flex-end";
        shell.style.justifyContent = "center";
        shell.style.boxSizing = "border-box";
        shell.style.paddingBottom = "60px";
        shell.style.width = "calc(100vw / var(--codex-window-zoom))";
        shell.style.height = "calc(100vh / var(--codex-window-zoom))";
        shell.style.zoom = "var(--codex-window-zoom)";

        const control = mountRendererAgentPicker(
          "test-composer",
          ["codex", "pi"],
          () => {},
          () => {},
        );
        shell.append(control.root);
        document.body.append(shell);
        renderRendererAgentPicker(
          control,
          { agent: "codex", phase: "draft" },
          "ready",
          false,
          { pi: "ready" },
        );
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-agent-picker-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Agent picker E2E bundle was not generated");

test("keeps the Agent menu anchored inside the Codex window zoom", async ({ page }) => {
  await page.setViewportSize({ width: 1_920, height: 1_440 });
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererAgentPicker");
    if (typeof setup !== "function") throw new Error("Agent picker setup is unavailable");
    setup();
  });

  const trigger = page.locator(
    '[data-codexhost-agent-control="test-composer"] > button[aria-haspopup="menu"]',
  );
  const menu = page.locator("#test-composer-agent-menu");
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.locator('button[data-agent="codex"]')).toHaveCount(1);
  await expect(menu.locator("[data-codex-account-id]")).toHaveCount(0);

  const [triggerBox, menuBox] = await Promise.all([trigger.boundingBox(), menu.boundingBox()]);
  if (!triggerBox || !menuBox) throw new Error("Agent picker geometry is unavailable");

  expect(menuBox.x + menuBox.width).toBeCloseTo(triggerBox.x + triggerBox.width, 0);
  expect(menuBox.width).toBeCloseTo(224 * 1.6, 0);
  expect(triggerBox.y - (menuBox.y + menuBox.height)).toBeCloseTo(6 * 1.6, 0);
});

test("places only uninstalled Harnesses last and restores order after installation", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupInstallationOrderPicker")());
  const rows = page.locator("#installation-order-agent-menu button[data-agent]");
  const order = () =>
    rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-agent")));
  const update = async (availability: Record<string, string>) => {
    await page.evaluate(
      (value) => Reflect.get(globalThis, "updateInstallationOrderPicker")(value),
      availability,
    );
  };
  const defaults = ["codex", "pi", "claude-code", "grok", "omp"];
  await update({});
  expect(await order()).toEqual(defaults);
  await update({
    pi: "notInstalled",
    "claude-code": "error",
    grok: "notInstalled",
    omp: "checking",
  });
  expect(await order()).toEqual(["codex", "claude-code", "omp", "pi", "grok"]);
  await update({ pi: "ready", "claude-code": "unavailable", grok: "ready", omp: "ready" });
  expect(await order()).toEqual(defaults);
  await update({
    pi: "notInstalled",
    "claude-code": "notInstalled",
    grok: "notInstalled",
    omp: "notInstalled",
  });
  expect(await order()).toEqual(defaults);
  await update({ pi: "notInstalled", "claude-code": "notInstalled", grok: "ready", omp: "ready" });
  await page.evaluate(() => Reflect.get(globalThis, "groupInstallationOrderPicker")());
  // Main/More membership remains a user preference; sorting stays within each section.
  expect(await order()).toEqual(["codex", "omp", "claude-code", "grok", "pi"]);
  await update({ pi: "ready", "claude-code": "ready", grok: "ready", omp: "ready" });
  expect(await order()).toEqual(["codex", "claude-code", "omp", "pi", "grok"]);
});
