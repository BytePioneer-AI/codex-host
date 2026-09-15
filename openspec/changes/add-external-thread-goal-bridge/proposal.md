## Why

Codex Desktop 的 `/goal` 通过 `thread/goal/set|get|clear` 工作，codexhost 对外部 Thread 一律返回 `-32076`，Claude Code 线程无法设置 Goal，且每次 resume 后 Desktop 都记录补水失败。Claude Code 自 2.1.139 起自带 `/goal`（Stop hook 评估器驱动的原生续跑），应按产品原则桥接原生能力，而不是在 Host 侧自造一套等价循环。

## What Changes

- 新增 Harness Session 可选能力 `goal`（set / clear / read）与 `session.goal.changed` 事件，形态与 `commands` 一致；没有原生 Goal 的 Harness 不暴露它。
- Host 对外部 Thread 显式处理 `thread/goal/set|get|clear`，把 Harness Goal 投影为 Codex `ThreadGoal`，并发出 `thread/goal/updated|cleared`；Desktop 独有的 `paused`、token 预算和用量基线由 Host 补足。
- Claude Code Adapter 通过原生 `/goal <objective>`、`/goal clear` 和 transcript `goal_status` 记录实现该能力；`/goal` 被拒绝时静默撤回 Turn。
- 历史读取识别 `/goal` 命令记录。

## Capabilities

### New Capabilities

- `external-thread-goal-routing`: 外部 Thread 的 Codex Goal 方法路由、状态映射与通知。

### Modified Capabilities

- `harness-adapter-text-session`: 增加 Harness 拥有的 Session Goal 能力与事件契约。
- `claude-code-text-session`: 增加 Claude Code 原生 `/goal` 的映射、证据来源与拒绝处理。

## Impact

- `packages/harness-adapter`（契约与测试替身）、`packages/adapters/claude-code`、`packages/host-runtime`。
- 不涉及 mapping-store 持久化、Renderer 绑定或官方 Codex Thread 路径。
