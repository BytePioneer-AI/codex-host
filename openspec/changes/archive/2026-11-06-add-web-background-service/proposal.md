# Proposal

## Why

Web 现在只能从源码启动，而且跟着终端运行：关掉终端手机就连不上，崩溃后也没人拉起。这是普通用户用上远程访问的最大障碍。

## What Changes

- Web 服务进入安装包和 npm 包。
- 新增 `codexhost web`、`codexhost stop`、`codexhost status`。`codexhost` 除打开 GUI 外，也在后台拉起 Web；未安装 Codex Desktop 时改为打开 Web。
- Host 和 Web 脱离终端、GUI 和浏览器运行，只有 `codexhost stop` 或更新才停止。`codexhost stop` 关闭这台电脑上 codexhost 的全部进程，包括它拉起的 GUI。Web 崩溃后带退避自动重启，启动失败不反复重启。
- 发行版 Web 默认只监听本机，由连接设备页的开关或启动选项对外。启动选项保存下来，之后的启动沿用。
- 连接设备页增加局域网开关、一键开关 Tailscale Serve、登录后自动启动开关；Codex 设置页增加打开它的入口。
- 用户发起更新时直接重启 Host 和 Web；下次启动发现版本不一致时同样重启。两者都不判断是否有任务在运行。
- Web 设置页可独立检查和发起更新，不要求 Desktop 在线；各界面共享更新状态与互斥。更新后恢复原使用方式，纯 Web 不打开 GUI；安装失败时尽力恢复可用安装，浏览器重连后读取实际结果。
- `npm start`、`npm start web` 不变，继续在前台运行。

## Decisions

- **发行版默认只监听本机。** 与 `npm start web` 默认对外不同：普通用户装完不一定知道服务已开放到局域网，而且局域网是明文 HTTP。
- **Office 预览组件按需下载。** 安装包和 npm 包不带 LibreOffice 引擎，用户第一次预览时从 npm 官方源下载，发行时固定版本和校验值。按 macOS arm64 试算，压缩后带它约 89 MB，不带约 27 MB，现有 dmg 约 43 MB。放弃打进安装包（增量太大）和完全取消（Word、PPT 预览有实际用途）。为了少写代码，不做进度条、镜像选择和管理界面，失败后下次预览重试。
- **Web 用独立的监管进程，不并入 Host。** 这样重启 Web 不影响 Host 和任务。放弃让 Host 托管 Web：Rust 负责进程监管，Host 崩溃也不应带走 Web。
- **Web 退出、`codexhost stop` 和更新都不撤销 Serve。** 配置由 Tailscale 保存，手机地址保持不变；页面和文档说明这一点，由用户在页面上关闭。
- **`codexhost stop` 关闭全部进程。** 包括 codexhost 拉起的 GUI、Web、Host、远程服务、Broker 和 Console，不留后台；只停进程，不改配置。用户自己打开的 Codex Desktop 不受影响。远程服务在其他电脑重新连接时恢复，Broker 按需启动，所以一起关的代价只是中断正在运行的任务。
- **停止和更新都不确认。** 只在结束后输出被中断的任务数。

## Capabilities

### New Capabilities

- `web-background-service`：发行版的启动命令、Web 后台运行、状态、自启和卸载。

### Modified Capabilities

- `web-access-tokens`：对外监听增加发行版的默认值。
- `web-remote-access`：Web 可以在用户确认后开关 Tailscale Serve。
- `github-release-background-update`：更新时重启 Host 和 Web。

## Impact

- `crates/launcher`、`crates/platform`、`crates/updater`：Web 监管、命令入口、停止、自启项和更新流程。
- `packages/web-server`、`apps/web-ui/packages/document/office-to-pdf`：后台运行模式、设置保存、Serve 写入、Office 组件下载和发行内容。
- `packages/host-runtime`：停止时返回被中断的任务数，提供打开连接设备页的入口。
- `packages/renderer-extension`、`apps/web-ui`：设置入口。
- `scripts/release`、`tools/dev-desktop`：安装包、npm 包，以及 `npm stop` 对后台 Web 的识别。
- 现有安装包体积增加约 27 MB（压缩后，未去重 Harness 插件前的估算）。用户第一次预览 Word、PPT 时下载约 60 MB（macOS arm64 试算，Windows 可能更大）。
