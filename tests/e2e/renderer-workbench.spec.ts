import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchStore } from "../../packages/host-runtime/src/workbench-store.js";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createDefaultRendererSettingsPages } from "./packages/renderer-extension/src/settings/pages.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
      import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";
      const messages = rendererSettingsMessages("zh-CN");
      const client = createRendererModelClient([{ sendRequest: async (method, params) => {
        const response = await fetch('/workbench-rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({method,params})});
        if (!response.ok) throw new Error('Configuration unavailable');
        return response.json();
      }}]);
      const pages = createDefaultRendererSettingsPages(messages, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => client);
      const shell = mountRendererSettingsShell(createRendererSettingsPageRegistry(pages), document, messages);
      shell.openSettings(undefined, "workbench");
      globalThis.workbenchFixture = { shell };
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
if (!bundle) throw new Error("Workbench fixture bundle missing");

let directory: string;
let store: WorkbenchStore;
let failRead = false;
let failWrite = false;
let writes = 0;
test.beforeEach(async ({ page }) => {
  directory = await mkdtemp(path.join(os.tmpdir(), "workbench-browser-"));
  store = new WorkbenchStore({ CODEXHOST_DATA_DIR: directory });
  failRead = false;
  failWrite = false;
  writes = 0;
  await page.route("http://localhost/**", async (route) => {
    if (route.request().url().endsWith("/workbench-rpc")) {
      const { method, params } = route.request().postDataJSON() as {
        method: string;
        params: unknown;
      };
      if ((method.endsWith("/get") && failRead) || (method.endsWith("/set") && failWrite)) {
        await route.fulfill({ status: 500, body: "Unavailable" });
        return;
      }
      try {
        const config = method.endsWith("/set") ? await store.set(params) : await store.get();
        if (method.endsWith("/set")) writes++;
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(config) });
      } catch {
        await route.fulfill({ status: 400, body: "Invalid configuration" });
      }
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><style>body{margin:0;font-family:system-ui}nav{width:56px;height:100vh}</style></head><body><nav data-app-navigation-rail><button data-sidebar-destination="builtin:home" aria-current="page">Home</button></nav><main>Conversation</main></body></html>',
    });
  });
  await page.setViewportSize({ width: 1200, height: 850 });
});
test.afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function open(page: Page) {
  await page.goto("http://localhost/workbench");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
}
async function fillRow(
  page: Page,
  index: number,
  name: string,
  category: string,
  icon: string,
  url: string,
) {
  const row = page.locator(".workbench-edit-row").nth(index);
  await row.getByLabel("名称", { exact: true }).fill(name);
  await row.getByLabel("分类", { exact: true }).selectOption(category);
  await row.getByLabel("图标", { exact: true }).fill(icon);
  await row.getByLabel("链接", { exact: true }).fill(url);
}

test("adds three categories, persists real local configuration, edits, removes and opens links", async ({
  page,
}, testInfo) => {
  await open(page);
  await expect(page.getByText("让常用入口触手可及。")).toBeVisible();
  await page.getByRole("button", { name: "添加入口", exact: true }).click();
  await fillRow(page, 0, "Reference library", "knowledge", "📖", "https://example.com/knowledge");
  await page.getByRole("button", { name: "添加入口", exact: true }).click();
  await fillRow(page, 1, "Project board", "projects", "🗂️", "https://example.com/projects");
  await page.getByRole("button", { name: "添加入口", exact: true }).click();
  await fillRow(page, 2, "Team conversation", "chats", "💬", "https://example.com/chat");
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(page.locator(".workbench-link")).toHaveCount(3);
  expect((await store.get()).entries.map((entry) => entry.name)).toEqual([
    "Reference library",
    "Project board",
    "Team conversation",
  ]);
  await open(page);
  await expect(page.locator(".workbench-link")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("workbench.png"), fullPage: true });
  await testInfo.attach("workbench", {
    path: testInfo.outputPath("workbench.png"),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 700, height: 850 });
  await expect(page.getByRole("button", { name: "管理入口" })).toBeVisible();
  expect(
    await page
      .locator(".settings-workbench")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 1200, height: 850 });
  const link = page.getByRole("link", { name: /Reference library/ });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  await page
    .context()
    .route("https://example.com/**", (route) => route.fulfill({ body: "Destination" }));
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL("https://example.com/knowledge");
  await popup.close();
  await page.getByRole("button", { name: "管理入口" }).click();
  await fillRow(page, 0, "Updated library", "knowledge", "KB", "https://example.com/new");
  await page
    .locator(".workbench-edit-row")
    .nth(1)
    .getByRole("button", { name: "移除入口" })
    .click();
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(page.locator(".workbench-link")).toHaveCount(2);
  await open(page);
  await expect(page.getByRole("link", { name: /Updated library/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Project board/ })).toHaveCount(0);
  expect(await readFile(path.join(directory, "workbench.json"), "utf8")).toContain('"icon": "KB"');
});

test("rejects script URLs without saving and renders user text literally", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "添加入口", exact: true }).click();
  await fillRow(page, 0, "<img src=x>", "knowledge", "<img>", "javascript:alert(1)");
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(
    page.getByText("请为每个入口填写名称、图标及有效的 HTTP(S) 链接，链接不能包含账号密码。"),
  ).toBeVisible();
  expect(writes).toBe(0);
  await page.getByLabel("链接", { exact: true }).fill("https://example.com/safe");
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(page.locator(".workbench-link")).toHaveCount(1);
  await expect(page.locator(".workbench-link strong")).toHaveText("<img src=x>");
  await expect(page.locator(".workbench-link-icon")).toHaveText("<img>");
  await expect(page.locator(".workbench-link img, .workbench-link script")).toHaveCount(0);
});

test("read and write failures retain data, retries recover, cancel discards only draft edits", async ({
  page,
}) => {
  failRead = true;
  await open(page);
  await expect(page.getByText("无法读取入口。请检查本地配置文件及其权限后重试。")).toBeVisible();
  await expect(page.getByRole("button", { name: "管理入口" })).toHaveCount(0);
  failRead = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("button", { name: "添加入口", exact: true }).click();
  await fillRow(page, 0, "Keep draft", "projects", "✅", "https://example.com/tasks");
  failWrite = true;
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(page.getByText("更改未保存，编辑内容仍保留。请检查本地配置后重试。")).toBeVisible();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue("Keep draft");
  expect((await store.get()).entries).toEqual([]);
  failWrite = false;
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(page.getByRole("link", { name: /Keep draft/ })).toBeVisible();
  await page.getByRole("button", { name: "管理入口" }).click();
  await page.getByRole("button", { name: "移除入口" }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("link", { name: /Keep draft/ })).toBeVisible();
  await page.getByRole("button", { name: "管理入口" }).click();
  await page.getByRole("button", { name: "移除入口" }).click();
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(page.getByText("让常用入口触手可及。")).toBeVisible();
  expect((await store.get()).entries).toEqual([]);
});
