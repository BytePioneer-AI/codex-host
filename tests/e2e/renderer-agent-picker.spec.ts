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

  const [triggerBox, menuBox] = await Promise.all([trigger.boundingBox(), menu.boundingBox()]);
  if (!triggerBox || !menuBox) throw new Error("Agent picker geometry is unavailable");

  expect(menuBox.x + menuBox.width).toBeCloseTo(triggerBox.x + triggerBox.width, 0);
  expect(menuBox.width).toBeCloseTo(200 * 1.6, 0);
  expect(triggerBox.y - (menuBox.y + menuBox.height)).toBeCloseTo(6 * 1.6, 0);
});
