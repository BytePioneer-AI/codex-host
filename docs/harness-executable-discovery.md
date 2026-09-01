# Harness 可执行文件发现与历史分析归档

> 状态：当前实现说明
> 实现基线：`2df7058 feat: unify harness executable discovery`

## 目的

codexhost 从桌面环境启动时，进程拿到的 `PATH` 往往不同于用户的交互式 Shell。与此同时，外部 Harness 可能安装在 npm 用户目录、Homebrew、另一个 Node.js 版本，或 Windows 的 npm shim 目录中。

`@codexhost/harness-discovery` 用于统一解决这类“Harness 已安装，但 codexhost 找不到可执行文件”的问题。

它不负责发现或安装 codexhost 自身，也不负责发现 Codex Desktop 应用包。codexhost/Codex Desktop 的原生安装发现和启动仍由 Launcher、发布包与 Rust 平台层负责。

## 包边界

公共实现位于：

```text
packages/harness-discovery/
```

它是 monorepo 内部的私有 npm Workspace 包：

```json
{
  "name": "@codexhost/harness-discovery",
  "private": true
}
```

该包参与 TypeScript 构建，但不会作为独立 npm 包发布。正式 npm 发布物仍是 `@codexhost/cli` 及对应的平台包；发现代码随 Host Runtime 和 Adapter 的发布产物一起交付。

## 公共能力

### 可执行文件解析

`resolveHarnessExecutable()` 按以下顺序探测候选项：

1. 调用方显式传入的命令；
2. Harness 声明的命令环境变量；
3. 当前进程的 `PATH`；
4. Harness 声明的常见安装目录；
5. Node.js 版本管理器维护的二进制目录。

用户显式配置命令后，如果该命令无法解析，不会静默回退到机器上的另一份安装。

### 跨平台路径处理

公共实现统一处理：

- Windows 环境变量名大小写不敏感；
- Windows `PATHEXT`；
- Windows 与 POSIX 的路径和分隔符语义；
- `~` 与 `${APPDATA}` 等安装目录模板；
- POSIX 执行权限和 Windows 文件存在性检查；
- 带引号的 `PATH` 目录。

### Node.js 版本管理器目录

macOS/Linux 当前覆盖常见的：

- NVM；
- fnm；
- Volta；
- asdf；
- nodenv；
- `n`；
- Bun；
- pnpm；
- Homebrew keg-only Node，例如 `node@22` 和 `node@24`。

Windows 当前覆盖常见的：

- nvm-windows；
- fnm；
- Volta；
- Bun；
- pnpm。

具体版本目录按数字感知的版本号倒序搜索，以便在多个 Node.js 版本都安装了同一 Harness 时得到可预测结果。

### 子进程启动辅助

公共包还提供：

- `commandInvocation()`：封装 Windows `.cmd`/`.bat` 的 `cmd.exe` 调用和参数转义；
- `withNodeRuntimeOnPath()`：把 codexhost 当前 Node Runtime 所在目录加入 Harness 子进程的 `PATH`。

## 当前接入情况

| Harness | 公共可执行文件发现 | 公共 Windows invocation | Node Runtime PATH 补全 | 说明 |
|---|---:|---:|---:|---|
| Claude Code | 是 | 不需要通用 shim 路径 | 是 | Windows 优先把 `claude.cmd` 改写为 npm 包内原生 `claude.exe` |
| Pi | 是 | 否，仍保留 Adapter 内实现 | 是 | 找不到时保留原有延迟失败语义 |
| OMP | 是 | 否，仍保留 Adapter 内实现 | 是 | 找不到时保留原有延迟失败语义 |
| Grok | 是 | 是 | 否 | GUI 精简 `PATH` 下仍应补齐 Node Runtime PATH |
| Qwen Code | 是 | 是 | 否 | GUI 精简 `PATH` 下仍应补齐 Node Runtime PATH |
| DeepSeek Harness | 否 | 否 | 否 | 优先连接 loopback DSH Web Host；本地 `dsh`/`npx` fallback 仍使用 Adapter 内发现代码 |

因此，当前准确结论是：

> Claude Code、Pi、OMP、Grok 和 Qwen Code 已共用可执行文件发现引擎；DeepSeek Harness 尚未迁移。进程 invocation 和 Node Runtime PATH 补全也还没有在所有 Adapter 中完全统一。

## DeepSeek Harness 的特殊性

DeepSeek Adapter 默认连接本地 DSH Web Host：

```text
http://127.0.0.1:3080/
```

连接流程是：

1. 探测已经运行的 loopback HTTP Host；
2. 如果 Host 不可达，查找显式配置的命令；
3. 否则在当前 `PATH` 中查找 `dsh`；
4. 再回退到本地 `npx --offline --no-install @deepseek-ai/dsh`；
5. 启动 `web --host ... --port ...`；
6. 等待 HTTP Host 就绪后建立 HTTP/WebSocket 通信。

DeepSeek 的 endpoint 校验、Host 启动、就绪等待和 HTTP/WebSocket 生命周期属于 Adapter 专用语义，应继续留在 `packages/adapters/deepseek-harness`。

但它的 `dsh`/`npx` 可执行文件发现以及 Windows `.cmd` 调用属于通用机制，后续可以接入 `@codexhost/harness-discovery`。

## 已解决的问题

当前实现主要解决：

- macOS Finder 或 Windows 桌面启动导致 Shell `PATH` 缺失；
- codexhost 与 Harness 安装在不同 Node.js 版本下；
- npm 用户目录、Homebrew 和常见用户二进制目录未进入 `PATH`；
- Windows npm `.cmd` shim 的发现与调用；
- Harness 使用 `#!/usr/bin/env node`，但 GUI 环境找不到 `node`（已接入 PATH 补全的 Adapter）。

## 仍存在的限制

1. **DeepSeek 未使用公共发现引擎。** 本地 DSH Host 未运行且 `dsh` 只存在于非当前 Node.js 版本目录时，仍可能找不到。
2. **Grok 未补充 Node Runtime PATH。** 可以找到 Grok 入口文件，但 GUI 的精简 `PATH` 仍可能让 Node shebang 启动失败。
3. **任意自定义目录不会自动遍历。** 非常规安装位置应通过对应 `CODEXHOST_*_COMMAND` 显式配置。
4. **Windows 自定义版本管理器根目录没有全部覆盖。** 例如自定义 `NVM_HOME`、`VOLTA_HOME` 仍可能需要显式命令。
5. **发现成功不代表运行时兼容。** 找到安装在 Node 24 下的 Harness 后，仍需保证实际用于启动它的 Node Runtime 满足该 Harness 的版本要求。

## 后续建议

按优先级建议：

1. 将 DeepSeek 的 `dsh`/`npx` 发现和 Windows invocation 接入公共包，同时保留其 loopback Host 生命周期；
2. 为 Grok 子进程环境调用 `withNodeRuntimeOnPath()`；
3. 视需要让 Pi、OMP 复用公共 `commandInvocation()`；
4. 增加 Windows 自定义版本管理器根目录支持；
5. 为诊断界面使用 `harnessCandidates()` 输出完整探测路径和来源。

## 历史分析

本次实现前生成的探索性文档混淆了“Codex Desktop/codexhost 原生安装发现”和“外部 Harness CLI 发现”，且包含与当前代码不一致的结论。它们已移入：

```text
docs/archive/harness-discovery-pre-2df7058/
```

归档内容只用于理解决策过程，不应作为当前行为或运维配置依据。
