import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createRemoteConnectionsPage } from "./packages/renderer-extension/src/settings/remote-connections-page.ts";
      import { createRemoteConnectionsControl } from "./packages/renderer-extension/src/remote-connections-control.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      const initial = { hostId:"remote-ssh-codex-managed:office", displayName:"公司", source:"codex-managed", sshHost:"user@office", sshAlias:null, sshPort:22, identity:null, autoConnect:true };
      const scenario=new URLSearchParams(location.search).get("scenario");
      let connections = [initial];
      window.electronBridge = { sendMessageFromView(message) {
        const params = JSON.parse(message.body);
        let body = {};
        if (message.url.endsWith("refresh-remote-connections")) body = { remoteConnections: connections };
        if (message.url.endsWith("app-server-connection-state")) body = { state: connections.find(c => c.hostId === params.hostId)?.autoConnect ? "connected" : "disconnected" };
        if (message.url.endsWith("save-codex-managed-remote-ssh-connections")) connections = params.remoteConnections.map(c => ({...c, sshHost:c.hostname, sshAlias:c.alias, autoConnect:connections.find(p => p.hostId === c.hostId)?.autoConnect ?? false}));
        if (message.url.endsWith("set-remote-connection-auto-connect")) connections = connections.map(c => c.hostId === params.hostId ? {...c, autoConnect:params.autoConnect} : c);
        queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", {data:{type:"fetch-response", requestId:message.requestId, responseType:"success", status:200, bodyJsonString:JSON.stringify(body)}})));
      } };
      const status = { runningVersion:"0.11.0", installedVersion:"0.11.0", restartRequired:false, remote:false, updateSupported:false, update:{phase:"idle", targetVersion:null,error:null} };
      let remote = {...status, installedVersion:"0.10.0", runningVersion:"0.10.0", remote:true, updateSupported:true, restartRequired:false};
      if(scenario === "newer") remote={...remote,installedVersion:"0.12.0",runningVersion:"0.12.0",restartRequired:false};
      if(scenario === "restart") remote={...remote,installedVersion:"0.11.0",restartRequired:true};
      if(scenario === "matched") remote={...remote,installedVersion:"0.11.0",runningVersion:"0.11.0",restartRequired:false};
      const control = createRemoteConnectionsControl(window, hostId => ({
        setupSsh: async input => {
          if(scenario === "unknown") throw new Error("SSH unavailable");
          if(input.action === "repair") { window.setupInstalled = true; remote = {...remote,update:{phase:"idle",targetVersion:null,error:null}}; }
          if(input.action === "install") { window.setupInstalled = true; window.setupVersion = input.version; }
          return {state:window.setupInstalled ? "installed" : "not-installed"};
        },
        runtimeStatus: async () => {if(scenario === "unknown" && hostId !== "local") throw new Error("Remote unavailable"); return hostId === "local" ? status : remote;},
        updateRemote: async version => remote = {...remote,update:{phase:"installing",targetVersion:version,error:null}}
      }));
      createRemoteConnectionsPage(rendererSettingsMessages("zh-CN"), () => control).mount({content:document.querySelector("main"),signal:new AbortController().signal});
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2024",
});
const css = await readFile(
  path.resolve(import.meta.dirname, "../../packages/renderer-extension/src/settings/shell.css"),
  "utf8",
);
const shots = path.resolve(import.meta.dirname, "../../test-results/remote-connections");
test("SSH settings save, connection toggle, version display, and immediate update", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.route("http://localhost/remote-settings*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="zh-CN"><head><style>${css}\nbody{margin:40px;background:#fff;color:#222;font:15px system-ui;--text-primary:#222;--text-secondary:#666;--border-default:#ddd;--surface-hover:#f5f5f5;}main{max-width:860px;margin:auto}button,input{font:inherit}</style></head><body><main></main></body></html>`,
    }),
  );
  await page.goto("http://localhost/remote-settings");
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  // Fixture preparation ends here. All behavior below is driven by visible UI controls.
  await expect(page.getByRole("heading", { name: "公司", exact: true })).toBeVisible();
  await expect(page.getByText("已安装: 0.10.0", { exact: true })).toBeVisible();
  await expect(page.getByText("运行中: 0.10.0", { exact: true })).toBeVisible();
  await expect(page.getByText("远程服务有更新可用", { exact: true })).toBeVisible();
  await expect(page.getByText("正在更新远程服务…", { exact: true })).toHaveCount(0);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "01-versions.png"), fullPage: true });
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await expect(page.getByRole("heading", { name: "添加 SSH 连接" })).toBeVisible();
  await page.getByLabel("名称", { exact: true }).fill("Linux 开发机");
  await page.getByLabel("SSH 地址", { exact: true }).fill("dev@linux");
  await page.screenshot({ path: path.join(shots, "02-editor.png"), fullPage: true });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Linux 开发机", exact: true })).toBeVisible();
  const linux = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Linux 开发机", exact: true }) });
  await linux.getByRole("button", { name: "安装并连接", exact: true }).click();
  await expect(linux.getByText("已连接", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "03-saved.png"), fullPage: true });
  const office = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "公司", exact: true }) });
  await office.getByRole("button", { name: "更新到本机版本", exact: true }).click();
  await expect(office.getByText("正在更新远程服务…", { exact: true })).toBeVisible();
  await expect(office.getByRole("button", { name: "更新到本机版本", exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(shots, "04-waiting.png"), fullPage: true });
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开 Codex SSH 设置 ↗" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const scenario of ["newer", "restart", "matched", "unknown"] as const) {
  test(`SSH connection status: ${scenario}`, async ({ page }) => {
    await page.route("http://localhost/remote-settings*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="zh-CN"><head><style>${css}</style></head><body><main></main></body></html>`,
      }),
    );
    await page.goto(`http://localhost/remote-settings?scenario=${scenario}`);
    await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
    // Fixture preparation ends here; assertions and actions use the visible page.
    await expect(page.getByRole("heading", { name: "公司", exact: true })).toBeVisible();
    if (scenario === "restart") {
      await page.getByRole("button", { name: "重启并连接", exact: true }).click();
      await expect(page.getByText("正在更新远程服务…", { exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: "更新到本机版本", exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name: "重启并连接", exact: true })).toHaveCount(0);
    }
    if (scenario === "matched")
      await expect(page.getByText("版本已匹配", { exact: true })).toBeVisible();
    if (scenario === "newer")
      await expect(
        page.getByText("版本不同，请先检查本机更新；不会自动降低远程版本。", { exact: true }),
      ).toBeVisible();
    if (scenario === "unknown") {
      await expect(page.getByRole("button", { name: "安装并连接", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "重新检测", exact: true }).click();
      await expect(
        page.getByText("暂时无法读取远程版本，可刷新或重新连接后再试。", { exact: true }),
      ).toBeVisible();
    }
  });
}

test("repair runs immediately without a session check or confirmation", async ({ page }) => {
  await page.route("http://localhost/remote-settings*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="zh-CN"><body><main></main></body></html>`,
    }),
  );
  await page.goto("http://localhost/remote-settings?scenario=matched");
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  await page.getByRole("button", { name: "修复远程服务", exact: true }).click();
  await expect(page.getByText("远程服务已修复，正在连接", { exact: true })).toBeVisible();
  await expect(page.getByText("等待当前任务结束后更新", { exact: true })).toHaveCount(0);
});
