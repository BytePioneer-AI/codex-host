## Why

当前跨 Harness 委派只能创建子 Thread 并观察结果，发起 Agent 无法在同一子 Thread 中继续第二轮、第三轮对话，也无法停止一个正在执行的错误或过长 Turn。需要补齐最小的持续控制能力，同时保持现有 Thread、Session 和 Adapter 语义。

## What Changes

- 新增 `codexhost thread send <thread> --message <text>`，在已有普通可写 Thread 中启动新的 Turn 并立即返回。
- 新增 `codexhost thread cancel <thread>`，取消已有 Thread 当前正在运行的 Turn，但保留 Thread 及历史。
- 裸 Thread ID 与 `codex://threads/<id>` 对 send/cancel 保持等价。
- send 在 Thread 忙碌时明确失败，不并发启动第二个 Turn。
- 原生 Codex 与外部 Harness 使用一致的 send/cancel 结果和错误语义。
- `thread read`、`thread wait` 继续保持非消费性只读语义。

## Capabilities

### New Capabilities

### Modified Capabilities

- `cross-harness-delegation`: 增加对已有委派或普通可写 Thread 的后续 Turn 投递和当前 Turn 取消能力。

## Impact

- Host Runtime Delegation 控制契约、CLI、loopback 控制服务与 Session 路由。
- 外部 Harness Thread Runtime 与原生 Codex OfficialRequestBroker 路径。
- Launcher/npm 帮助文本及聚焦测试。
