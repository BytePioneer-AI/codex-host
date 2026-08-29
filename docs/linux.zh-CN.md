# Linux 支持

codexhost 通过 npm 包支持 x64 和 ARM64 Linux。请先安装与当前架构匹配的官方 ChatGPT App，再安装 codexhost：

```bash
npm install -g @codexhost/cli
codexhost
```

## 支持范围

Linux 版本支持 x86-64 和 ARM64 上的官方 ChatGPT `.deb` 和 `.rpm` 包。codexhost 的 Linux 原生二进制以 glibc 2.35 为发布基线，可在使用 glibc 2.35 或更新版本的系统上装载；官方 ChatGPT App 自身的发行版支持范围仍以 OpenAI 文档为准。codexhost 会验证生产包元数据、当前架构的 ELF 身份和以下包内入口：

- 启动器：`/usr/bin/chatgpt`
- 安装目录：`/usr/lib/chatgpt`
- Desktop 可执行文件：`/usr/lib/chatgpt/ChatGPT`

运行时要求 `/proc` 已挂载，并且 Linux 支持 `pidfd`。目前不支持 Snap、Flatpak、AppImage、本地或迁移后的安装、包装脚本或 `alternatives` 启动器、跨架构执行，以及 codexhost Linux installer 包。codexhost 在 Linux 上通过 npm 安装和更新。

## Renderer 兼容性

Renderer 集成失败会在后台恢复，不会显示兼容弹窗，也不会写入本地警告确认。外部 Agent 集成不可用时，受管 Desktop 仍可通过官方 Codex 路由使用。Controller 的首次握手仍会对格式错误或不受支持的 readiness 输出按失败关闭处理。

## 进程所有权

codexhost 不会接管独立运行的 ChatGPT App。启动 codexhost 前，请完全退出 ChatGPT。受管启动会直接启动已校验的 Desktop 可执行文件，并通过 `/proc` 监督它；普通 ChatGPT 启动仍使用官方启动器。只有重新校验 PID、启动时间和可执行文件身份后才会发送关闭信号。

## 诊断

```bash
codexhost inspect
codexhost --version
```

`inspect` 会报告识别出的包身份、版本、启动器、可执行文件和运行进程 ID。ChatGPT App 更新后，可用它确认 codexhost 仍能识别已安装的 Desktop。受支持的 Renderer 表面暂时不可用时，集成会自动重试。
