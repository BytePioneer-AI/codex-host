# Proposal

## Why

当前桌面用户双击启动 codexhost 时会同时拉起 Codex Desktop、弹出浏览器 `:4399` 控制台并在后台运行 `:4400` 会话 Web；希望使用低内存 Web 界面的用户又缺少独立原生窗口与系统托盘总控，只能停留在浏览器标签页，且连接手机页面的路径和信息密度也较为繁琐。现在需要收拢桌面端入口，以单一安装包同时承载自有薄壳桌面窗口、官方 Codex Desktop 增强模式与退居幕后的救援控制台。

## What Changes

- 正常桌面启动（Finder / 开始菜单 / 无参 `codexhost` / `codexhost launch`）不再自动打开 `:4399` Console 浏览器页面；Console 仅在启动失败或持续注入失败时作为故障救援自动弹出，或由 `codexhost console` / 托盘手动触发；终端模式继续打印地址。
- 在数据目录持久化默认桌面启动偏好（`launch-preferences-v1.json`），首次检测到官方 Codex Desktop 时展示一次性选择引导，未检测到时直达自有桌面窗口；新增 `codexhost app` 与 `codexhost launch-prefs` 命令，并将自有桌面壳纳入 `codexhost stop` 与覆盖安装清理流程。
- 新增基于系统 WebView 的薄原生桌面壳与系统托盘（`apps/desktop-shell/`）：连接本机 `web-server` 加载会话界面，支持托盘一键打开自有窗口或官方 Codex Desktop、切换默认启动方式、手机连接快捷入口、打开 Console 诊断与完全退出服务，并在 `web-server` 重启时平滑重连。
- 优化会话 Web 的「连接设备」与移动端获取引导：突出推荐方式与一键扫码，收起进阶说明，补充 Android APK 下载与 iOS Safari 添加到主屏幕引导，并在自有桌面壳内隐藏多余的浏览器 PWA 安装行。

## Decisions

- **单一安装包双模式，不拆分两个桌面安装包**：两种桌面形态共用同一共享后台、Mapping Store、预装插件目录与自动更新锁，拆分安装会引发服务互斥与任务中断。
- **桌面壳选用 Tauri v2 并连接本机 `web-server`**：排除高内存的 Electron，也不将离线静态页面打死在壳内，以保留运行时 Web UI 扩展装配、本地回环免手工登录与单数据源一致性。
- **保留独立 `apps/desktop-shell/src-tauri` Cargo workspace**：不将该壳纳入根 `Cargo.toml` 成员列表，避免无头 Linux CI 在缺少桌面 WebView 系统库时阻塞核心测试。

## Capabilities

### New Capabilities

- `unified-desktop-entrypoints`: 单一桌面安装包的启动静默控制台策略、首次桌面形态引导与偏好持久化、自有原生桌面壳及系统托盘生命周期，以及连接设备页的移动端引导收口。

### Modified Capabilities

- `web-background-service`: 无官方 Codex Desktop 时优先以自有桌面壳承载桌面入口（无壳二进制时回落 Web）；`codexhost stop` 同步停止受管理的自有桌面壳与托盘进程。

## Impact

涉及 `crates/launcher`（静默控制台策略、偏好存储、`app` / `launch-prefs` 命令、`stop` 清理）、`crates/updater`（Windows 覆盖安装清理目标）、新增 `apps/desktop-shell/`（Tauri v2 原生壳及内置引导/重连页）、`scripts/release/`（macOS/Windows 打包联动）与 `apps/web-ui/packages/client/ui-codexhost`（连接设备与 PWA 引导优化）。不修改 Harness Adapter、Mapping Store 或官方 Codex 流量归属。
