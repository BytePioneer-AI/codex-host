import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
test.use({
  locale: "en-US",
  ...(browserExecutable ? { launchOptions: { executablePath: browserExecutable } } : {}),
});

const { outputFiles } = await build({
  entryPoints: ["packages/renderer-extension/src/console-entry.ts"],
  absWorkingDir: path.resolve(import.meta.dirname, "../.."),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Missing console layout fixture bundle");

for (const width of [1920, 640]) {
  test(`restart confirmation preserves readable status at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 });
    let restartRequests = 0;
    await page.route("http://console-layout.test/**", async (route) => {
      const routePath = new URL(route.request().url()).pathname;
      if (routePath === "/") {
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
      } else if (routePath === "/api/overview") {
        await route.fulfill({
          json: {
            console: { version: "0.13.3-5", distribution: null },
            inspect: { runtime: { running: true }, desktop: null },
            startup: [],
            controller: null,
            launchAvailable: true,
            liveVoice: { inject: true, envOverride: null },
            summary: { state: "running", detail: null },
            issueUrl: "",
            hostAvailable: false,
          },
        });
      } else {
        if (routePath === "/api/restart") restartRequests += 1;
        await route.fulfill({ json: {} });
      }
    });
    await page.goto("http://console-layout.test/");
    await page.addScriptTag({ content: bundle });
    await page.getByRole("button", { name: "Restart codexhost", exact: true }).click();
    const copy = page.locator(".console-hero__copy");
    const warning = page.getByRole("status").filter({ hasText: "Restart closes Desktop" });
    await expect(warning).toBeVisible();
    const copyBox = await copy.boundingBox();
    const warningBox = await warning.boundingBox();
    const heroBox = await page.locator(".console-hero").boundingBox();
    if (!copyBox || !warningBox || !heroBox) throw new Error("Missing restart confirmation layout");
    expect(copyBox.width).toBeGreaterThan(200);
    expect(copyBox.height).toBeLessThan(100);
    expect(warningBox.y).toBeGreaterThanOrEqual(copyBox.y + copyBox.height);
    expect(heroBox.height).toBeLessThan(350);
    expect(restartRequests).toBe(0);
    await page.screenshot({ path: test.info().outputPath("restart-confirmation.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(restartRequests).toBe(0);
  });
}
