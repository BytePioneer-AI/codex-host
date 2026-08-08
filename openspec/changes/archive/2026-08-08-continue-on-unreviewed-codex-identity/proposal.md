## Why

Codex Desktop 更新可能只改变压缩类名等内部标识，而服务路径、方法结构、窗口归属和 Renderer 必要结构仍保持兼容；当前实现把这类未评审标识直接视为签名失败，导致 Desktop Controller 在 readiness 前退出，用户只看到应用关闭或空 readiness 错误。需要在不放宽必要结构检查的前提下，让仅内部标识未评审的 build 继续运行，并向用户提供清晰、可操作且脱敏的兼容提示。

## What Changes

- 将主进程标题服务检查拆分为必要结构契约与已评审内部标识：必要结构通过但压缩类名未评审时，标题策略继续安装并返回有界 warning；必要结构失败仍保持现有 fail-closed 行为。
- 扩展 Desktop Controller 与 Launcher readiness，使成功启动可以携带严格、脱敏的兼容 warning，而不是通过异常、stderr 文本或空 stdout 表达。
- Launcher 在受管 Desktop 完成安装后显示原生兼容提示，允许用户继续使用 codexhost、打开固定 GitHub Releases 最新版页面，或退出受管链路后启动原版 Codex。
- 用户选择继续后，按 Codex version、bundle build、官方 ASAR integrity、codexhost version 和 warning reason 记忆本次确认；任一指纹部分变化时重新提示。
- 兼容详情只显示 Desktop/codexhost 版本、能力名、reason code、已评审与实际内部标识及必要结构 PASS，不记录 Prompt、Transcript、Model 值、Thread/Request ID 或用户路径。
- 本次不增加自动下载/安装、Desktop 版本白名单或兼容矩阵，不扩展其他私有结构检测，不把任意结构错误变为可继续 warning。

## Capabilities

### New Capabilities

- `codex-desktop-compatibility-guidance`: 定义未评审内部标识 warning 的用户提示、固定操作、脱敏详情和按 build 确认记忆。

### Modified Capabilities

- `versioned-renderer-agent-routing`: 标题服务必要结构保持 fail closed，但仅已评审压缩类名不匹配时允许继续安装并报告 warning。
- `running-desktop-attachment`: Controller/Launcher readiness 支持成功携带兼容 warning，Launcher 在发布受管运行状态前处理用户选择，并可安全切换到原版 Codex。

## Impact

- 受影响模块：`packages/desktop-control`、`crates/launcher`、`crates/platform`，以及相关 Shared Contracts/本地状态模块（若设计确认需要共享严格 Schema）。
- 受影响测试：标题策略结构分类、Controller readiness、Launcher warning 状态机、Windows/macOS 原生提示、固定 GitHub URL、原版 Codex 无 Shim 启动和指纹确认失效。
- 受影响产品基线：未知 Desktop 版本仍不因版本号本身被阻止；是否继续由必要结构检查决定，不建立版本白名单或兼容矩阵。
- 不修改 Codex Desktop、ASAR、Harness、Thread 数据、Host 路由协议或 codexhost 自更新下载链路。
