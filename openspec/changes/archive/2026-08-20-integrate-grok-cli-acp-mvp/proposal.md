## Why

codexhost 已通过各 Harness 的原生接口接入 Pi 和 Claude Code，但尚不能在 Codex Desktop 中运行 Grok CLI。Grok CLI 已提供 ACP stdio 接口，可以用较小改动快速打通核心 Session、流式输出、工具、审批和取消链路，同时保留 Grok 作为独立 Harness 的原生会话所有权。

## What Changes

- 新增独立 `grok` Harness Adapter，通过 `grok agent --no-leader stdio` 使用标准 ACP v1 创建/恢复 Session、执行和取消 Turn，并投影文本、Thinking、Tool 和 Approval。
- 从 Grok ACP 初始化与 Session 配置响应中探测 Model 和 Thinking/Effort；能力不可用时显式降级，不根据版本号假定支持。
- 使用 Grok 原生 Session ID 恢复 Thread；MVP 只保证 ACP 可回放的历史，不实现任意历史 Fork、Rollback、Slash Commands 或推测性 Edit Diff。
- 将 `grok` 注册为第三个外部 Harness，增加其内部 Transport Model carrier、生产组合和构建依赖。
- 在 Codex Desktop Agent Picker 中增加 Grok，并复用现有外部 Agent 的模型、Thinking、运行状态和 Usage UI。
- 只增加少量协议映射测试和一条显式启用的真实 Grok 冒烟验证，不建设大规模兼容矩阵或完整 E2E Gate。

## Capabilities

### New Capabilities

- `grok-cli-acp-session`: 定义 Grok CLI 通过 ACP 实现的安装检查、能力探测、Session、Turn、Tool、Approval、Cancel、配置、Usage 和 MVP 降级边界。

### Modified Capabilities

- `registered-harness-routing`: 将 Grok 加入有限外部 Harness 注册表、Transport Model 路由和生产 Adapter 组合。
- `versioned-renderer-agent-routing`: 将 Grok 加入受支持 Desktop 的 Agent 选择、配置恢复和可用性展示。

## Impact

- 新增 `packages/adapters/grok`，并引入 `@agentclientprotocol/sdk`。
- 修改 `packages/protocol-core`、`packages/host-runtime`、`packages/renderer-extension` 及其构建/发布配置。
- 不改变官方 Codex 转发路径，不把 ACP 类型暴露给 Host Runtime，不把 Grok 建模为 Model 或 Provider。
- MVP 不修改现有 Fork capability 结构；Grok 声明 `fork=false`、`forkAcrossCwd=false`、`rollbackLastTurn=false`。
