import { expect, test } from "@playwright/test";
import { build } from "esbuild";

interface FixtureWindow extends Window {
  nativeMenu?: { submenu?: Record<string, unknown>[] }[];
  chooseNativeMenu(id: string): void;
  copied?: string;
  opened?: string;
  nativeServices: { clipboard: { writeText(text: string): Promise<unknown> } };
  originalClipboard: unknown;
  stopLinks(): void;
}

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererThreadLinks } from "./packages/renderer-extension/src/renderer-thread-links.ts";
      const localId = "12345678-1234-4123-8123-123456789abc";
      const remoteId = "22345678-1234-4123-8123-123456789abc";
      const routes = new Map(["local", "ssh:linux"].map(hostId => [hostId, { hostId, manager: { sendRequest: async () => ({ machineId: hostId === "local" ? localId : remoteId }) } }]));
      for (const row of document.querySelectorAll("[data-app-action-sidebar-thread-row]")) {
        const attributes = Object.fromEntries([...row.attributes].map(a => [a.name, a.value]));
        row.__reactFiber$fixture = { memoizedProps: { conversationId: row.dataset.thread, dataAttributes: attributes }, return: null };
        row.addEventListener("click", () => window.opened = row.dataset.thread);
      }
      // Desktop's native clipboard service is a callable RPC proxy, separate from navigator.clipboard.
      const writeText = async text => { window.copied = text; };
      window.originalClipboard = new Proxy(function(){}, { get: (_target, key) => key === "writeText" ? writeText : undefined });
      window.nativeServices = { clipboard: window.originalClipboard };
      window.electronBridge = Object.freeze({ showContextMenu: async items => {
        window.nativeMenu = items;
        return new Promise(resolve => { window.chooseNativeMenu = id => resolve({ id }); });
      } });
      document.addEventListener("contextmenu", async event => {
        event.preventDefault();
        const row = event.target.closest("[data-app-action-sidebar-thread-row]");
        const selected = await window.electronBridge.showContextMenu([{ id: "copy-actions", label: "复制", submenu: [{ id: "copy-deeplink", label: "复制深度链接", accelerator: "Alt+Command+L", icon: "copy" }, { id: "copy-conversation-markdown", label: "复制为 Markdown" }] }]);
        if (selected.id === "copy-deeplink") await window.nativeServices.clipboard.writeText(row ? "codex://threads/"+row.dataset.thread+"?hostId="+encodeURIComponent(row.getAttribute("data-app-action-sidebar-thread-host-id")) : "unrelated");
      });
      window.stopLinks = installRendererThreadLinks(() => ({ forHost: id => routes.get(id) ?? null, knownHostIds: () => [...routes.keys()] }));
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  loader: { ".png": "dataurl", ".svg": "text" },
});
const bundle = outputFiles[0]?.text ?? "";

test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:43439/**", (route) =>
    route.fulfill(
      route.request().url().endsWith("/services.js")
        ? {
            contentType: "text/javascript",
            body: "export const appServices = window.nativeServices;",
          }
        : {
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><html><head><link rel="modulepreload" href="/services.js"></head><body>
    <button data-thread="local-thread" data-app-action-sidebar-thread-row="local-row" data-app-action-sidebar-thread-id="local:local-thread" data-app-action-sidebar-thread-host-id="local">本机会话</button>
    <button data-thread="linux-thread" data-app-action-sidebar-thread-row="linux-row" data-app-action-sidebar-thread-id="ssh:linux:linux-thread" data-app-action-sidebar-thread-host-id="ssh:linux">Linux 会话</button>
    <button id="unrelated">其他区域</button>
  </body></html>`,
          },
    ),
  );
  await page.goto("http://127.0.0.1:43439/");
  await page.addScriptTag({ content: bundle });
});

test("native Copy deeplink copies a machine-qualified link without replacing the native menu", async ({
  page,
}) => {
  await page.getByText("Linux 会话", { exact: true }).click({ button: "right" });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as FixtureWindow).nativeMenu?.[0]?.submenu?.[0]),
    )
    .toEqual({
      id: "copy-deeplink",
      label: "复制深度链接",
      accelerator: "Alt+Command+L",
      icon: "copy",
    });
  await page.evaluate(() => (window as unknown as FixtureWindow).chooseNativeMenu("copy-deeplink"));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).copied))
    .toBe(
      "thread://linux-thread?hostId=ssh%3Alinux&machineId=22345678-1234-4123-8123-123456789abc",
    );
  await page.getByText("本机会话", { exact: true }).click({ button: "right" });
  await page.evaluate(() => (window as unknown as FixtureWindow).chooseNativeMenu("copy-deeplink"));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).copied))
    .toContain("thread://local-thread?hostId=local&machineId=12345678-");
});

test("keeps unrelated clipboard writes intact, restores the service on disposal, and resolves machine links", async ({
  page,
}) => {
  await page.locator("#unrelated").click({ button: "right" });
  await page.evaluate(() => (window as unknown as FixtureWindow).chooseNativeMenu("copy-deeplink"));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).copied))
    .toBe("unrelated");
  await page.getByText("Linux 会话", { exact: true }).click({ button: "right" });
  await page.evaluate(async () => {
    await (window as unknown as FixtureWindow).nativeServices.clipboard.writeText(
      "codex://threads/some-other-thread",
    );
  });
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).copied)).toBe(
    "codex://threads/some-other-thread",
  );
  await page.evaluate(async () => {
    await (window as unknown as FixtureWindow).nativeServices.clipboard.writeText(
      "codex://threads/linux-thread?hostId=ssh%3Alinux&threadAccess=shared",
    );
  });
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).copied)).toBe(
    "codex://threads/linux-thread?hostId=ssh%3Alinux&threadAccess=shared",
  );
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href =
      "thread://linux-thread?hostId=local&machineId=22345678-1234-4123-8123-123456789abc";
    anchor.textContent = "打开 Linux 会话";
    document.body.append(anchor);
  });
  await page.getByRole("link", { name: "打开 Linux 会话" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).opened))
    .toBe("linux-thread");
  await page.evaluate(() => (window as unknown as FixtureWindow).stopLinks());
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).nativeServices.clipboard ===
        (window as unknown as FixtureWindow).originalClipboard,
    ),
  ).toBe(true);
});
