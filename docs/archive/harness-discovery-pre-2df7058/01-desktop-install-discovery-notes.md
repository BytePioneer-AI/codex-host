# 历史主题：Codex Desktop 与 codexhost 原生安装发现

> **已归档。** 这些记录解释早期分析覆盖了什么，不是当前 Harness CLI 发现说明。

原始临时分析的一部分调查了 Codex Desktop/codexhost 本体在各平台的安装位置。这属于原生应用发现和 Launcher/平台集成问题，不属于 `@codexhost/harness-discovery` 的职责。

## 当时记录的主题

### Windows

早期分析关注：

- `CODEXHOST_PROBE_*` Gate A 覆盖参数；
- `CODEXHOST_INSTALL_ROOT` 便携式或解包 MSIX 覆盖；
- Windows PackageManager/AppX 包发现；
- WindowsApps 安装根目录；
- `%LOCALAPPDATA%\OpenAI\Codex\bin\` 中的 Codex CLI 缓存；
- `ChatGPT.exe`、打包 Codex CLI、`app.asar` 和 `AppxManifest.xml` 的验证。

### macOS

早期分析关注：

- `/Applications/Codex.app`；
- `/Applications/ChatGPT.app`；
- `~/Applications/Codex.app`；
- `~/Applications/ChatGPT.app`；
- Bundle Identifier、`CFBundleExecutable`、Mach-O 可执行文件和 `app.asar` 的验证；
- 多个有效安装之间的冲突处理。

### Linux

早期分析关注：

- `/usr/lib/chatgpt/` 的固定应用目录；
- `/usr/bin/chatgpt` 启动器；
- `ChatGPT`、`codex-launcher`、打包 Codex CLI 和 `linux-package-metadata.json` 的验证。

## 为什么这些内容不应与 Harness discovery 合并

上述能力回答的是：

> codexhost 如何定位和验证它所托管或扩展的 Codex Desktop 原生应用？

`@codexhost/harness-discovery` 回答的是：

> 已运行的 codexhost 如何找到外部 Harness CLI，例如 `claude`、`pi`、`omp` 或 `grok`？

两者所有权不同：

- 原生应用安装、Launcher 和平台集成由 Rust/发布层负责；
- 外部 Harness CLI 的命令查找由 TypeScript Adapter 与 `packages/harness-discovery` 负责。

早期文档把两个问题放在同一份“发现位置”总结中，容易让读者误以为公共 Harness 包会扫描或验证 Codex Desktop 应用包。当前实现没有这项职责。
