## MODIFIED Requirements

### Requirement: Harness Usage 必须是规范化的原生事实快照

Harness Adapter 契约 MUST 定义 UI 无关的 `HostUsage` 快照，用于表达当前 Native Session 的累计 Token、成本、当前上下文窗口用量，以及可选的账号套餐窗口。每个已填充的数值字段 MUST 是有限非负数，每个 Token 字段和 Unix 时间字段 MUST 是安全整数，`contextWindowTokens` MUST 大于零，`contextWindowTokens` 和 `contextUsedTokens` MUST 同时存在或同时缺失，`planFiveHourResetsAtUnix` MUST 只与 `planFiveHourUsedPercent` 一起出现，`planSevenDayResetsAtUnix` MUST 只与 `planSevenDayUsedPercent` 一起出现，套餐 used percent 与 `sessionCacheHitRatePercent` MUST 落在 0 到 100，`timeToFirstOutputMs` MUST 是非负安全整数，`costSource` MUST 是 `publicPrice` 或 `native` 且只与 `totalCostUsd` 一起出现，并且至少一个可靠字段 MUST 存在。Adapter MUST 省略未知字段。Adapter MUST NOT 根据 Host Transcript 文本、Tool 参数、Model 名称、耗时或本地重新分词的消息副本估算 Usage。Adapter MAY 仅从原生最近一次请求的 cache/input Token 字段计算 `cacheHitRatePercent`。Adapter MUST NOT 发布 `sessionCacheHitRatePercent`、`timeToFirstOutputMs` 或 `costSource: publicPrice`；这些字段以及发布了 `usage.request` 的 Thread 的 `totalCostUsd`、`outputTokensPerSecond` 由 Host Usage 计量产生。

#### Scenario: Native Harness 报告完整上下文用量

- **WHEN** 具体 Adapter 从 Native Session 获得可靠的当前上下文已用 Token 数，以及与之匹配的活动 Model 上下文窗口大小
- **THEN** Adapter MUST 在同一个 `HostUsage` 快照中发布两个规范化上下文字段
- **AND** Adapter MUST 保留其他每个可靠的原生 Token、成本或套餐窗口字段，且不得暴露原生 payload

#### Scenario: Native Harness 缺少某个指标

- **WHEN** Native Session 没有可靠报告缓存 Token、Token 明细、套餐窗口或上下文窗口用量
- **THEN** Adapter MUST 省略该指标，而不是发布零值或无依据推导值

#### Scenario: 原生最近一次请求足以计算缓存命中率

- **WHEN** Adapter 从原生最近一次请求获得 input、cache write 和 cache read Token，且三者之和大于零
- **THEN** Adapter MAY 发布 `cacheHitRatePercent` 为 cache read 占该和的百分比
- **AND** Adapter MUST NOT 从 Host Transcript 或 Model 名称计算该百分比

#### Scenario: 原生请求支持活动 Turn 费用估算

- **WHEN** Adapter 获得请求级结构化 Token Usage、稳定请求身份和实际 Model 归属
- **THEN** Adapter SHOULD 以 `usage.request` 发布该请求，由 Host 计算费用
- **AND** Adapter MUST NOT 使用当前 UI Model、Host Transcript 文本或 Tool 参数替代实际请求归属

#### Scenario: 原生累计事实到达

- **WHEN** Native Harness 在 Turn terminal 提供可靠的 Session 累计 Token
- **THEN** Adapter MAY 使用该事实更新 `HostUsage` 中的累计 Token 字段
- **AND** Adapter MUST NOT 为已发布的请求再次发布不同 `requestId` 的请求记录

#### Scenario: 原生 Telemetry 格式错误

- **WHEN** Telemetry Response 包含负数、非有限值、非数值、单独出现的套餐 reset、或不完整的上下文窗口值
- **THEN** Adapter MUST 将该次观测拒绝为不可用
- **AND** Adapter MUST NOT 发布部分有效的上下文窗口字段对

### Requirement: Host 必须拥有外部 Thread 的最新 Usage 快照

External Thread Runtime MUST 消费每个已注册 `HarnessSession` 的初始 Usage、`session.usage.changed`、`usage.request` 与 `usage.history`，为每个已加载外部 Thread 最多保留一份最新快照和一份内存 Usage 计量状态，并且不得检查原生 Harness 字段。Host MAY route a fixed explicit Usage refresh request to the currently owning HarnessSession, but MUST NOT merge one Session's refresh or metering state into another. Session 替换、Thread 删除和 Host shutdown MUST 丢弃该内存快照与计量状态。Mapping Store MUST NOT 持久化 Usage、cost、context history、请求记录、计量状态、刷新缓存或规范化 Usage timeline。

#### Scenario: 两个 Harness 发布 Usage

- **WHEN** 两个已注册 Fake Harness 为两个外部 Thread 发布不同的规范化 Usage 快照和请求记录
- **THEN** Host MUST 将每份快照和计量结果绑定到其所属 Thread 和 Session
- **AND** 任一路径 MUST NOT 包含特定 Harness 分支

#### Scenario: Host 路由显式 Usage 刷新

- **WHEN** Renderer 对一个已加载 External Thread 请求显式 Usage 刷新
- **THEN** Host MUST 只调用当前拥有该 Thread 的 HarnessSession 可选刷新操作
- **AND** Host MUST NOT 广播到同 Adapter 的其它 Session

#### Scenario: 过期 Session 在替换后产生输出

- **WHEN** External Thread Runtime 已替换旧 HarnessSession，而旧 Session 随后发出或完成 Telemetry 或请求记录
- **THEN** Host MUST 忽略该过期 Session 的值
- **AND** Host MUST 保留替换后 Session 的最新 Usage 与计量状态

#### Scenario: Host 重启

- **WHEN** Host 重启并从 Mapping Store 恢复外部 Thread
- **THEN** Host MUST 只从恢复后的 HarnessSession 发布的初始 Usage、Usage 快照、请求记录和历史回放重建计量
- **AND** Host MUST NOT 根据已持久化的 Turn mappings、Transcript projections、费用字段或 Context cache 重建 Usage

## ADDED Requirements

### Requirement: Adapter MAY 以统一口径发布请求级 Usage 记录

Harness 输出流 MUST 支持可选事件 `usage.request`，表示一次原生模型请求（或合计型 Harness 的一次合计增量）的 Token 用量。记录 MUST 携带在原生会话内稳定的 `requestId`、`inputTokens`、`outputTokens`，MAY 携带 `historical`、原生实际模型 `model`、标准服务商 `provider`、`cachedInputTokens`、`cacheWriteInputTokens`、`reasoningOutputTokens`，以及 Adapter 将本请求的原生输出事件与其完成事件关联后测得的 `outputStartedAtMs`、`completedAtMs`；所有 Token 值 MUST 是非负安全整数。Adapter 已知某项缓存为零时 MUST 显式发布 `0`；缓存字段缺失表示该项未知。口径 MUST 统一为：`inputTokens` 包含未命中缓存、缓存读与缓存写，`outputTokens` 包含思考；因此 `cachedInputTokens + cacheWriteInputTokens` MUST NOT 超过 `inputTokens`，`reasoningOutputTokens` MUST NOT 超过 `outputTokens`。Adapter MUST 将原生口径换算为该口径，MUST NOT 使用 UI 模型别名或 `HarnessModelRef` 编码作为 `model`，MUST NOT 把用户自定义服务商别名作为 `provider`。子代理产生的原生请求 MUST NOT 作为父会话的请求记录发布。原生未给出实际模型的后台请求（如标题生成、上下文压缩）MUST NOT 发布为请求记录，且不视为用量缺口；原生失败请求未给出 Token 时视为没有用量。

#### Scenario: 原生输入不含缓存

- **WHEN** 原生请求用量的 input 不包含 cache read 与 cache write
- **THEN** Adapter MUST 将 cache read 与 cache write 加回 `inputTokens` 后发布

#### Scenario: 原生输出不含思考

- **WHEN** 原生请求用量单列 reasoning 且 output 不包含它
- **THEN** Adapter MUST 将 reasoning 加入 `outputTokens`，并发布 `reasoningOutputTokens`

#### Scenario: 合计增量无法证明模型归属

- **WHEN** Adapter 只能从 Session 合计得到增量，且不能证明增量全部属于同一实际模型
- **THEN** Adapter MAY 发布不带 `model` 的增量记录
- **AND** 合计回退或无法确定增量时 Adapter MUST NOT 发布记录

#### Scenario: 请求计时无法关联

- **WHEN** Adapter 不能把本请求的输出事件与其完成事件可靠关联
- **THEN** Adapter MUST 省略 `outputStartedAtMs` 与 `completedAtMs`

### Requirement: Adapter 必须声明本会话历史回放是否完整

发布 `usage.request` 的 Adapter 在每次打开会话时 MUST 先以 `historical: true` 回放该原生会话历史中的全部请求（包括分叉复制而来的请求与所有分支上的请求），再发布 `usage.history { complete }`。Adapter MUST NOT 为分叉或撤销做特殊排除。`complete` MUST 仅在 Adapter 完整读取原生历史且每条请求都已发布时为 `true`；历史读取失败或缺失请求用量时 MUST 为 `false`。会话运行中 Adapter 发现某次原生请求的用量缺失或无法换算时，MUST 再次发布 `usage.history { complete: false }`。

#### Scenario: 恢复分叉或撤销产生的会话

- **WHEN** Adapter 恢复一个原生历史包含复制自父会话消息的会话
- **THEN** Adapter MUST 按原生历史回放其中全部请求
- **AND** 撤销上一轮后被移除的请求 MUST NOT 回放

#### Scenario: 运行中出现用量缺口

- **WHEN** 已发布 `complete: true` 的会话中，某次原生请求的用量缺失或无法换算
- **THEN** Adapter MUST 发布 `usage.history { complete: false }`

#### Scenario: 新建会话

- **WHEN** Adapter 以 create 打开会话且尚无原生历史
- **THEN** Adapter MUST 发布 `usage.history { complete: true }` 且不回放任何请求

### Requirement: Host 必须统一计算派生 Usage 指标

Host MUST 按 `requestId` 在 Thread 内去重请求记录，并用请求记录、价格表和 Host 观测时间计算派生指标，写入该 Thread 的最新 `HostUsage`。Thread 在当前 Session 收到首个 `usage.history` 起进入计量模式；计量模式下 Host MUST 忽略 `session.usage.changed` 中的原生 `totalCostUsd`。最近一次 `usage.history` 为 `complete: false`，或任一请求记录校验失败时，Host MUST 视为历史不完整，直到 Session 替换。Host MUST NOT 覆盖 Adapter 上报的 Token 累计、上下文、套餐、积分或 `cacheHitRatePercent` 字段，MUST NOT 根据 Transcript 文本长度推导 Token。计量失败 MUST 只影响派生字段。

#### Scenario: 历史完整时发布会话级指标

- **WHEN** Thread 已收到 `usage.history { complete: true }`
- **THEN** Host MAY 发布 `totalCostUsd`（`costSource: publicPrice`）与 `sessionCacheHitRatePercent`
- **AND** 在收到之前、最近一次为 `complete: false` 或有请求记录校验失败时 Host MUST NOT 发布这两个字段

#### Scenario: 重复请求记录

- **WHEN** 同一 `requestId` 先作为历史回放、后作为实时事件到达
- **THEN** Host MUST 只计入一次

#### Scenario: 按请求模型计费

- **WHEN** 同一 Thread 先后收到两个不同模型的请求记录
- **THEN** Host MUST 分别按各自模型单价计费并累加：未命中输入按输入单价，缓存读、缓存写按各自单价，输出按输出单价

#### Scenario: 无法计费

- **WHEN** 任一请求记录缺少 `model` 或缓存读/写字段、模型在价格表与用户覆盖中没有精确匹配，或含缓存读/写 Token 但缺少对应单价
- **THEN** Host MUST 省略 `totalCostUsd` 与 `costSource`，并继续发布其他派生指标

#### Scenario: 价格表更新

- **WHEN** 价格表刷新或用户覆盖文件变化
- **THEN** Host MUST 在下次发布时用当前价格表对全部请求记录重新计算费用

#### Scenario: 会话平均缓存命中率

- **WHEN** 历史完整、每条请求记录都带 `cachedInputTokens`，且累计 `inputTokens` 大于零
- **THEN** Host MUST 发布 `sessionCacheHitRatePercent` = 累计 `cachedInputTokens` ÷ 累计 `inputTokens` × 100
- **AND** 任一记录缺少 `cachedInputTokens` 时 Host MUST 省略该字段，而不是按零计算

#### Scenario: 首字延迟与回合速度

- **WHEN** 一个实时 Turn 收到推理或正文输出事件和带计时的请求记录
- **THEN** Host MUST 以 Turn 开始到首个推理或正文输出事件的 Host 观测时长发布 `timeToFirstOutputMs`
- **AND** Turn 结束时 Host MUST 以 Σ 输出 Token ÷ Σ (`completedAtMs` − `outputStartedAtMs`) 发布 `outputTokensPerSecond`，只计入本 Turn 内同时带两个时间且时长大于零的实时记录
- **AND** 历史记录、缺少计时、时长为零或在 Turn 结束后才到达的记录 MUST NOT 参与速度，但仍计入费用；没有可计入记录时 Host MUST NOT 发布速度

#### Scenario: 未接入的 Adapter

- **WHEN** Thread 的当前 Session 未发布过 `usage.history`，且 Adapter 上报了原生 `totalCostUsd`
- **THEN** Host MUST 保留该费用并标记 `costSource: native`

#### Scenario: 已接入但历史不完整

- **WHEN** Session 发布了 `usage.history { complete: false }` 且尚无任何请求记录，随后 `session.usage.changed` 携带原生 `totalCostUsd`
- **THEN** Host MUST NOT 发布该原生费用

### Requirement: Host 必须维护可刷新、可覆盖的价格表

Host MUST 随版本携带价格表快照，包含每百万 Token 的输入、输出、缓存读、缓存写单价（缺失项保持缺失）。Host 启动时若本地价格表超过 7 天 MUST 在后台请求一次最新数据，校验通过后原子替换，失败时 MUST 静默沿用现有价格表且不得阻塞启动或会话。用户数据目录中的价格覆盖文件 MUST 优先于默认价格；文件无效时 Host MUST 忽略整个文件并记录诊断。查找 MUST 只做精确匹配：有标准 `provider` 时先匹配服务商与模型，再匹配模型 ID；同一模型 ID 对应多个服务商价格且无法确定官方服务商时 MUST 视为未匹配。

#### Scenario: 离线启动

- **WHEN** Host 启动时无法访问价格数据源
- **THEN** Host MUST 使用本地或打包的价格表继续工作，且不向用户报错

#### Scenario: 用户覆盖价格

- **WHEN** 覆盖文件为某模型提供了单价
- **THEN** Host MUST 使用该单价计算该模型的费用
