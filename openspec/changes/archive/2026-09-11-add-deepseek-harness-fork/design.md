## Context

公共 Fork 路由只传递 Adapter 自己发布的 `NativeSessionRef` 与 `NativeCheckpointRef`，并在成功后确认派生 Session 的 Native Ref 归属；它无法理解 DSH 原始事件。因此，精确边界和派生历史真实性必须由 DeepSeek Adapter 在私有协议边界内完成。

DSH `sessions.fork` 的 `atSeq` 不是严格相等匹配：它选择第一个 `seq >= atSeq` 的 `turn/end`，省略或越过日志尾部还会回退到最后一个完成 Turn。目标 `turn/end` 后到下一次 `turn/start` 前的 log-only 事件同样进入 child seed。child 创建后通常追加 `session/end-seed`，Agent setup 还可以追加 child-owned log-only 状态。

## Goals / Non-Goals

**Goals:**

- 让历史 Snapshot 与实时 terminal 为同一 DSH Turn 发布完全一致的可 Fork Checkpoint。
- 只在源 cwd 与目标 cwd 相同时执行原生 Fork，并精确包含所选完成 Turn及其 between-turn 状态。
- 对原生返回、partial success 和派生历史执行失败关闭验证。
- 保持源 Session 可继续运行，派生 Session 后续输入只进入 child。
- 使用相同原语为 Modern Session 创建精确少一轮的 replacement，并交给现有 Host 回滚事务提交。
- 保持 DSH RPC、事件和错误细节只存在于 DeepSeek Adapter 包内。

**Non-Goals:**

- 不实现跨 cwd Fork、任意多轮当前 Thread 回滚、Worktree 或项目文件回退。
- 不新增 Session delete/discard、幂等 Fork key 或失败后的自动清理重试；当前 DSH 未提供这些原语。
- 不修改公共 Fork 契约、Host 路由或 Renderer 控件。
- 不在 Fork 后调用 `selectModel` 覆盖 child 的原生历史配置。

## Decisions

### 1. Checkpoint 使用精确的 `turn/end` 序号

Checkpoint ID 固定编码为 `turn-end:<seq>`，只接受 `/^turn-end:(0|[1-9]\d*)$/u` 且结果必须为非负安全整数。历史投影直接使用 `turn/end` 事件的 `seq`；实时 Mux 路径把同一个 `seq` 传入 terminal 投影。成功、失败和取消都属于已关闭 Turn，均可发布 Checkpoint。

`NativeTurnRef` 继续以 DSH turn number 表示稳定 Turn identity；Checkpoint 独立使用 terminal event seq，不能混用两种身份。

### 2. Fork 前直接读取原生源历史

Adapter 严格解析 source/checkpoint schema，并要求 Harness ID 与 Native Session ID 一致。随后并行读取 `sessions.list()` 和完整分页历史：

- 源 Session 必须存在且提供 cwd 元数据；元数据缺失是协议错误。
- 规范化 cwd 不同则返回 `unsupported`，且不得调用原生 Fork。
- 历史事件 seq 必须从 0 连续，Checkpoint 必须精确指向真实 `turn/end`。
- seed 预期包含该 terminal 以及下一次 `turn/start` 前已观察到的所有 log-only 事件。

该路径不调用已打开源 `HarnessSession.readSnapshot()`。Host 可以在源有活动后续 Turn 时 Fork 较早的持久化 Checkpoint，而源 Session 的普通 Snapshot read 会因互斥状态返回 busy。

### 3. 原生调用不允许近邻回退

Adapter 始终调用：

```ts
sessions.fork({ sessionId: sourceSessionId, atSeq: terminalSeq })
```

不得省略 `atSeq`、传 User message seq、自动改用末次完成 Turn或失败后重试。这样把 DSH 的“首个后继 terminal”语义收窄为公共契约要求的精确 Checkpoint。

### 4. 派生历史在发布前失败关闭

取得 child ID 后先为 child 建立订阅，再并行读取完整 child history 与 `sessions.models()`。只有下列条件全部成立才返回 Session：

- child ID 与 source ID 不同；
- 预读的原始 seed `HistoryEntry.event` 在 child 中逐项深等；
- 非继承 seed 以 `session/end-seed` 分界，后续 child-owned setup 事件中没有 `turn/start`；
- child 投影 Turn 数与预期完全相等，不含目标之后的源 Turn；
- terminal Checkpoint ID 未变化，且所有 NativeTurnRef/Checkpoint 都归属 child。

任何不匹配返回 `protocolError` 并立即移除 child subscriber。DSH 没有删除接口，因此验证失败后可能留下不可归属的原生 child；这比把错误历史注册成 Host Thread 更安全。

### 5. Partial success 采用已创建 child

`workspace-attach-failed` 发生在 child 已发布之后，错误 details 携带真实 child Session ID。Adapter 提取该 ID并执行完整后验验证；验证通过即采用该 Session，验证失败则返回错误。自动重试会再创建一个 child，因此禁止重试。

### 6. child 配置以原生回读为准

DSH 从 seed 内最新的已记录 Model/Thinking 选择恢复 child。Adapter 使用 child `sessions.models()` 的 `current`、reasoning metadata 和 catalog 构造初始状态。较早 Checkpoint 因此可恢复较早配置；源页面 Fork 时刻的最新选择不是第二真相源。

### 7. 错误映射保持可操作且不重试

- foreign/mismatched refs → `invalidRequest`
- 非法、不存在或原生拒绝的 boundary → `checkpointNotFound`
- `session-not-found` → `sessionNotFound`
- cwd 不同 → `unsupported`
- cwd 元数据或 child/history 不一致 → `protocolError`
- 其他原生/transport 失败 → `nativeFailure`

原生 Fork 调用后的失败均不声明可重试，因为 DSH 不能以调用方提供的 child ID 或幂等 key 对账一次未知结果。

### 8. Last-Turn Rollback 复用 Fork 与 Create

该能力只由 exact `dsh-v0.1.2-rc.1` Modern Adapter 声明，Legacy `dsh-v0.1.1-rc.2` 继续报告不支持。Adapter 先读取并严格投影来源 journal；存在未完成 Turn 时返回可重试的 `sessionBusy`，零个完成 Turn 时返回 `invalidState`，且两者都不创建 Native Session。

来源有两轮及以上时，Adapter 取倒数第二轮的 `turn/end` Checkpoint，直接复用相同的 `session/fork` 调用和 child 后验验证。来源只有一轮时，rc.1 没有零 Turn Fork boundary，因此调用 `session/create` 创建新 ID，并从来源 journal 的 `projections.values.agentPreset` 读取当前 Agent Preset 显式传入；不能使用可能已经过时的 header。新 ID 必须与来源不同，新 journal 必须确认同一 Preset、零个完成 Turn且没有未完成 Turn，否则失败关闭。真正空 Session 的 journal/projection baseline 使用合法的 `cursor=-1`，配置读取必须接受该 baseline，后续 Model/Thinking/Permission 仍由 Host 恢复。

Adapter 只返回 replacement Session，不关闭或修改来源。Host 继续使用现有 Last-Turn Rollback 事务恢复并验证 Model、Thinking 与 Permission，确认 Snapshot 恰好少一轮后原子替换 mapping。该流程不复制可见文本、不修改 DSH 原始历史，也不回退上一轮对工作区文件造成的改动。

## Risks / Trade-offs

- [Fork 响应丢失或后验验证失败留下孤儿 Session] → 失败关闭且禁止自动重试；待 DSH 提供幂等 child ID/key 或 delete API 后再补偿清理。
- [源在预读与 Fork 之间追加事件] → 原始 seed 检查拒绝无法证明的边界，不静默放宽到后一个 Turn。
- [Agent setup 在 marker 后追加权限等状态] → 允许 child-owned log-only 事件，但拒绝任何额外 `turn/start` 并要求投影 Turn 数精确。
- [Session list 缺少 cwd] → 返回协议错误；不能在无法证明同 cwd 时宣称安全 Fork。
- [回滚后用户误以为原 DSH Session 或文件被改写] → 明确 replacement 语义；来源 Session 与工作区文件均保持不变。

## Migration Plan

无持久化迁移。已有 DeepSeek Thread 在下一次 Snapshot read 后获得稳定 Checkpoint；新 Fork 和 Last-Turn Rollback 继续使用现有 Mapping Store 与 Host Runtime 提交流程。撤销本变更时将对应能力恢复为 false 并停止发布 Checkpoint，不删除任何 Native Session。
