## MODIFIED Requirements

### Requirement: Harness Usage 必须是规范化的原生事实快照

Harness Adapter 契约 MUST 定义 UI 无关的 `HostUsage` 快照，用于表达当前 Native Session 的累计 Token、成本、当前上下文窗口用量，以及可选的账号套餐窗口。每个已填充的数值字段 MUST 是有限非负数，每个 Token 字段和 Unix 时间字段 MUST 是安全整数，`contextWindowTokens` MUST 大于零，`contextWindowTokens` 和 `contextUsedTokens` MUST 同时存在或同时缺失，`planFiveHourResetsAtUnix` MUST 只与 `planFiveHourUsedPercent` 一起出现，`planSevenDayResetsAtUnix` MUST 只与 `planSevenDayUsedPercent` 一起出现，套餐 used percent MUST 落在 0 到 100，并且至少一个可靠字段 MUST 存在。Adapter MUST 省略未知字段。Adapter MUST NOT 根据 Host Transcript 文本、Tool 参数、Model 名称、耗时或本地重新分词的消息副本估算 Usage。Adapter MAY 仅从原生最近一次请求的 cache/input Token 字段计算 `cacheHitRatePercent`。

#### Scenario: Native Harness 报告完整上下文用量

- **WHEN** 具体 Adapter 从 Native Session 获得可靠的当前上下文已用 Token 数，以及与之匹配的活动 Model 上下文窗口大小
- **THEN** Adapter MUST 在同一个 `HostUsage` 快照中发布两个规范化上下文字段
- **AND** Adapter MUST 保留其他每个可靠的原生 Token、成本或套餐窗口字段，且不得暴露原生 payload

#### Scenario: Native Harness 缺少某个指标

- **WHEN** Native Session 没有可靠报告成本、缓存 Token、Token 明细、套餐窗口或上下文窗口用量
- **THEN** Adapter MUST 省略该指标，而不是发布零值或推导估算值

#### Scenario: 原生最近一次请求足以计算缓存命中率

- **WHEN** Adapter 从原生最近一次请求获得 input、cache write 和 cache read Token，且三者之和大于零
- **THEN** Adapter MAY 发布 `cacheHitRatePercent` 为 cache read 占该和的百分比
- **AND** Adapter MUST NOT 从 Host Transcript 或 Model 名称计算该百分比

#### Scenario: 原生 Telemetry 格式错误

- **WHEN** Telemetry Response 包含负数、非有限值、非数值、单独出现的套餐 reset、或不完整的上下文窗口值
- **THEN** Adapter MUST 将该次观测拒绝为不可用
- **AND** Adapter MUST NOT 发布部分有效的上下文窗口字段对

## ADDED Requirements

### Requirement: HostUsage MAY carry optional Claude.ai plan windows

`HostUsage` and the browser-safe Thread Usage snapshot MUST accept optional `planFiveHourUsedPercent`, `planFiveHourResetsAtUnix`, `planSevenDayUsedPercent`, and `planSevenDayResetsAtUnix`. These fields MUST NOT be projected into Codex `thread/tokenUsage/updated`. Host MUST pass them through the existing Thread Usage inspection snapshot when present. They MUST NOT be stored as Grok `accountCredits`.

#### Scenario: Inspection returns plan windows with Session Usage

- **WHEN** the current External Thread snapshot includes five-hour used percent and Session cost
- **THEN** the fixed Usage inspection response MUST include both fields in `usage`
- **AND** it MUST NOT copy the five-hour window into `accountCredits`

#### Scenario: Codex native circle ignores plan windows

- **WHEN** Host projects a snapshot that contains both a context pair and five-hour used percent
- **THEN** `thread/tokenUsage/updated` MUST still be constructed only from the context pair and any Session aggregate already defined for that carrier
- **AND** plan-window fields MUST remain inspection-only
