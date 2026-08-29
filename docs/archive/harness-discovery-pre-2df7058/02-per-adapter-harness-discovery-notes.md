# 历史主题：公共包实施前的 Adapter 命令发现

> **已归档。** 以下内容描述 `2df7058` 之前的代码形态。

在公共发现包引入前，Claude Code、Pi、OMP 和 Grok 的 Adapter 各自维护相似但不完全一致的命令查找逻辑。

## 共同模式

这些实现通常包含：

1. 从 Adapter option 或环境变量读取显式命令；
2. 将裸命令名扩展为当前 `PATH` 下的候选路径；
3. Windows 根据 `PATHEXT` 添加 `.EXE`、`.CMD` 等扩展；
4. 检查文件是否存在且可执行；
5. 搜索少量 Harness 专属或用户级安装目录；
6. 找不到时按 Adapter 语义抛错或延迟到 spawn 阶段失败。

这导致 `pathValue`、`pathCandidates`、`isExecutable`、`nvmCandidates`、`userInstallCandidates` 和 `withNodeRuntimeOnPath` 等逻辑在多个包中重复。

## Claude Code

当时的 Claude Code Adapter 已支持：

- 显式 `command`；
- `CODEXHOST_CLAUDE_COMMAND`；
- 当前 `PATH`；
- `~/.npm-global/bin`、`~/.local/bin`、`~/.claude/local`；
- NVM 版本目录；
- `/opt/homebrew/bin`、`/usr/local/bin`；
- Windows `%APPDATA%\npm`；
- 将 `claude.cmd` 替换为 npm 包内的原生 `claude.exe`。

找不到时抛出 `ClaudeCodeExecutableError`。

## Pi

当时的 Pi Adapter 已支持：

- 显式 `command`；
- Adapter 内部兼容 `PI_COMMAND`；
- Host Runtime 通过 `CODEXHOST_PI_COMMAND` 传入显式 command；
- 当前 `PATH`；
- `~/.npm-global/bin`、`~/.local/bin`；
- NVM 版本目录；
- Homebrew 和 `/usr/local/bin`；
- Windows npm 与 `.local/bin`。

找不到时返回 `pi` 或显式命令，保留延迟失败语义。

## OMP

OMP 与 Pi 的发现方式基本相同，使用 Adapter 内部 `OMP_COMMAND`，Host Runtime 则通过 `CODEXHOST_OMP_COMMAND` 传入显式 command。找不到时返回 `omp` 或显式命令。

## Grok

当时的 Grok Adapter 已支持：

- 显式 `command`；
- `CODEXHOST_GROK_COMMAND`；
- 当前 `PATH`；
- `~/.grok/bin`、`~/.local/bin`；
- Homebrew 和 `/usr/local/bin`；
- Windows npm 目录；
- Adapter 内自己的 `.cmd`/`.bat` 调用封装。

找不到时抛出 `GrokExecutableError`。

## DeepSeek Harness

DeepSeek 与其他 Adapter 的传输形态不同：

1. 先连接 loopback DSH Web Host；
2. Host 不可用时，在当前 `PATH` 查找显式命令或 `dsh`；
3. 再查找本地 `npx`；
4. 启动 `dsh web` 或离线、禁止安装的 `npx @deepseek-ai/dsh web`；
5. 等待 HTTP Host 就绪。

它也重复实现了 PATH 候选、可执行文件检查和 Windows shim invocation，但没有包含当时其他 Adapter 的用户安装目录或 NVM 扫描。

## 被公共实现替代的部分

`2df7058` 新增 `packages/harness-discovery`，将以下机制集中管理：

- 环境变量读取；
- `PATH` 与 `PATHEXT`；
- 用户安装目录模板；
- Node.js 版本管理器目录；
- 候选来源诊断；
- Windows shim invocation；
- Node Runtime PATH 补全。

Claude Code、Pi、OMP 和 Grok 的可执行文件发现已迁移。DeepSeek 尚未迁移，Pi/OMP 的 invocation 与 Grok 的 Node Runtime PATH 补全也仍有后续空间。
