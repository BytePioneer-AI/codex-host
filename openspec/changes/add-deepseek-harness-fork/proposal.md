## Why

DeepSeek Harness 已通过官方 Host API 提供按完成 Turn 截断的原生 Session Fork，以及创建空 Session 并指定当前 Agent Preset 的原语。codexhost 需要把这些边界可靠地映射到公共 Harness 契约，使 DSH Thread 能沿用现有 Host/Renderer Fork 与“修订上一条消息”管线，同时避免近邻回退、跨 cwd 误用或派生历史不一致。

## What Changes

- 为每个历史及实时完成的 DSH Turn 发布基于原生 `turn/end.seq` 的稳定 Checkpoint。
- 实现同 cwd `open({ kind: "fork" })`，精确调用 `sessions.fork({ sessionId, atSeq })`，不省略边界、不猜测也不自动重试。
- Fork 前校验 Native Ref 归属、真实 `turn/end` 和源 cwd；Fork 后校验 child identity、原始事件 seed、Turn 数、terminal Checkpoint 与全部 child Native Ref。
- 对 `workspace-attach-failed` 携带的已创建 child 执行同样的严格对账，通过后采用，避免重复 Fork。
- 从 child 的 `sessions.models()` 回读实际 Model/Thinking，不使用源页面当前选择覆盖历史配置。
- 为 exact `dsh-v0.1.2-rc.1` Modern 实现 Last-Turn Rollback：多轮 Fork 到倒数第二轮，单轮创建继承当前 Agent Preset 的空 Session，零轮或活动 Turn 失败关闭。
- 将 DeepSeek Harness 的 Model/Thinking、Fork、Last-Turn Rollback 和斜杠命令状态同步到 README、Harness 实现参考及本规范变更。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `deepseek-harness-fast-session`: 补齐当前已实现的 Model/Thinking、Harness Command 和同 cwd 精确 Fork 语义，并收窄真正不支持的能力集合。

## Impact

- `packages/adapters/deepseek-harness`：Checkpoint 投影、原生 Fork、Last-Turn Rollback、错误映射、派生历史验证和测试。
- `README.md`、`docs/README.en.md`、`docs/README.ko.md`：DeepSeek Harness 能力状态。
- `.agents/skills/codexhost-add-harness/references/current-harness-implementations.md`：当前参考实现能力。
- 不修改 shared contracts、Protocol Core、Host Runtime、Renderer、Mapping Store 或项目文件状态。
