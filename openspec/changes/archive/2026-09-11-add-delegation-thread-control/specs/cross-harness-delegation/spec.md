## ADDED Requirements

### Requirement: 调用方可向已有可写 Thread 发送后续消息
系统 SHALL 提供 `codexhost thread send <thread> --message <text>`，在用户明确指定的普通可写 Thread 中启动新的 Turn 并立即返回。该操作 SHALL 同时支持外部 Harness Thread 与原生 Codex Thread，并接受裸 Thread ID 或 `codex://threads/<id>`。

#### Scenario: 向已完成的委派 Thread 发送第二轮消息
- **WHEN** 调用方对没有活跃 Turn 的委派子 Thread 执行 `thread send`
- **THEN** Host SHALL 在同一 Thread 中启动新的 Turn
- **AND** 响应 SHALL 包含 `threadId`、新 `turnId`、`harnessId`、`status: "running"`、`next.read` 与 `next.wait`
- **AND** 命令 SHALL 在目标 Turn 完成前返回

#### Scenario: 使用用户提供的深度链接继续普通会话
- **WHEN** 调用方对一个用户提供的 `codex://threads/<id>` 执行 `thread send`
- **THEN** Host SHALL 规范化标识并向该普通可写 Thread 发送消息
- **AND** 裸 ID SHALL 得到等价结果

#### Scenario: Thread 正在运行
- **WHEN** 调用方对已有活跃 Turn 的 Thread 执行 `thread send`
- **THEN** 命令 SHALL 以 `THREAD_BUSY` 失败
- **AND** MUST NOT 排队、取消旧 Turn 或启动并发 Turn

### Requirement: 调用方可取消已有 Thread 的当前 Turn
系统 SHALL 提供 `codexhost thread cancel <thread>`，请求取消目标 Thread 当前活跃 Turn，同时保留 Thread、既有消息和持久化映射。该操作 SHALL 同时支持外部 Harness Thread 与原生 Codex Thread。

#### Scenario: 取消外部 Harness Turn
- **WHEN** 外部 Harness Thread 有活跃 Turn 且调用方执行 `thread cancel`
- **THEN** Host SHALL 通过统一 Harness Session cancel 命令请求取消该 Turn
- **AND** 响应 SHALL 包含 `threadId`、`turnId` 与 `cancelled: true`

#### Scenario: 取消原生 Codex Turn
- **WHEN** 原生 Codex Thread 有活跃 Turn 且调用方执行 `thread cancel`
- **THEN** Host SHALL 通过官方 App Server 的 Turn interrupt 请求取消该 Turn
- **AND** MUST NOT 删除或归档该 Thread

#### Scenario: Thread 没有活跃 Turn
- **WHEN** 目标 Thread 当前没有活跃 Turn
- **THEN** 命令 SHALL 成功返回 `cancelled: false` 与 `turnId: null`
- **AND** MUST NOT 修改 Thread 历史

#### Scenario: 取消后继续对话
- **WHEN** 被取消的 Turn 达到终态且 Thread 再次空闲
- **THEN** 调用方 SHALL 能够继续通过 `thread send` 在同一 Thread 中启动新 Turn

### Requirement: Thread 观察操作继续保持只读
新增 send/cancel 后，`thread read` 与 `thread wait` MUST 保持非消费性只读行为。

#### Scenario: 读取不会执行控制操作
- **WHEN** 调用方执行 `thread read` 或 `thread wait`
- **THEN** Host MUST NOT 启动或取消 Turn、发送消息或回复 Interaction
- **AND** send/cancel MUST 仅由对应的显式命令触发
