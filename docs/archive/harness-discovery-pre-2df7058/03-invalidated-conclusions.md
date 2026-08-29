# 已失效结论与当前事实

> **已归档。** 本文明确标注早期分析中不能继续引用的结论。

## “Pi 不支持自动发现”

**失效。**

Pi 会通过公共发现引擎搜索：

- 当前 `PATH`；
- `~/.npm-global/bin`；
- `~/.local/bin`；
- 多种 Node.js 版本管理器目录；
- Homebrew 和 `/usr/local/bin`；
- Windows npm、`.local/bin` 和版本管理器目录。

如果仍未找到，Pi 保留返回默认命令并在 spawn 阶段失败的语义。这不等于“不支持自动发现”。

## “所有 Harness 都已经统一发现”

**失效或表述过度。**

Claude Code、Pi、OMP 和 Grok 已使用公共可执行文件发现。DeepSeek Harness 仍在 Adapter 内查找当前 `PATH` 中的 `dsh`/`npx`。

此外，进程 invocation 和 Node Runtime PATH 补全还没有完全统一：

- Grok 使用公共 `commandInvocation()`，但没有补充 Node Runtime PATH；
- Pi、OMP 补充 Node Runtime PATH，但仍保留自己的 Windows invocation；
- DeepSeek 两项都仍为 Adapter 内实现。

## “公共发现包负责 Codex Desktop/codexhost 的安装发现”

**错误。**

`@codexhost/harness-discovery` 只负责外部 Harness CLI。Codex Desktop/codexhost 的原生应用定位、验证、Launcher 和平台集成不属于该包。

## “只要扫描 NVM 就足够”

**失效。**

当前公共实现还扫描 fnm、Volta、asdf、nodenv、`n`、Bun、pnpm、Homebrew keg-only Node，以及 Windows 的 nvm-windows 等常见布局。

## “找到跨 Node 版本安装的入口就一定能运行”

**不成立。**

发现只证明入口文件存在且符合可执行性检查。Harness 的 Node.js engine 要求、shim 对版本管理器环境的依赖，以及实际子进程使用的 Node Runtime 仍可能导致启动失败。

## “任何安装位置都能自动发现”

**不成立。**

当前策略覆盖常见目录，不遍历整个磁盘。任意自定义目录仍应通过以下 Host 配置显式指定：

```text
CODEXHOST_CLAUDE_COMMAND
CODEXHOST_PI_COMMAND
CODEXHOST_OMP_COMMAND
CODEXHOST_GROK_COMMAND
CODEXHOST_DEEPSEEK_HARNESS_COMMAND
```

## `PI_COMMAND` 与 `CODEXHOST_PI_COMMAND` 是同一个配置入口

**需要限定。**

- Host Runtime 的对外环境变量是 `CODEXHOST_PI_COMMAND`，读取后作为显式 Adapter option 传入；
- Pi Adapter 的发现规格还兼容直接传入环境中的 `PI_COMMAND`。

OMP 也存在类似的 Host 外部变量与 Adapter 内兼容变量分层。文档必须说明作用层级，不能把名称直接互换。

## “DeepSeek endpoint 是远程模型 API”

**错误。**

DeepSeek endpoint 是本机 loopback DSH Web Host，默认：

```text
http://127.0.0.1:3080/
```

Adapter 优先连接现有 Host；不可用时才查找并启动本地 `dsh` 或 `npx`。它不是 DeepSeek 云端 Model API 地址。

## “内部 Workspace 包会独立发布到 npm”

**错误。**

`@codexhost/harness-discovery` 标记为 `private: true`，不在 npm 发布计划中。它是内部模块边界，代码随正式 codexhost 运行产物交付。
