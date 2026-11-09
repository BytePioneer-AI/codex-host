import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { startConsoleServer } from "../../packages/console-server/src/server.js";
import { consolePaths } from "../../packages/console-server/src/paths.js";
import { connectServer } from "../../packages/web-server/test/support/connect-devices.js";
import { fakeServe } from "../../packages/web-server/test/support/serve-control.js";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
test.use({
  locale: "zh-CN",
  launchOptions: browserExecutable ? { executablePath: browserExecutable } : {},
});
test.describe.configure({ mode: "serial" });
const { outputFiles } = await build({
  stdin: {
    contents:
      'import { startConsoleApp } from "./packages/renderer-extension/src/console/app.ts"; startConsoleApp(document);',
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});

const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Console fixture bundle is missing");

let cleanups: (() => unknown)[];
test.beforeEach(() => {
  cleanups = [];
});
test.afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function fixture() {
  // The repository's Web fixtures only need the owner's teardown registration.
  const owner = {
    after: (cleanup: () => unknown) => cleanups.unshift(cleanup),
  } as unknown as TestContext;
  const root = await mkdtemp(path.join(tmpdir(), "console-services-browser-"));
  cleanups.unshift(() => rm(root, { recursive: true, force: true }));
  const cli = fakeServe(owner);
  let web: Awaited<ReturnType<typeof connectServer>> | undefined;
  let webOpens = 0;
  let stops = 0;
  let exited = false;
  let base = "";
  const ensureWeb = async () => {
    if (web) return;
    web = await connectServer(owner, cli.environment, true);
    await writeFile(
      path.join(root, "web-service-ready.json"),
      JSON.stringify({
        pid: process.pid,
        web_pid: process.pid,
        loginUrl: `${web.url}?token=${web.token}`,
      }),
      { mode: 0o600 },
    );
  };
  const running = await startConsoleServer({
    port: 0,
    version: "fixture",
    paths: consolePaths({ CODEXHOST_DATA_DIR: root }),
    installation: {
      appDirectory: root,
      distribution: null,
      launcherExecutable: path.join(root, "fake-launcher"),
    },
    pageScript: bundle,
    host: {
      available: async () => false,
      request: async () => {
        throw new Error("Host offline");
      },
    },
    updates: {
      check: async () => ({
        currentVersion: "fixture",
        installation: null,
        latestVersion: null,
        updateAvailable: false,
        installationAvailable: false,
        releaseNotes: null,
        releaseNotesUrl: null,
        status: null,
        error: null,
      }),
      status: async () => ({ status: null }),
      start: async () => {
        throw new Error("not available");
      },
    },
    harnesses: {
      list: async () => [],
      setLaunchPath: async () => {
        throw new Error("not available");
      },
    },
    announcement: async () => null,
    inspect: async () => ({
      schemaVersion: 1,
      launcherVersion: "fixture",
      launcherExecutable: "fixture",
      desktop: null,
      desktopError: "fixture: Desktop missing",
      runtime: { running: false, descriptorPath: null, launcherPid: null },
    }),
    service: async (_command, args, environment) => {
      expect(environment.CODEXHOST_DATA_DIR).toBe(root);
      if (args[0] === "web") {
        webOpens++;
        await ensureWeb();
      } else if (args[0] === "stop") {
        stops++;
        if (web) await web.stop();
        await fetch(`${base}/api/shutdown`, {
          method: "POST",
          headers: { "x-codexhost-console": "1" },
        });
      } else throw new Error("Unexpected fixture command");
    },
    onExit: () => {
      exited = true;
      void running.close();
    },
  });
  cleanups.unshift(() => running.close());
  base = `http://127.0.0.1:${running.port}`;
  return {
    base,
    cli,
    ensureWeb,
    web: () => {
      if (!web) throw new Error("Fixture Web has not started");
      return web;
    },
    webOpens: () => webOpens,
    stops: () => stops,
    exited: () => exited,
  };
}

test("overview opens Web; Stop cancellation is inert, confirmation shows stopped instead of offline", async ({
  page,
}) => {
  const server = await fixture();
  await page.goto(server.base);
  await expect(page.locator('[data-page-id="session-import"]')).toHaveCount(0);
  await page.getByRole("button", { name: "打开 Web", exact: true }).click();
  await expect.poll(server.webOpens).toBe(1);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("运行中的任务和 Web 终端会被中断");
  await dialog.getByRole("button", { name: "取消" }).click();
  expect(server.stops()).toBe(0);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await dialog.getByRole("button", { name: "停止 codexhost？", exact: true }).click();
  await expect(page.getByRole("heading", { name: "codexhost 已停止" })).toBeVisible();
  await expect.poll(server.exited).toBe(true);
  expect(server.stops()).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("connection page starts an offline Web and uses its QR, switches and token regeneration", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await fixture();
  await page.goto(`${server.base}/#connect-devices`);
  await expect(page.getByRole("alert")).toContainText("Web 未运行");
  await page.getByRole("button", { name: "启动并打开 Web" }).click();
  await expect(page.getByRole("switch", { name: "直连（局域网、Tailscale IP）" })).toBeVisible();
  await expect.poll(server.webOpens).toBe(1);
  const original = (await server.web().access()).secret;
  const direct = page.getByRole("switch", { name: "直连（局域网、Tailscale IP）" });
  await direct.click();
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  expect((await server.web().access()).background?.lan).toBe(false);
  await direct.click();
  await expect(page.getByRole("dialog")).toContainText("未加密的 HTTP");
  await page.getByRole("dialog").getByRole("button", { name: "开启直连", exact: true }).click();
  await expect(direct).toBeChecked({ timeout: 30_000 });
  await expect(page.getByRole("img", { name: "登录二维码" })).toBeVisible();
  const link = page.getByRole("textbox", { name: "登录链接" });
  await expect(link).toHaveValue(new RegExp(`#token=${original}$`));
  await page.getByRole("switch", { name: "登录后自动启动" }).click();
  await expect.poll(() => server.web().autostart()).toBe("on");
  const serve = page.getByRole("switch", { name: "Tailscale HTTPS", exact: true });
  await expect(page.getByRole("textbox", { name: "Serve 命令" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toHaveCount(0);
  await serve.click();
  await expect(page.getByRole("dialog")).toContainText("Web 退出后配置仍保留");
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "Serve 命令" })).toHaveValue(
    /^tailscale serve /,
  );
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.base });
  await page.getByRole("dialog").getByRole("button", { name: "复制命令", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "已复制", exact: true }),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  expect(server.cli.mutations()).toEqual([]);
  await serve.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "开启 Tailscale Serve", exact: true })
    .click();
  await expect(serve).toBeChecked();
  expect(server.cli.mutations()).toHaveLength(1);
  await expect(link).toHaveValue(/^https:\/\//);
  await page.getByRole("button", { name: "重新生成令牌…", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("其他设备会立即退出登录");
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  expect((await server.web().access()).secret).toBe(original);
  await page.getByRole("button", { name: "重新生成令牌…", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "重新生成访问令牌？", exact: true })
    .click();
  await expect.poll(async () => (await server.web().access()).secret !== original).toBe(true);
  await serve.click();
  await expect(page.getByRole("dialog")).toContainText("其他路径和端口将保留");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭 Tailscale Serve", exact: true })
    .click();
  await expect(serve).not.toBeChecked();
});

test("connection addresses match Web groups and selected hints at desktop and mobile widths", async ({
  page,
}) => {
  const server = await fixture();
  await page.route("**/api/web/request", async (route) => {
    expect(route.request().postDataJSON().method).toBe("codexhost/accessTokenGet");
    await route.fulfill({
      json: {
        secret: "fixture-only-screenshot-token",
        lastUsedAt: null,
        background: { lan: true, autostart: { status: "off" } },
        tailscale: { status: "serving", url: "https://computer.example.ts.net/", funnel: true },
        networkUrls: [
          { kind: "public", url: "https://web.example.com/" },
          { kind: "lan", url: "http://192.0.2.10:4474/" },
          { kind: "tailscale", url: "http://100.64.0.10:4474/" },
          { kind: "virtual", url: "http://198.51.100.10:4474/" },
          { kind: "tailscale-https", url: "https://computer.example.ts.net/" },
          { kind: "tailscale-funnel", url: "https://funnel.example.ts.net/" },
        ],
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${server.base}/#connect-devices`);
  const routes = page.locator(".console-connect-routes");
  await expect(routes.locator('input[type="radio"]')).toHaveCount(6);
  await expect(page.locator(".console-connect-route-title")).toHaveText([
    "公开地址web.example.com",
    "Tailscale100.64.0.10:4474",
    "局域网192.0.2.10:4474",
    "虚拟网络198.51.100.10:4474",
    "computer.example.ts.net",
    "Tailscale Funnel · 公开funnel.example.ts.net",
  ]);
  await expect(page.locator('[data-connect-group="direct"] .console-connect-route')).toHaveCount(3);
  await expect(page.locator('[data-connect-group="tailscale"] .console-connect-route')).toHaveCount(
    2,
  );
  const other = page.locator(".console-connect-other");
  await expect(other.locator("summary")).toHaveText("其他地址（1）");
  await expect(other).not.toHaveAttribute("open");
  await expect(page.locator(".console-connect-hint")).toHaveCount(1);
  await expect(page.locator(".console-connect-hint")).toHaveText(
    "通过 --public-url 配置的地址，登录仍需要访问令牌。",
  );
  const hints = [
    ["tailscale", "手机也登录 Tailscale 后，在任意网络都能连接。"],
    ["tailscale-https", "全程加密，支持通知和添加到主屏幕。手机需开着 Tailscale。"],
    ["tailscale-funnel", "互联网中的任何人都能访问登录页，登录仍需要访问令牌。"],
  ];
  for (const [kind, hint] of hints) {
    await page.locator(`[data-connect-route="${kind}"]`).click();
    await expect(page.locator(".console-connect-hint")).toHaveText(hint ?? "");
  }
  await other.locator("summary").click();
  await page.locator('[data-connect-route="virtual"]').click();
  await expect(page.locator(".console-connect-hint")).toHaveText(
    "通常只有这台电脑上的虚拟机能访问。",
  );
  await page.locator('[data-connect-route="lan"]').click();
  await other.locator("summary").click();
  await expect(other).not.toHaveAttribute("open");
  await expect(page.locator(".console-connect-hint")).toHaveText(
    "需连接同一 Wi-Fi。HTTP 未加密，请只在你信任的网络中使用。",
  );
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toHaveCount(0);
  const screenshotDirectory = path.join(tmpdir(), "codexhost-connect-ui-review");
  await mkdir(screenshotDirectory, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 1400 : 1000 });
    const qr = await page.locator(".console-connect-qr").boundingBox();
    const addresses = await routes.boundingBox();
    if (!qr || !addresses) throw new Error("Missing connection layout");
    if (width === 1280) expect(qr.x + qr.width).toBeLessThan(addresses.x);
    else expect(qr.y + qr.height).toBeLessThan(addresses.y);
    expect(
      await page
        .locator(".console-connect")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: path.join(screenshotDirectory, `connect-devices-${width}.png`),
      fullPage: true,
    });
  }
});
