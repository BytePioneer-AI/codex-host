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
      let connections = scenario === "empty" ? [] : [initial];
      window.electronBridge = { sendMessageFromView(message) {
        const params = JSON.parse(message.body);
        let body = {};
        if (message.url.endsWith("refresh-remote-connections")) body = { remoteConnections: connections };
        if (message.url.endsWith("app-server-connection-state")) body = { state: connections.find(c => c.hostId === params.hostId)?.autoConnect ? "connected" : "disconnected" };
        if (message.url.endsWith("app-server-connection-state") && scenario === "failed") body = { state: "error", error: "Connection refused" };
        if (message.url.endsWith("save-codex-managed-remote-ssh-connections")) connections = params.remoteConnections.map(c => ({...c, sshHost:c.hostname, sshAlias:c.alias, autoConnect:connections.find(p => p.hostId === c.hostId)?.autoConnect ?? false}));
        if (message.url.endsWith("set-remote-connection-auto-connect")) (window.connectCalls ??= []).push(params.autoConnect);
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
          if(scenario === "unknown" && input.action === "inspect") throw new Error("SSH unavailable"); if(scenario === "failed") return {state:"installed"}; if(scenario === "outdated") { if(input.action === "update") { window.setupVersion = input.version; remote = {...remote, installedVersion:input.version, runningVersion:input.version}; } return {state:"installed"}; }
          if(input.action === "repair") { window.setupInstalled = true; remote = {...remote,update:{phase:"idle",targetVersion:null,error:null}}; }
          if(input.action === "install") { window.setupInstalled = true; window.setupVersion = input.version; }
          return {state:window.setupInstalled ? "installed" : "not-installed"};
        },
        runtimeStatus: async () => {if(scenario === "unknown" && hostId !== "local") throw new Error("Remote unavailable"); if((scenario === "outdated" || scenario === "missing") && hostId !== "local" && !window.setupVersion) throw Object.assign(new Error("unsupported"), {code:-32601}); return hostId === "local" ? status : remote;},
        updateRemote: async version => remote = {...remote,update:{phase:"installing",targetVersion:version,error:null}}
      }));
      // Mirror the settings shell: its tokens live on :host, so the page mounts in a shadow root.
      const shadow = document.querySelector("main").attachShadow({mode:"open"});
      const style = document.createElement("style");
      style.textContent = document.getElementById("settings-css").textContent + ":host{display:block;background:var(--settings-bg)}";
      const content = document.createElement("div");
      content.className = "settings-page__content";
      shadow.append(style, content);
      createRemoteConnectionsPage(rendererSettingsMessages("zh-CN"), () => control).mount({content,signal:new AbortController().signal});
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  target: "es2024",
});
const settingsDirectory = path.resolve(
  import.meta.dirname,
  "../../packages/renderer-extension/src/settings",
);
const css = (
  await Promise.all(
    ["shell.css", "accounts.css"].map((file) =>
      readFile(path.join(settingsDirectory, file), "utf8"),
    ),
  )
).join("\n");
const pageHtml = `<!doctype html><html lang="zh-CN" style="color-scheme:light dark"><head><style id="settings-css" media="not all">${css}</style><style>body{margin:0}</style></head><body><main></main></body></html>`;
const shots = path.resolve(import.meta.dirname, "../../test-results/remote-connections");
test("SSH settings save, connection toggle, version display, and immediate update", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 980, height: 720 });
  await page.route("http://localhost/remote-settings*", (route) =>
    route.fulfill({ contentType: "text/html", body: pageHtml }),
  );
  await page.goto("http://localhost/remote-settings");
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  // Fixture preparation ends here. All behavior below is driven by visible UI controls.
  await expect(page.getByRole("heading", { name: "公司", exact: true })).toBeVisible();
  await expect(page.getByText("本机 codexhost 0.11.0", { exact: true })).toBeVisible();
  await expect(page.getByText("远程服务 0.10.0", { exact: true })).toBeVisible();
  await expect(page.getByText("有更新可用 · 本机为 0.11.0", { exact: true })).toBeVisible();
  await expect(page.getByText("正在更新远程服务…", { exact: true })).toHaveCount(0);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "00-versions.png"), fullPage: true });
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await expect(page.getByRole("heading", { name: "添加 SSH 连接" })).toBeVisible();
  // A failure reported in English by the bridge is shown in the page's language.
  await page.getByLabel("名称", { exact: true }).fill("公司");
  await page.getByLabel("SSH 地址", { exact: true }).fill("dev@linux");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "已存在同名的连接" })).toBeVisible();
  await page.getByLabel("名称", { exact: true }).fill("Linux 开发机");
  await page.getByLabel("SSH 地址", { exact: true }).fill("dev@linux");
  await page.screenshot({ path: path.join(shots, "01-editor.png"), fullPage: true });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Linux 开发机", exact: true })).toBeVisible();
  const linux = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Linux 开发机", exact: true }) });
  await expect(linux.getByText("需要安装远程服务", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "02-not-installed.png"), fullPage: true });
  await linux.getByRole("button", { name: "安装并连接", exact: true }).click();
  await expect(linux.getByText("已连接", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "03-saved.png"), fullPage: true });
  const office = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "公司", exact: true }) });
  await office.getByRole("button", { name: "更新到本机版本", exact: true }).click();
  // Updating starts immediately, without a confirmation dialog.
  await expect(office.getByText("正在更新远程服务…", { exact: true })).toBeVisible();
  await expect(office.getByRole("button", { name: "更新到本机版本", exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "04-waiting.png"), fullPage: true });
  // Editing and removing happen in dialogs; Escape leaves the connection untouched.
  await linux.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("SSH 地址", { exact: true })).toHaveValue("dev@linux");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await linux.getByRole("button", { name: "移除", exact: true }).click();
  await expect(page.getByText("移除连接不会删除远程文件或会话。", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "05-remove.png"), fullPage: true });
  await page.getByRole("dialog").getByRole("button", { name: "移除", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Linux 开发机", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "公司", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 560, height: 720 });
  await page.screenshot({ path: path.join(shots, "06-dark-narrow.png"), fullPage: true });
  await expect(page.getByRole("button", { name: "打开 Codex SSH 设置 ↗" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const scenario of [
  "newer",
  "restart",
  "matched",
  "unknown",
  "outdated",
  "failed",
  "missing",
] as const) {
  test(`SSH connection status: ${scenario}`, async ({ page }) => {
    await page.route("http://localhost/remote-settings*", (route) =>
      route.fulfill({ contentType: "text/html", body: pageHtml }),
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
    if (scenario === "matched") {
      await expect(page.getByText("与本机版本一致", { exact: true })).toBeVisible();
      // A healthy service shows no troubleshooting actions.
      await expect(page.getByRole("button", { name: "修复远程服务", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "重新检测", exact: true })).toHaveCount(0);
    }
    if (scenario === "missing") {
      // Stock Codex answers a connection without the service; only installing applies.
      await expect(page.getByText("需要安装远程服务", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "安装并连接", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "更新远程服务", exact: true })).toHaveCount(0);
    }
    if (scenario === "failed") {
      await expect(page.getByText("连接失败", { exact: true })).toBeVisible();
      await expect(page.getByText("Connection refused", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "断开", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "修复远程服务", exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(shots, "09-failed.png"), fullPage: true });
      await page.getByRole("button", { name: "重新连接", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => (window as { connectCalls?: boolean[] }).connectCalls))
        .toEqual([false, true]);
    }
    if (scenario === "newer")
      await expect(
        page.getByText("版本不同，请先检查本机更新；不会自动降低远程版本。", { exact: true }),
      ).toBeVisible();
    if (scenario === "outdated") {
      // A service that rejects the status method is updated over SSH, not repaired or rechecked.
      await expect(page.getByText("远程服务需要更新", { exact: true })).toBeVisible();
      await expect(page.getByText(/暂时无法读取远程版本/u)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "修复远程服务", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "重新检测", exact: true })).toHaveCount(0);
      await page.screenshot({ path: path.join(shots, "08-outdated.png"), fullPage: true });
      await page.getByRole("button", { name: "更新远程服务", exact: true }).click();
      await expect(page.getByText("远程服务 0.11.0", { exact: true })).toBeVisible();
      await expect(page.getByText("与本机版本一致", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => (window as { setupVersion?: string }).setupVersion)).toBe(
        "0.11.0",
      );
    }
    if (scenario === "unknown") {
      await expect(page.getByRole("button", { name: "安装并连接", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "重新检测", exact: true }).click();
      await expect(
        page.getByText("暂时无法读取远程版本，可刷新或重新连接后再试。", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("原因: Remote unavailable", { exact: true })).toBeVisible();
    }
  });
}

test("an empty list offers adding the first connection", async ({ page }) => {
  await page.route("http://localhost/remote-settings*", (route) =>
    route.fulfill({ contentType: "text/html", body: pageHtml }),
  );
  await page.goto("http://localhost/remote-settings?scenario=empty");
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  await expect(page.getByText("还没有 SSH 连接", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "07-empty.png"), fullPage: true });
  await page.getByRole("button", { name: "添加连接", exact: true }).last().click();
  await page.getByLabel("名称", { exact: true }).fill("家里");
  await page.getByLabel("SSH 地址", { exact: true }).fill("bad host");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  // Native validation rejects whitespace, so the dialog stays open and nothing is saved.
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("SSH 地址", { exact: true }).fill("me@home");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "家里", exact: true })).toBeVisible();
  await expect(page.getByText("还没有 SSH 连接", { exact: true })).toHaveCount(0);
});

test("repair runs immediately on a connected computer", async ({ page }) => {
  await page.route("http://localhost/remote-settings*", (route) =>
    route.fulfill({ contentType: "text/html", body: pageHtml }),
  );
  await page.goto("http://localhost/remote-settings?scenario=unknown");
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  await page.getByRole("button", { name: "修复远程服务", exact: true }).click();
  await expect(page.getByText("远程服务已修复，正在连接", { exact: true })).toBeVisible();
  await expect(page.getByText("等待当前任务结束后更新", { exact: true })).toHaveCount(0);
});
