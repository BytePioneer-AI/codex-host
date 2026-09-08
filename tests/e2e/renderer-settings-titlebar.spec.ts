import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
      const shell = mountRendererSettingsShell();
      document.querySelector("button").addEventListener("click", event => {
        shell.openSettings(event.currentTarget, "about");
      });
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-titlebar-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});

const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Titlebar settings fixture bundle missing");

for (const titlebarHeight of [0, 36, 54]) {
  test(`keeps settings below a ${titlebarHeight}px titlebar when resizing`, async ({ page }) => {
    await page.setContent('<!doctype html><button id="opener">Settings</button>');
    await page.addScriptTag({ content: bundle });
    // Browser fixtures have no native overlay; supply its measured CSS input.
    // The installed Electron window separately verifies the env() integration.
    if (titlebarHeight) {
      await page.locator("[data-codexhost-settings-shell]").evaluate((root, height) => {
        (root as HTMLElement).style.setProperty("--settings-titlebar-height", `${height}px`);
      }, titlebarHeight);
    }
    for (const viewport of [
      { width: 1130, height: 744 },
      { width: 1440, height: 1000 },
      { width: 720, height: 600 },
      { width: 390, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator("#opener").click();
      const dialog = page.getByRole("dialog");
      const gap = viewport.width <= 720 ? 8 : 16;
      const box = await dialog.boundingBox();
      if (!box) throw new Error("Missing settings dialog");
      expect(box.y).toBeGreaterThanOrEqual(titlebarHeight + gap - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - gap + 1);
      expect(box.x).toBeGreaterThanOrEqual(gap - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - gap + 1);
      expect(
        await dialog.evaluate((element) =>
          getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        ),
      ).toBe("no-drag");
      await page.screenshot({
        path: test.info().outputPath(`titlebar-${titlebarHeight}-${viewport.width}.png`),
      });
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.locator("#opener")).toBeFocused();
      await page.locator("#opener").click();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(page.locator("#opener")).toBeFocused();
    }
  });
}
