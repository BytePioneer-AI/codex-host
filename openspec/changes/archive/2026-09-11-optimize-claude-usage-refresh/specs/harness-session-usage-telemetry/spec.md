## MODIFIED Requirements

### Requirement: Harness Usage 必须是规范化的原生事实快照

Harness Adapter 契约 MUST 定义 UI 无关的 `HostUsage` 快照，用于表达当前 Native Session 的累计 Token、成本和当前上下文窗口用量。每个已填充的数值字段 MUST 是有限非负数，每个 Token 字段 MUST 是安全整数，`contextWindowTokens` MUST 大于零，`contextWindowTokens` 和 `contextUsedTokens` MUST 同时存在或同时缺失，并且至少一个可靠字段 MUST 存在。Adapter MUST 省略未知字段。Adapter MUST NOT 根据 Host Transcript 文本、Tool 参数、Model 名称、耗时或本地重新分词的消息副本估算 Usage。Adapter MAY 从原生请求 Usage 与实际 Model/Provider 归属计算短期费用估算，但最终原生累计值到达时 MUST 校准该估算。

#### Scenario: Native Harness 报告完整上下文用量

- **WHEN** 具体 Adapter 从 Native Session 获得可靠的当前上下文已用 Token 数，以及与之匹配的活动 Model 上下文窗口大小
- **THEN** Adapter MUST 在同一个 `HostUsage` 快照中发布两个规范化上下文字段
- **AND** Adapter MUST 保留其他每个可靠的原生 Token 或成本字段，且不得暴露原生 payload

#### Scenario: Native Harness 缺少某个指标

- **WHEN** Native Session 没有可靠报告或可靠估算成本、缓存 Token、Token 明细或上下文窗口用量
- **THEN** Adapter MUST 省略该指标，而不是发布零值或无依据推导值

#### Scenario: 原生请求支持活动 Turn 费用估算

- **WHEN** Adapter 获得请求级结构化 Token Usage、稳定请求身份和实际 Model/Provider 归属，并持有可靠价目
- **THEN** Adapter MAY 把该请求费用合并到当前 Session 的内存估算
- **AND** Adapter MUST NOT 使用当前 UI Model、Host Transcript 文本或 Tool 参数替代实际请求归属

#### Scenario: 原生累计事实到达

- **WHEN** Native Harness 在 Turn terminal 提供可靠的 Session 累计 Token 或成本
- **THEN** Adapter MUST 使用该事实校准对应估算字段
- **AND** 它 MUST NOT 把同一 Turn 的请求估算再次叠加到已校准总数

#### Scenario: 原生 Telemetry 格式错误

- **WHEN** Telemetry Response 包含负数、非有限值、非数值或结构不完整的上下文窗口值
- **THEN** Adapter MUST 将该次观测拒绝为不可用
- **AND** Adapter MUST NOT 发布部分有效的上下文窗口字段对

### Requirement: Harness Session 必须将 Usage 与控制状态分离

每个 `HarnessSession` MUST 暴露初始 Usage，其值是一个完整 `HostUsage` 快照或 `null`；有序 `HarnessOutput` 流 MUST 支持携带完整替换快照或 `null` 的 `session.usage.changed`。HarnessSession MAY expose one optional explicit Usage refresh operation whose only effect is to request a newer normalized snapshot. Usage and refresh state MUST NOT 加入 `HarnessSessionState`、满足 Session 状态等待器、改变 Session capabilities，或充当通用命令/查询通道。

#### Scenario: 恢复时可获得初始 Usage

- **WHEN** Adapter 在打开现有 Native Session 时能够读取可靠的当前 Usage
- **THEN** `open(resume)` 返回时，`initialUsage` MUST 包含该快照
- **AND** Host MUST 能够在消费后续更新之前初始化最新 Usage

#### Scenario: 延迟创建模式尚无 Native Session

- **WHEN** `open(create)` 在 Harness 分配 Native Session 之前返回
- **THEN** `initialUsage` MUST 为 `null`
- **AND** 任何进程 MUST NOT 仅为制造 Usage 值而启动

#### Scenario: 打开后 Usage 发生变化

- **WHEN** Adapter 在 `open()` 之后观测到更新且可靠的 Usage 快照
- **THEN** Adapter MUST 在 Session 和 Turn 事件共用的同一串行化输出通道上入队 `session.usage.changed`
- **AND** 该事件 MUST 原子替换上一份快照，而不是对缺失字段进行局部 patch

#### Scenario: Host 显式请求较新 Usage

- **WHEN** Host 对支持显式刷新操作的 Session 请求精确或较新 Usage
- **THEN** Session MUST 仅刷新该 Session 所有的规范化 Telemetry
- **AND** 刷新 MUST NOT 提交 Turn、改变 Model、执行 Tool 或暴露 Native payload

#### Scenario: 先前有效的 Usage 不再适用

- **WHEN** Native Session 身份或 effective Model 改变，且 Adapter 尚不能把旧上下文快照关联到新状态
- **THEN** Adapter MUST 先发布值为 `null` 的 `session.usage.changed`，或发布移除过期 Context pair 后仍有效的完整快照
- **AND** 它 MUST NOT 继续把旧 Context 呈现为当前值

### Requirement: Usage Telemetry 不得改变生命周期正确性

Usage 采集、估算、刷新和投影 MUST 始终是可选 Telemetry。Usage 读取或估算失败、不可用或不受支持时，MUST NOT 拒绝原本已接受的 Turn、改变其 outcome、创建第二个 Turn terminal、Fault 仍可使用的 Session，或阻塞有界 close。`session.usage.changed` 事件可以携带关联的 Host Turn ID 作为观测边界，但它仍是 Session 级事件，并可以出现在该 Turn 的 terminal 事件之后。所有请求去重、费用增量、Context cache 和 refresh generation MUST 仅驻留内存。

#### Scenario: 成功 Turn 后 Usage 校准失败

- **WHEN** Native Turn 到达已证明成功的 terminal，但后续 Usage 校准缺失或格式错误
- **THEN** Turn MUST 仍然且仅完成成功一次
- **AND** Adapter MUST 保留仍然适用的最近可靠快照、估算或 `null`

#### Scenario: Provider 在流式执行期间报告 Usage

- **WHEN** Adapter 在活动 Turn 期间收到可靠的原生请求 Usage 更新
- **THEN** Adapter MAY publish an associated merged `session.usage.changed` snapshot before Turn terminal
- **AND** 这些更新 MUST NOT 创建、完成或重新打开任何 Item 或 Turn

#### Scenario: Telemetry 未完成时关闭 Session

- **WHEN** Session close 开始时仍有非必要 Usage 刷新或未校准估算待处理
- **THEN** close MUST 取消该刷新或限制其等待时间，并释放 Native runtime
- **AND** 未完成的估算与刷新状态 MUST 被丢弃且不得持久化

### Requirement: Host 必须拥有外部 Thread 的最新 Usage 快照

External Thread Runtime MUST 消费每个已注册 `HarnessSession` 的初始 Usage 和 `session.usage.changed`，为每个已加载外部 Thread 最多保留一份最新快照，并且不得检查原生 Harness 字段。Host MAY route a fixed explicit Usage refresh request to the currently owning HarnessSession, but MUST NOT maintain a second Usage ledger or merge one Session's refresh state into another. Session 替换、Thread 删除和 Host shutdown MUST 丢弃该内存快照。Mapping Store MUST NOT 持久化 Usage、cost、context history、请求 identity、估算增量、刷新缓存或规范化 Usage timeline。

#### Scenario: 两个 Harness 发布 Usage

- **WHEN** 两个已注册 Fake Harness 为两个外部 Thread 发布不同的规范化 Usage 快照
- **THEN** Host MUST 将每份快照绑定到其所属 Thread 和 Session
- **AND** 任一路径 MUST NOT 包含 Pi 或 Claude Code 分支

#### Scenario: Host 路由显式 Usage 刷新

- **WHEN** Renderer 对一个已加载 External Thread 请求显式 Usage 刷新
- **THEN** Host MUST 只调用当前拥有该 Thread 的 HarnessSession 可选刷新操作
- **AND** Host MUST NOT 广播到同 Adapter 的其它 Session

#### Scenario: 过期 Session 在替换后产生输出

- **WHEN** External Thread Runtime 已替换旧 HarnessSession，而旧 Session 随后发出或完成 Telemetry
- **THEN** Host MUST 忽略该过期 Session 的值
- **AND** Host MUST 保留替换后 Session 的最新 Usage

#### Scenario: Host 重启

- **WHEN** Host 重启并从 Mapping Store 恢复外部 Thread
- **THEN** Host MUST 从恢复后的 HarnessSession 获取后续可靠 Usage
- **AND** Host MUST NOT 根据已持久化的 Turn mappings、Transcript projections、费用字段或 Context cache 重建 Usage

### Requirement: Protocol Core 必须通过原生 Codex Notification 投影当前 Usage

Protocol Core MUST 独占从规范化 `HostUsage` 到当前 Codex app-server `thread/tokenUsage/updated` Notification 的转换。Notification MUST 携带准确的外部 Host Thread ID、关联的活动或最近已完成 Host Turn ID，以及包含`total`、`last`和`modelContextWindow`的协议有效`tokenUsage`对象。可靠且完整的`contextUsedTokens/contextWindowTokens`字段对 MUST 足以构造当前上下文表盘carrier；当Session aggregate可用时`total` MUST投影其可靠字段，当aggregate不可用时Protocol Core MUST只在Codex专用carrier中生成全零的必填`total` breakdown占位，且 MUST NOT把占位回写`HostUsage`或声称Native Session累计量为零。Host MUST NOT 通过任意通用 Renderer Request method 暴露原始 `HostUsage`；Host MAY 通过一个固定、严格校验且仅按 External Thread ID 读取当前内存快照并选择可选刷新模式的 Usage inspection contract，向 Renderer 投影浏览器安全的可选 Usage 字段。

#### Scenario: External Thread Usage inspection returns a current browser-safe snapshot

- **WHEN** Renderer invokes the fixed Usage inspection contract with a known External Thread ID and no explicit refresh mode
- **THEN** Host MUST return only the latest in-memory normalized Usage snapshot for that Thread
- **AND** the response MUST omit unknown fields and MUST NOT expose native Harness payloads, Transcript content, credentials, or persisted Usage history

#### Scenario: Exact inspection targets one External Thread

- **WHEN** Renderer invokes the fixed Usage inspection contract with a known External Thread ID and the validated exact refresh mode
- **THEN** Host MUST route at most one refresh request to the currently owning Session and MUST continue to expose only normalized snapshots
- **AND** completion from an obsolete Session MUST NOT replace the current Thread snapshot

#### Scenario: Usage inspection does not become a generic Host query channel

- **WHEN** Renderer invokes the Usage inspection contract with an official Thread ID, an unknown Thread ID, malformed parameters, an unknown refresh mode, or any other method name
- **THEN** Host MUST return an unavailable/validation error without exposing arbitrary Host Runtime state
- **AND** existing official request forwarding and External Thread routing MUST remain unchanged

#### Scenario: 外部 Thread 具有完整且可投影的 Usage

- **WHEN** Host 收到完整且可投影的 Usage 快照，该快照关联的 Turn 已满足 Response 顺序门禁
- **THEN** Protocol Core MUST 为该 Thread 和 Turn 创建一个 `thread/tokenUsage/updated` Notification
- **AND** Codex 专用字段名 MUST 保持在 Harness Adapter 和 Pi Adapter 之外

#### Scenario: 外部 Thread 只有可靠上下文字段对

- **WHEN** Host收到包含可靠上下文字段对但没有Session aggregate的快照，且关联Turn已满足Response顺序门禁
- **THEN** Protocol Core MUST使用真实context used和window构造`last`与`modelContextWindow`
- **AND** 协议必填`total` MUST为全零carrier占位，规范化快照仍 MUST保持aggregate未知

#### Scenario: Usage 缺少可投影的上下文字段对

- **WHEN** 快照缺少上下文窗口已用 Token 或最大 Token 中任意一项，或无法关联活动/最近 Host Turn
- **THEN** Host MUST 保留其他仍有用的内部 Telemetry，但 MUST 省略 Codex Notification
- **AND** Host MUST NOT 虚构 Turn ID、最大窗口或精确 breakdown

#### Scenario: Usage 早于 Turn 接受 Response 到达

- **WHEN** 原生早期 Telemetry 在 Host 写出对应 `turn/start` Response 之前入队
- **THEN** Host MUST 通过现有 response-before-notification 门禁暂存 Codex Usage Notification

#### Scenario: 恢复后读取 Thread

- **WHEN** `thread/read` 恢复一个具有当前 Usage 和至少一个已对齐 completed Turn 的外部 Thread
- **THEN** Host MUST 先写出读取 Response，再发布最新 Usage Notification
- **AND** 再次访问该 Thread 时 MUST NOT 要求执行新 Turn 才能投影已有内存 Usage
