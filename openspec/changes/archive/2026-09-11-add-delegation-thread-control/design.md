## Context

现有 Delegation 控制面通过统一 `DelegationControlApi` 操作外部 Harness Thread 与原生 Codex Thread。外部 Harness 已通过 `HarnessSession.execute(turn.start|turn.cancel)` 暴露统一命令，原生 Codex 则通过 `OfficialRequestBroker` 发送官方 `turn/start` 与 `turn/interrupt` 请求。当前控制面缺少将这两条既有路径暴露为 CLI 的能力。

## Goals / Non-Goals

**Goals:**

- 在同一普通可写 Thread 中追加第二轮及后续 Turn。
- 取消当前活跃 Turn，保留 Thread 和历史。
- 对外部 Harness 与原生 Codex 提供一致结果、幂等和错误语义。
- 支持裸 ID 与 `codex://threads/<id>`。

**Non-Goals:**

- 不实现阻塞式 Interaction 回复。
- 不允许同一 Thread 并发多个 Turn。
- 不新增工作流、自动重试或任务追加队列。
- 不改变 `read`、`wait` 的只读行为。

## Decisions

### 使用 `thread send` 操作普通可写 Thread

send 接收 Thread 标识和消息，在目标 Thread 中启动新 Turn并立即返回 `threadId`、`turnId`、`harnessId`、`status` 与后续 read/wait 命令。它既可用于委派子 Thread，也可用于用户显式提供的普通可写 Thread。

### 忙碌 Thread 拒绝 send

当 Thread 已有活跃 Turn 时返回 `THREAD_BUSY`，不排队、不取消旧 Turn，也不并发启动新 Turn。这样保持现有 HarnessSession 的单活跃 Turn 模型。

### cancel 取消当前 Turn 而非删除 Thread

外部 Harness 调用统一 `HarnessSession.execute({type: "turn.cancel"})`；原生 Codex 调用官方 `turn/interrupt`。没有活跃 Turn 时返回稳定的 `cancelled: false`，不视为错误。

### 复用现有 Session 路由

`DelegationControlRegistration` 新增 send/cancel，Registry 继续按 Thread 所有权将请求路由到对应 Host Session。控制服务只增加两个 loopback 路由。

## Risks / Trade-offs

- [原生 Codex 官方取消方法或响应形状变化] → 复用当前 Host 已使用的官方 Turn interrupt 路径，并添加聚焦测试。
- [发送请求发生未知网络结果时调用方无法安全自动重试] → 首版不承诺 send 幂等；调用方先用 `thread read` 确认状态，再决定是否重发。
- [高权限任务误操作] → 提供显式 cancel，且 send 对忙碌 Thread 失败关闭。
