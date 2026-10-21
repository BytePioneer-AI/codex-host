import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsPlugins } from "../../packages/host-runtime/src/settings-plugins.js";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
    import { installRendererSettingsLifecycle } from "./packages/renderer-extension/src/renderer-settings-lifecycle.ts";
    import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";
    const client = createRendererModelClient([{sendRequest: async (method,params) => {
      const response = await fetch('/settings-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
      if (!response.ok) throw new Error('Plugin unavailable');
      return response.json();
    }}]);
    globalThis.settingsFixture = installRendererSettingsLifecycle(window,{getSettingsPageClient:()=>client});
  `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Settings plugin fixture bundle missing");
let data: string;
let root: string;
let plugins: SettingsPlugins;
let failList = false;
let failRead = false;
let reads = 0;
let readBarrier: Promise<void> | null = null;
test.beforeEach(async ({ page }) => {
  data = await mkdtemp(path.join(os.tmpdir(), "settings-plugin-browser-"));
  root = path.join(data, "settings-plugins");
  await cp(path.resolve(import.meta.dirname, "../../examples/settings-plugins"), root, {
    recursive: true,
  });
  plugins = new SettingsPlugins({ CODEXHOST_DATA_DIR: data });
  failList = false;
  failRead = false;
  reads = 0;
  readBarrier = null;
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.route("http://localhost/**", async (route) => {
    if (route.request().url().endsWith("/settings-rpc")) {
      const { method, params } = route.request().postDataJSON();
      try {
        if ((method.endsWith("/list") && failList) || (method.endsWith("/read") && failRead))
          throw new Error("Unavailable");
        if (method.endsWith("/read")) {
          reads++;
          if (readBarrier) await readBarrier;
        }
        const value = method.endsWith("/list") ? await plugins.list() : await plugins.read(params);
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
      } catch {
        await route.fulfill({ status: 500, body: "Unavailable" });
      }
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><style>body{margin:0;font-family:system-ui}nav{width:56px;height:100vh}</style></head><body><nav data-app-navigation-rail><div><button data-sidebar-destination="builtin:home">Home</button></div></nav><main>Conversation</main></body></html>',
    });
  });
});
test.afterEach(async () => {
  if (data) await rm(data, { recursive: true, force: true });
});
async function setup(page: Page) {
  await page.goto("http://localhost/settings-test");
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "Open codexhost settings", exact: true }).click();
}
async function reopen(page: Page) {
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Open codexhost settings", exact: true }).click();
}

test("registers a local plugin page, runs its own UI, unloads on navigation and reflects local disablement", async ({
  page,
}, info) => {
  await setup(page);
  const nav = page.getByRole("button", { name: "Example page", exact: true });
  await expect(nav).toBeVisible();
  expect(reads).toBe(0);
  await expect(nav).toContainText("🧩");
  await nav.click();
  const frame = page.frameLocator('iframe[title="Example page"]');
  await expect(frame.getByRole("heading", { name: "Example page" })).toBeVisible();
  await frame.getByRole("button", { name: "Increase count" }).click();
  await expect(frame.getByLabel("Count")).toHaveText("1");
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.locator("iframe")).toHaveAttribute("referrerpolicy", "no-referrer");
  await page.screenshot({ path: info.outputPath("settings-plugin-page.png"), fullPage: true });
  await info.attach("settings-plugin-page", {
    path: info.outputPath("settings-plugin-page.png"),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await nav.click();
  await expect(frame.getByLabel("Count")).toHaveText("0");
  await writeFile(path.join(root, "enabled.json"), JSON.stringify({ version: 1, enabled: [] }));
  await reopen(page);
  await expect(nav).toHaveCount(0);
  await expect(page.getByRole("button", { name: "About", exact: true })).toBeVisible();
});

test("isolates the page from host DOM, storage and network access", async ({ page }) => {
  await writeFile(
    path.join(root, "example-page/index.html"),
    `<div id="result"></div><script>
    const blocked = [];
    try { parent.document.body.dataset.pluginTouched='yes'; } catch { blocked.push('parent'); }
    try { localStorage.setItem('host-secret','stolen'); } catch { blocked.push('storage'); }
    fetch('https://example.com/plugin-probe').then(()=>{document.querySelector('#result').textContent='NETWORK_ALLOWED';},()=>{
      blocked.push('network'); document.querySelector('#result').textContent=blocked.sort().join(',');
    });
  </script>`,
  );
  const external: string[] = [];
  await page.context().route("https://example.com/**", (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  await setup(page);
  await page.getByRole("button", { name: "Example page", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText("network,parent,storage");
  expect(external).toEqual([]);
  expect(await page.evaluate(() => document.body.dataset.pluginTouched)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem("host-secret"))).toBeNull();
});

test("does not remount a plugin after navigating away during a delayed read", async ({ page }) => {
  let release: () => void = () => {};
  readBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await setup(page);
  await page.getByRole("button", { name: "Example page", exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await page.getByRole("button", { name: "About", exact: true }).click();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/settings-rpc") &&
      candidate.request().postDataJSON().method.endsWith("/read"),
  );
  release();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "About", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("keeps built-in settings usable on discovery failure and retries page read failures", async ({
  page,
}) => {
  failList = true;
  await setup(page);
  await page.getByRole("button", { name: "Extension pages", exact: true }).click();
  await expect(page.getByText(/Some extension pages are unavailable/)).toBeVisible();
  await page.getByRole("button", { name: "About", exact: true }).click();
  failList = false;
  await reopen(page);
  failRead = true;
  await page.getByRole("button", { name: "Example page", exact: true }).click();
  await expect(page.getByText(/Could not load the extension page/)).toBeVisible();
  failRead = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.frameLocator("iframe").getByRole("button", { name: "Increase count" }),
  ).toBeVisible();
  expect(await readFile(path.join(root, "enabled.json"), "utf8")).toContain("example-page");
});
