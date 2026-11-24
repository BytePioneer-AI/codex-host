# Design

## Context

- 当前启动链路（`crates/launcher/src/main.rs`、`console.rs`、`services.rs`）：GUI 入口在 `Presentation::Browser` 下会立刻调用 `console::show_for_launch`，同时启动 `console-server` 并弹出系统浏览器打开 `:4399`；无官方 Codex Desktop 时退回浏览器打开 `:4400`。
- 独立 Web 后端与认证（`packages/web-server/src/auth.ts`、`web-assets.ts`）：`?token=<localToken>` 仅在 `isLocalConnection` 成立时换取本机 `HttpOnly` 会话 Cookie；前端资源与 Web UI 扩展在运行时由服务端动态编排返回。
- 跨平台打包与更新约束：`crates/launcher/src/installation_layout.rs` 解析资源布局；`crates/updater/src/prepare_install.rs` 与 `crates/launcher/src/services.rs` 负责更新前停服及用户显式 `stop`；`scripts/release/macos/package.sh` 对 `codexhost.app` 设置 `LSUIElement = true` 并对全部二进制执行 `codesign --verify --deep --strict`。

## Decisions

### 1. 持久化与状态文件契约（`$CODEXHOST_DATA_DIR`）

- **启动偏好文件**：`$CODEXHOST_DATA_DIR/launch-preferences-v1.json`（Unix `0600`，临时文件同步 + 原子替换）：
  ```json
  {
    "version": 1,
    "defaultDesktopSurface": "native-shell",
    "onboardingCompleted": true
  }
  ```
  - `defaultDesktopSurface` 仅允许 `"native-shell"` 或 `"codex-desktop"`。
- **桌面壳就绪记录**：`$CODEXHOST_DATA_DIR/desktop-shell-ready.json`（Unix `0600`，原子替换）：
  ```json
  {
    "pid": 12345,
    "started_at_micros": 1700000000000000,
    "executable": "/abs/path/to/codexhost-shell",
    "version": "0.24.0"
  }
  ```
  - 启动器通过 `codexhost_platform::process_instance(pid, started_at_micros)` 校验存活，防止 PID 复用误杀。

### 2. Launcher CLI 契约

- `codexhost app [--onboarding]`
  - `InstalledResources` 新增可选 `desktop_shell: Option<PathBuf>`，按以下顺序探测：环境变量 `CODEXHOST_DESKTOP_SHELL_PATH`（需为绝对路径文件）→ 安装布局 `libexec/codexhost-shell(.exe)` 或 `bin/codexhost-shell(.exe)` → 源码构建目录 `target/{debug,release}/codexhost-shell(.exe)`。
  - 若 `desktop_shell` 存在，先（或交由壳）确保后台 Host/Web 就绪并拉起桌面壳（携带 `--onboarding` 如指定）；若不存在 `desktop_shell`（例如精简 npm 环境），常规启动回落为确保后台 Web 并以默认浏览器打开 `login_url`（无图形环境打印链接）。
- `codexhost launch-prefs get --json`
  - 返回 JSON：
    ```json
    {
      "version": 1,
      "defaultDesktopSurface": "native-shell",
      "onboardingCompleted": true,
      "codexDesktopInstalled": true,
      "desktopShellAvailable": true
    }
    ```
    其中未完成首次引导且文件不存在时 `defaultDesktopSurface` 为 `null`、`onboardingCompleted` 为 `false`。
- `codexhost launch-prefs set --surface <native-shell|codex-desktop> [--onboarding-completed true|false]`
  - 严格校验参数，原子写入 `launch-preferences-v1.json`；省略 `--onboarding-completed` 时默认置为 `true`。
- **无参 `codexhost` 与 `--start-menu` 路由规则**：
  - SSH / 无图形环境继续走 `web` 文本链接输出；
  - 已完成引导：按 `defaultDesktopSurface` 分发；若选 `"codex-desktop"` 但未发现官方安装，在存在 `desktop_shell` 时提示切回或打开桌面壳，否则回落 `web`；
  - 未完成引导：未安装官方 Codex Desktop 时不打扰，直接写入 `"native-shell"` 偏好并走 `app` 路径；已安装官方 Codex Desktop 且 `desktop_shell` 可用时，拉起 `codexhost app --onboarding`；无 `desktop_shell` 时保持直接启动官方 Codex Desktop。

### 3. Tauri v2 桌面壳与内置页面桥接契约

- **独立 Cargo workspace**：`apps/desktop-shell/src-tauri/Cargo.toml` 自声明 `[workspace]`，不并入仓库根 `Cargo.toml`，以免无头 Linux CI 在未装 WebKitGTK 系统库时阻塞核心测试。
- **WebView 环境注入**：
  - 对包括本机 `web-server` 在内的所有页面注入 `window.__CODEXHOST_DESKTOP_SHELL__ = true`（通过配置初始化脚本），供 `apps/web-ui` 识别自身运行在桌面原生壳中（例如隐藏浏览器 PWA 安装行）。
  - 对内置 `apps/desktop-shell/ui/onboarding.html` 与 `loading.html` 暴露 `window.__codexhostShell` 接口：
    ```ts
    interface CodexHostDesktopShellBridge {
      chooseSurface(surface: "native-shell" | "codex-desktop"): Promise<void>;
      retry(): Promise<void>;
      openConsole(): Promise<void>;
      getState(): Promise<{
        codexDesktopInstalled: boolean;
        locale: string;
        status: "starting" | "reconnecting" | "error";
        message?: string;
      }>;
    }
    ```
- **系统托盘与多窗口共生**：
  - 托盘菜单包含：打开 CodexHost 窗口、打开官方 Codex Desktop（调用 `<launcher> launch`）、手机与远程连接（前置窗口并跳转 `#connect-devices`）、默认启动方式切换（调用 `<launcher> launch-prefs set`）、诊断与日志（调用 `<launcher> console`）、检查更新（前置窗口并跳转 `#updates` 或调用 `<launcher> update`）、完全退出（调用 `<launcher> stop` 并退出壳）。
  - 关闭窗口隐藏到托盘（macOS 隐藏主窗口时可切回 Accessory 策略，打开窗口时切为 Regular）；托盘/启动新实例唤醒已有单实例并前置窗口。
  - `web-server` 因配置更改退出码 `42` 重启时，桌面壳切换到 `loading.html`（`status: "reconnecting"`）并轮询 `web-service-ready.json`，新服务就绪后自动加载新 `login_url`。

## Risks / Trade-offs

- **新增二进制与现有安装包构建链联动** → `package.sh` 与 `Installer.iss` 在 `libexec/codexhost-shell` 存在时纳入安装与签名，未编入壳产物时 Launcher 自动走原有回退链路，保证开发期与渐进构建可独立验证。
- **macOS `LSUIElement` 与托盘窗口体验** → Info.plist 保持后台能力并在需要展示主窗口时通过激活策略切换显示 Dock 与窗口聚焦。
