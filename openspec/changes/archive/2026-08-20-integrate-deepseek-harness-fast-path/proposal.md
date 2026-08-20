## Why

DeepSeek Harness 已提供可流式输出原生 Session Event 的 stdio JSON-RPC SDK，但 codexhost 尚未注册对应 Adapter。现在先实现一个开发期快速纵向切片，验证新会话、多轮、文本/Reasoning、工具、Diff 和取消主流程，再基于真实使用补恢复与高级控制面。

## What Changes

- 新增独立的 `@codexhost/adapter-deepseek-harness`，通过 DSH JSON-RPC 子进程实现现有 `HarnessAdapter`/`HarnessSession`。
- 使用原生 `session.event` 投影流式文本、Reasoning、工具状态和官方文件工具的结构化 Diff。
- 约定一个最小 `session/cancel` bridge RPC；未提供该方法的运行时明确返回取消失败，不假装成功。
- 将 `deepseek-harness` 加入有限外部 Harness 注册表、Host Runtime 组合和 Renderer Agent 选择路径。
- 第一版只支持新会话和进程内多轮；恢复、Fork、Rollback、提问、审批、权限切换、运行时 Model/Thinking 切换和斜杠命令明确为 unsupported。
- 不增加大范围抽象重构或完整发布打包验证；只增加覆盖路由和事件映射主流程的聚焦测试。

## Capabilities

### New Capabilities

- `deepseek-harness-fast-session`: DSH JSON-RPC 到 codexhost HarnessAdapter 的新会话、多轮、原生事件投影和最小取消能力。

### Modified Capabilities

- `registered-harness-routing`: 有限外部 Harness 注册表和 Host 组合增加 DeepSeek Harness。
- `versioned-renderer-agent-routing`: Renderer 可以选择 DeepSeek Harness，并为新 Thread 注入其独立 transport Model。

## Impact

- 新增 `packages/adapters/deepseek-harness/`，包含 Adapter、stdio JSON-RPC transport、局部 wire 类型和事件映射。
- 修改 `packages/protocol-core`、`packages/host-runtime`、`packages/renderer-extension`、根 TypeScript references、workspace lockfile 和相关聚焦测试。
- 运行时通过 `CODEXHOST_DEEPSEEK_HARNESS_COMMAND` 指定；首版要求该命令实现官方 DSH SDK RPC 加 `session/cancel`。
- 不修改 DSH Session 持久化格式，不让 DSH wire 类型进入 Host Runtime 或共享浏览器契约。
