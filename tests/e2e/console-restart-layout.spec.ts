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

for (const width of [1280, 430]) {
  test(`shared console Voice page and navigation fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.route("http://console-layout.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/")
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
      if (pathname === "/api/overview")
        return route.fulfill({
          json: {
            console: { version: "0.13.3-5", distribution: null },
            inspect: { runtime: { running: true }, desktop: null },
            startup: [],
            controller: null,
            launchAvailable: true,
            liveVoice: { inject: true, envOverride: null },
            summary: { state: "running" },
            issueUrl: "",
            hostAvailable: false,
          },
        });
      if (pathname === "/api/voice-settings")
        return route.fulfill({
          json: {
            settings: {
              inject: true,
              chatExperience: "chatgpt",
              chatConnection: "desktop",
              workConnection: "desktop",
            },
            initialized: true,
            revision: "1",
            activeInject: true,
            envOverride: null,
            activeEnvOverride: null,
            activeCall: false,
            routesActive: true,
            gatewayReady: true,
            restartAvailable: true,
            restart: { phase: "idle", error: null },
          },
        });
      return route.fulfill({ json: {} });
    });
    await page.goto("http://console-layout.test/#live-voice");
    await page.addScriptTag({ content: bundle });
    await expect(page.getByRole("combobox", { name: "Voice experience", exact: true })).toHaveValue(
      "chatgpt",
    );
    await expect(page.getByText("Voice", { exact: true }).filter({ visible: true })).toHaveCount(
      width < 760 ? 1 : 2,
    );
    const overflow = await page
      .locator(".console-app")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(false);
    if (width < 760) {
      const menu = page.locator(".console-menu-button");
      await menu.click();
      await expect(page.getByRole("button", { name: "Voice", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Voice", exact: true }).click();
      await expect(menu).toHaveAttribute("aria-expanded", "false");
    }
    await page.screenshot({
      path: test.info().outputPath(`console-voice-${width}.png`),
      fullPage: true,
    });
  });
}
