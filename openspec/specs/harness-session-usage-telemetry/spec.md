# harness-session-usage-telemetry Specification

## Purpose

Define UI-independent, optional Native Session Usage snapshots, Pi collection semantics, Host ownership, Codex protocol projection, and privacy-preserving validation.

## Requirements

### Requirement: Harness Usage 必须是规范化的原生事实快照

Harness Adapter 契约 MUST 定义 UI 无关的 `HostUsage` 快照，用于表达当前 Native Session 的累计 Token、成本和当前上下文窗口用量。每个已填充的数值字段 MUST 是有限非负数，每个 Token 字段 MUST 是安全整数，`contextWindowTokens` MUST 大于零，`contextWindowTokens` 和 `contextUsedTokens` MUST 同时存在或同时缺失，并且至少一个可靠字段 MUST 存在。Adapter MUST 省略未知字段，并 MUST NOT 根据 Host Transcript 文本、Tool 参数、Model 名称、耗时或本地重新分词的消息副本估算 Usage。

#### Scenario: Native Harness 报告完整上下文用量

- **WHEN** 具体 Adapter 从 Native Session 获得可靠的当前上下文已用 Token 数，以及与之匹配的活动 Model 上下文窗口大小
- **THEN** Adapter MUST 在同一个 `HostUsage` 快照中发布两个规范化上下文字段
- **AND** Adapter MUST 保留其他每个可靠的原生 Token 或成本字段，且不得暴露原生 payload

#### Scenario: Native Harness 缺少某个指标

- **WHEN** Native Session 没有可靠报告成本、缓存 Token、Token 明细或上下文窗口用量
- **THEN** Adapter MUST 省略该指标，而不是发布零值或推导估算值

#### Scenario: 原生 Telemetry 格式错误

- **WHEN** Telemetry Response 包含负数、非有限值、非数值或结构不完整的上下文窗口值
- **THEN** Adapter MUST 将该次观测拒绝为不可用
- **AND** Adapter MUST NOT 发布部分有效的上下文窗口字段对

### Requirement: Harness Session 必须将 Usage 与控制状态分离

每个 `HarnessSession` MUST 暴露初始 Usage，其值是一个完整 `HostUsage` 快照或 `null`；有序 `HarnessOutput` 流 MUST 支持携带完整替换快照或 `null` 的 `session.usage.changed`。Usage MUST NOT 加入 `HarnessSessionState`、满足 Session 状态等待器、改变 Session capabilities，或充当第二条命令/查询结果通道。

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

#### Scenario: 先前有效的 Usage 不再适用

- **WHEN** Native Session 身份或 effective Model 改变，且 Adapter 尚不能把旧上下文快照关联到新状态
- **THEN** Adapter MUST 先发布值为 `null` 的 `session.usage.changed`，不得继续把旧快照呈现为当前值

### Requirement: Usage Telemetry 不得改变生命周期正确性

Usage 采集和投影 MUST 始终是可选 Telemetry。Usage 读取失败、不可用或不受支持时，MUST NOT 拒绝原本已接受的 Turn、改变其 outcome、创建第二个 Turn terminal、Fault 仍可使用的 Session，或阻塞有界 close。`session.usage.changed` 事件可以携带关联的 Host Turn ID 作为观测边界，但它仍是 Session 级事件，并可以出现在该 Turn 的 terminal 事件之后。

#### Scenario: 成功 Turn 后 Usage 刷新失败

- **WHEN** Native Turn 到达已证明成功的 terminal，但后续 Usage 读取失败
- **THEN** Turn MUST 仍然且仅完成成功一次
- **AND** Adapter MUST 保留仍然适用的最近可靠快照或 `null`

#### Scenario: Provider 在流式执行期间报告 Usage

- **WHEN** 未来 Adapter 在活动 Turn 期间收到可靠的原生 Usage 更新
- **THEN** Adapter 可以发布与该 Turn 关联、经过合并的 `session.usage.changed` 快照
- **AND** 这些更新 MUST NOT 创建、完成或重新打开任何 Item 或 Turn

#### Scenario: Telemetry 未完成时关闭 Session

- **WHEN** Session close 开始时仍有非必要 Usage 刷新待处理
- **THEN** close MUST 取消该刷新或限制其等待时间，并释放 Native runtime
- **AND** close MUST NOT 为保留 Telemetry 而无限等待

### Requirement: Pi Usage 必须来自结构化 Native Session RPC

Pi Adapter MUST 从 Pi 的结构化 `get_session_stats` Response 读取当前 Usage，并把 `contextUsage.tokens` 和 `contextUsage.contextWindow` 映射为规范化上下文字段对。仅当当前 Pi 进程明确报告不支持 `get_session_stats` 时，Pi Adapter MUST 使用 `get_state.contextUsage`。Pi Adapter MUST NOT 解析 Pi TUI 输出、检查 Session 文件执行 Token 计算，或维护 Model ID 对应的上下文窗口表。

#### Scenario: 当前 Pi 支持 Session 统计

- **WHEN** Pi 从 `get_session_stats` 返回有效的 Token totals、cost 和 context usage
- **THEN** Pi Adapter MUST 把可靠字段规范化为一个完整 `HostUsage` 快照
- **AND** Pi Adapter MUST NOT 为 Usage 发起回退 `get_state` Request

#### Scenario: Pi 不支持统计命令

- **WHEN** Pi 对 `get_session_stats` 返回已验证的 unsupported-command Response
- **THEN** Pi Adapter MUST 读取 `get_state.contextUsage`
- **AND** Pi Adapter MUST 只发布该状态中可获得的上下文字段对

#### Scenario: Pi 统计因其他原因失败

- **WHEN** `get_session_stats` 超时、返回格式错误的数据，或以已验证 unsupported-command 之外的错误失败
- **THEN** Pi Adapter MUST 将该次观测视为不可用
- **AND** Pi Adapter MUST NOT 把该失败静默地重新解释为旧版本兼容场景

### Requirement: Pi 必须在权威生命周期边界刷新 Usage

Pi Adapter MUST 在打开 Native Session 进行恢复之后、活动 Turn 内每个原生 Assistant Message 完成之后、每个已接受输入到达 Pi 稳定 terminal 条件之后、手动或自动 Compaction 完成之后，以及 Model 选择改变 Native Session 的 effective configuration 之后请求 Usage。刷新 Request 和产生的事件 MUST 串行化，确保较旧观测不能覆盖较新的 Session 或 Model generation。

#### Scenario: Pi 首个 Assistant Message 提供 Usage

- **WHEN** Pi 首个 Turn 的 Assistant Message 已完成并提供可靠 Session Usage，但 Tool 或 Turn 仍在运行
- **THEN** Pi Adapter MUST 立即请求并发布关联该活动 Turn 的当前 Usage
- **AND** Pi Adapter MUST NOT 等待 Turn terminal 才首次提供上下文窗口数据

#### Scenario: Pi 首个 Turn 分配 Session

- **WHEN** 延迟创建模式的 Pi Session 完成首个已接受 Turn
- **THEN** Pi Adapter MUST 发布该新分配 Native Session 的当前 Usage
- **AND** 后续 Turn MUST 刷新同一 Session 快照，而不是创建另一个 Usage owner

#### Scenario: 恢复现有 Pi Session

- **WHEN** Host 通过 `open(resume)` 打开已映射的 Pi Thread
- **THEN** Pi Adapter MUST 尝试从恢复的 Native Session 执行一次有界 Usage 读取
- **AND** Pi Adapter MUST NOT 要求再执行一个用户 Turn 才提供可靠的当前 Usage

#### Scenario: Pi Compaction 降低上下文用量

- **WHEN** 手动或自动 Pi Compaction 完成，且原生上下文用量下降
- **THEN** 下一份发布的快照 MUST 反映 Compaction 后的原生值
- **AND** Host MUST NOT 继续把 Compaction 前的值保留为当前值

#### Scenario: 旧刷新在 Model 改变后返回

- **WHEN** 针对较早 effective Model 发起的 Usage Request，在更新的 Model generation 已确认之后才返回
- **THEN** Pi Adapter MUST 丢弃该过期结果
- **AND** 只有与已确认 effective Model 关联的 Usage 才能成为当前值

### Requirement: Host 必须拥有外部 Thread 的最新 Usage 快照

External Thread Runtime MUST 消费每个已注册 `HarnessSession` 的初始 Usage 和 `session.usage.changed`，为每个已加载外部 Thread 最多保留一份最新快照，并且不得检查原生 Harness 字段。Session 替换、Thread 删除和 Host shutdown MUST 丢弃该内存快照。Mapping Store MUST NOT 持久化 Usage、cost、context history 或规范化 Usage timeline。

#### Scenario: 两个 Harness 发布 Usage

- **WHEN** 两个已注册 Fake Harness 为两个外部 Thread 发布不同的规范化 Usage 快照
- **THEN** Host MUST 将每份快照绑定到其所属 Thread 和 Session
- **AND** 任一路径 MUST NOT 包含 Pi 或 Claude Code 分支

#### Scenario: 过期 Session 在替换后产生输出

- **WHEN** External Thread Runtime 已替换旧 HarnessSession，而旧 Session 随后发出或完成 Telemetry
- **THEN** Host MUST 忽略该过期 Session 的值
- **AND** Host MUST 保留替换后 Session 的最新 Usage

#### Scenario: Host 重启

- **WHEN** Host 重启并从 Mapping Store 恢复外部 Thread
- **THEN** Host MUST 从恢复后的 HarnessSession 获取当前 Usage
- **AND** Host MUST NOT 根据已持久化的 Turn mappings 或 Transcript projections 重建 Usage

### Requirement: Protocol Core 必须通过原生 Codex Notification 投影当前 Usage

Protocol Core MUST 独占从规范化 `HostUsage` 到当前 Codex app-server `thread/tokenUsage/updated` Notification 的转换。Notification MUST 携带准确的外部 Host Thread ID、关联的活动或最近已完成 Host Turn ID，以及包含`total`、`last`和`modelContextWindow`的协议有效`tokenUsage`对象。可靠且完整的`contextUsedTokens/contextWindowTokens`字段对 MUST 足以构造当前上下文表盘carrier；当Session aggregate可用时`total` MUST投影其可靠字段，当aggregate不可用时Protocol Core MUST只在Codex专用carrier中生成全零的必填`total` breakdown占位，且 MUST NOT把占位回写`HostUsage`或声称Native Session累计量为零。Host MUST NOT通过任意Renderer Request method暴露`HostUsage`。

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
- **AND** 再次访问该 Thread 时 MUST NOT 要求执行新 Turn 才能恢复其上下文表盘

### Requirement: Usage 验证必须分层并保护隐私

Hermetic tests MUST 使用 Fake Harness 和 Fake Pi 证明契约，且不得启动用户 Harness。显式真实 Pi 和 Desktop Gates MUST 使用合成临时工作、有界执行和脱敏观测；受版本控制文件 MUST NOT 包含原始 Native Session 统计、Prompt 或 Transcript 内容、Model 名称、完整 ID、账户数据、凭据、与用户关联的成本或本地绝对路径。

#### Scenario: 运行常规质量检查

- **WHEN** CI 或开发者运行常规检查
- **THEN** Usage 契约、Pi parser、Host 隔离、顺序和 Protocol projection tests MUST 使用合成值确定性运行
- **AND** 这些检查 MUST NOT 启动 Pi、Codex Desktop 或 Model Request

#### Scenario: 声明真实 Desktop 上下文表盘能力

- **WHEN** Change 声明受支持 Codex Desktop 能够显示外部 Thread 上下文用量
- **THEN** 受控 Gate MUST 证明原生 Usage Notification 为真实 Pi Thread 更新实际上下文窗口界面
- **AND** 提交的记录 MUST 只包含有界枚举、匿名 ordinal、数值关系断言和 pass/fail 结果
