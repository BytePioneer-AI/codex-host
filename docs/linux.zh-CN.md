# Linux 支持

CodexHost 通过 npm 包支持 x64 Linux。请先安装官方 ChatGPT App，再安装 CodexHost：

```bash
npm install -g @codexhost/cli
codexhost
```

## 支持范围

首个 Linux 版本有意只支持 x86-64 上的官方 ChatGPT `.deb` 和 `.rpm` 包。CodexHost 会验证生产包元数据和以下包内入口：

- 启动器：`/usr/bin/chatgpt`
- 安装目录：`/usr/lib/chatgpt`
- Desktop 可执行文件：`/usr/lib/chatgpt/ChatGPT`

运行时要求 `/proc` 已挂载，并且 Linux 支持 `pidfd`。目前不支持 Snap、Flatpak、AppImage、本地或迁移后的安装、包装脚本或 `alternatives` 启动器、ARM64，以及 Linux installer/self-update 包。

## 进程所有权

CodexHost 不会接管独立运行的 ChatGPT App。启动 CodexHost 前，请完全退出 ChatGPT。受管启动会使用官方启动器，但通过 `/proc` 识别和监督真实 Desktop 可执行文件；只有重新校验 PID、启动时间和可执行文件身份后才会发送关闭信号。

## 诊断

```bash
codexhost inspect
codexhost --version
```

`inspect` 会报告识别出的包身份、版本、启动器、可执行文件和运行进程 ID。ChatGPT App 更新后，如果兼容检查提示 Desktop 身份不受支持，请先升级 CodexHost。
