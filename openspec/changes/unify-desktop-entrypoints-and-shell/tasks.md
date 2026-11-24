# Tasks

## 1. Launcher 启动静默、偏好存储与生命周期收口

- [x] 1.1 调整 `crates/launcher/src/console.rs`，在 `Presentation::Browser` 正常启动时不再自动打开浏览器标签，仅在启动失败与持续注入失败时打开救援页；保持 `Presentation::Print` 与 `codexhost console` 行为不变。验证：`cargo test --package codexhost-launcher --locked` 中新增/更新的单元测试通过。
- [x] 1.2 实现 `crates/launcher/src/launch_preferences.rs`、`codexhost launch-prefs get/set`、`codexhost app [--onboarding]`、`InstalledResources::desktop_shell`、`codexhost` 默认模式路由，以及 `services.rs` 对 `desktop-shell-ready.json` 的停服支持。验证：临时数据目录下 `cargo test --package codexhost-launcher --locked` 覆盖读写权限/原子写入、路由回退与停止校验并全部通过。

## 2. Tauri v2 自有桌面壳、托盘与更新/打包联动

- [x] 2.1 创建独立 `apps/desktop-shell/src-tauri/` Tauri v2 工程，实现单实例、本机 `web-server` 自动拉起与回环凭证免登、`__CODEXHOST_DESKTOP_SHELL__` 与 `__codexhostShell` 注入、系统托盘菜单、`web-server` 重启平滑重连及 `desktop-shell-ready.json` 生命周期。验证：在 `apps/desktop-shell/src-tauri` 运行 `cargo check` 与单元测试通过。
- [x] 2.2 更新 `scripts/release/macos/package.sh`、`scripts/release/windows/Installer.iss` 与 `crates/updater/src/prepare_install.rs`，将 `codexhost-shell` 纳入打包签名与覆盖安装前置清理目标。验证：`cargo test --package codexhost-updater --locked` 通过，并校验发布脚本条件分支语法。

## 3. 桌面壳内置引导与过渡界面

- [x] 3.1 设计并实现 `apps/desktop-shell/ui/onboarding.html` 与 `loading.html`（零外部 CDN、亮暗主题自适应、中英双语），完整对接 `window.__codexhostShell` 并在浏览器离线预览时优雅降级。验证：检查静态资源无外部依赖、JS 无语法错误且三态切换逻辑完整。

## 4. 会话 Web 连接设备与移动端引导收口

- [x] 4.1 优化 `apps/web-ui/packages/client/ui-codexhost` 的「连接设备」与 `PwaInstallRow`（主连接卡片优先、进阶项收起、Android APK 下载引导与 iOS 添加到主屏幕指引、桌面壳内隐藏浏览器 PWA 安装行）。验证：`npm run build:web:ui` 构建通过并检查中英文文案对齐。
