# Linux 支持

codexhost 通过 npm 包或自带运行时的 `.tar.gz` 压缩包支持 x64 和 ARM64 Linux。要使用 Codex Desktop，请先安装与当前架构匹配的官方 ChatGPT App；只用 Web 时不需要。

### npm

```bash
npm install -g @codexhost/cli
codexhost
```

### 压缩包

每个 Release 都会发布 `codexhost-<version>-linux-x64.tar.gz` 和 `codexhost-<version>-linux-arm64.tar.gz`。压缩包自带 Node.js 运行时，不需要另装 Node.js 或 npm。解压到当前用户拥有的目录，将启动器链接到 `~/.local/bin`，并确保 `~/.local/bin` 在 `PATH` 中（例如在 shell 配置中加入 `export PATH="$HOME/.local/bin:$PATH"`）：

```bash
mkdir -p ~/.local/share
tar -xzf codexhost-<version>-linux-x64.tar.gz -C ~/.local/share
mv ~/.local/share/codexhost-<version>-linux-x64 ~/.local/share/codexhost
mkdir -p ~/.local/bin
ln -sf ~/.local/share/codexhost/bin/codexhost ~/.local/bin/codexhost
codexhost
```

`codexhost update` 和应用内更新会从 GitHub Releases 下载对应的压缩包，校验 SHA-256，解压并校验到安装目录旁边，再整体替换安装目录；替换阶段或替换后校验失败时会恢复原目录（替换前失败不会改动现有安装，替换完成后若重启失败则不会回滚已替换的文件）。因此运行 codexhost 的用户必须对安装目录及其上级目录有写权限，不要用 root 把压缩包装到系统目录。同一时间只使用一种安装方式：在 npm 和压缩包之间切换前，先运行 `codexhost stop` 并删除另一种安装。`codexhost autostart on` 登记的是执行该命令的那份安装的启动器。

## 支持范围

Linux 版本支持 x86-64 和 ARM64 上的官方 ChatGPT `.deb` 和 `.rpm` 包。codexhost 的 Linux 原生二进制以 glibc 2.28 为发布基线（与 Node.js 22 和 24 官方 Linux 二进制的要求一致，压缩包内置的 Node.js 也是如此），可在使用 glibc 2.28 或更新版本的系统上装载，包括作为 Remote SSH 主机的 RHEL 8 系发行版；官方 ChatGPT App 自身的发行版支持范围仍以 OpenAI 文档为准。codexhost 会验证生产包元数据、当前架构的 ELF 身份和以下包内入口：

- 启动器：`/usr/bin/chatgpt`
- 安装目录：`/usr/lib/chatgpt`
- Desktop 可执行文件：`/usr/lib/chatgpt/ChatGPT`

运行时要求 `/proc` 已挂载，并且 Linux 支持 `pidfd`。目前不支持 Snap、Flatpak、AppImage、本地或迁移后的 ChatGPT 安装、包装脚本或 `alternatives` 启动器以及跨架构执行，也不支持 Alpine 等基于 musl 的发行版。codexhost 不发布 `.deb` 或 `.rpm` 包。

启动 Host 和 Web 服务时，`HOME` 必须设为绝对路径。设置了 `XDG_RUNTIME_DIR` 和自定义数据目录时也一样。服务在 `$HOME/.codexhost/independent-processes` 下登记监管进程，npm 更新在 `$HOME/.codexhost/updates` 中保存状态。

## Renderer 兼容性

Renderer 集成失败会在后台恢复，不会显示兼容弹窗，也不会写入本地警告确认。外部 Agent 集成不可用时，受管 Desktop 仍可通过官方 Codex 路由使用。Controller 的首次握手仍会对格式错误或不受支持的 readiness 输出按失败关闭处理。

## 进程所有权

codexhost 不会接管独立运行的 ChatGPT App。启动 codexhost 前，请完全退出 ChatGPT。受管启动会直接启动已校验的 Desktop 可执行文件，并通过 `/proc` 监督它；普通 ChatGPT 启动仍使用官方启动器。只有重新校验 PID、启动时间和可执行文件身份后才会发送关闭信号。

在检测到活跃的 Wayland 会话（例如存在 `WAYLAND_DISPLAY`）时，受管启动会自动追加 `--ozone-platform=wayland`、`--enable-wayland-ime` 与 `--wayland-text-input-version=3` 参数，使 Fcitx5 等输入法通过 Wayland 原生协议渲染候选窗，避免 XWayland 兼容层下候选框周围出现黑边。如需回退，请设置 `CODEXHOST_DISABLE_WAYLAND=1`（例如 `CODEXHOST_DISABLE_WAYLAND=1 codexhost`）。

## 诊断

```bash
codexhost inspect
codexhost --version
```

`inspect` 会报告识别出的包身份、版本、启动器、可执行文件和运行进程 ID。ChatGPT App 更新后，可用它确认 codexhost 仍能识别已安装的 Desktop。受支持的 Renderer 表面暂时不可用时，集成会自动重试。
