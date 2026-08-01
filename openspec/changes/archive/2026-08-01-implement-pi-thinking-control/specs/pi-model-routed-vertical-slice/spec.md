## MODIFIED Requirements

### Requirement: 选中的 Pi transport Model 保留 Harness 所有权
显式选择的 Pi 配置 carrier SHALL 与 `codexhost/pi-native` 一样路由到 Pi Harness，SHALL 只携带不透明的规范化 Model 和可选 Thinking 请求，且不得被视为 Codex Model、Pi Provider、Account、Billing Source、权限路由或上游 reasoning 参数。

#### Scenario: 新 Pi Thread 携带显式配置
- **WHEN** `thread/start.params.model` 包含有效的 Pi Model/Thinking carrier
- **THEN** Protocol Facade 在同一请求中解码 Pi Harness 所有权和不透明配置
- **AND** 使用这些请求打开 Pi Session，不得转发给官方 Codex

#### Scenario: 后续 Turn 携带选定 Pi 配置
- **WHEN** 已有 Pi Thread 的 `turn/start` 携带有效选定 Pi carrier
- **THEN** Host 在接受 Agent Loop 前通过所属 Pi Session 校验或应用不透明配置断言
- **AND** Thread Harness 所有权仍为 Pi

### Requirement: Pi Model 选择绝不回退到 Codex
Pi Model/Thinking Catalog、创建时应用和 Idle Session 选择 SHALL 只通过 PiAdapter 和 Pi 原生 RPC 行为执行。任何失败都 SHALL 保持为 Pi 错误，不得通过 Codex Harness 重试、检查或执行。

#### Scenario: 草稿选定配置在首次 Turn 时被 Pi 回退
- **WHEN** Pi 接受 carrier 中的 Thinking 请求并在内部选择不同实际档位
- **THEN** PiAdapter SHALL 使用 Pi Session 状态继续首 Turn，并在 `turn.started` 前发布实际状态
- **AND** codexhost 不得计算或发送自行推导的替代档位

#### Scenario: 草稿选定 Model 不可用
- **WHEN** Pi 拒绝或无法确认 carrier 中的 Model
- **THEN** 首 Turn SHALL 在接受前被拒绝或以明确 Pi 错误失败
- **AND** 官方 Codex Agent Loop 不得收到请求

#### Scenario: 已有 Session 的选择正忙
- **WHEN** Model 或 Thinking 选择目标是有活动 Turn 的 Pi Session
- **THEN** Host 返回规范化 busy 错误，并保持当前 Pi 配置和 Turn 不变

### Requirement: Pi Fork 保留源和当前文件
原生 Pi Fork/Clone SHALL 不改变源 Session 身份、源 Entry 树或 cwd 文件，派生 Pi Session SHALL 能独立继续，并在其上下文边界使 Model 和 Thinking 实际状态生效。

#### Scenario: 派生状态打开
- **WHEN** PiAdapter 完成 Fork 或 clone 启动
- **THEN** 初始 Session 状态 SHALL 包含 Pi Session 报告的 Model、Thinking 和当前可用 Thinking 选项

## ADDED Requirements

### Requirement: PiAdapter 为 Draft 提供统一 Thinking 请求 Catalog
PiAdapter SHALL 从 `get_available_models` 读取每个 Model 的布尔 `reasoning`，并在一次 inspection 中构造完整 Draft Catalog。reasoning Model SHALL 关联 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`；非 reasoning Model SHALL 只关联 `off`。这些值是 Pi 请求档位，不是远端 Provider 原生能力声明。

#### Scenario: reasoning Pi Model
- **WHEN** Pi Model Catalog 项报告 `reasoning=true`
- **THEN** PiAdapter 将统一七档关联到该 Model
- **AND** 不得为该 Model 启动额外目标 inspection

#### Scenario: 非 reasoning Pi Model
- **WHEN** Pi Model Catalog 项报告 `reasoning=false`
- **THEN** PiAdapter 只将 `off` 关联到该 Model
- **AND** Renderer 隐藏可选 Thinking UI

#### Scenario: reasoning 元数据缺失或冲突
- **WHEN** Model 缺少布尔 `reasoning`，或重复原生身份报告不同 reasoning 值
- **THEN** PiAdapter 返回协议错误，不得按 Model ID、Provider 名称或 allowlist 猜测

#### Scenario: Draft 请求 max 但 Pi 实际使用 high
- **WHEN** Draft carrier 请求 `max`，而 Pi 在创建 Native Session 时内部回退到 `high`
- **THEN** PiAdapter 不得在请求前实现自身 clamp
- **AND** Native Session 状态 SHALL 报告 Pi 的实际 `high`

### Requirement: Pi 拥有 Native Session Thinking 映射和状态
PiAdapter SHALL 只通过 `set_thinking_level` 提交 Native Session Thinking 请求，只从 `get_state.thinkingLevel` 读取实际档位，并不得构造 Provider `reasoning_effort`、thinking budget、`enable_thinking` 或其他上游参数。

#### Scenario: Existing Thread 选择 Thinking
- **WHEN** Existing Pi Thread 提交任意规范化统一档位
- **THEN** PiAdapter 将请求交给 Pi，并发布 Pi 状态报告的实际档位

#### Scenario: Model 切换改变实际 Thinking
- **WHEN** `set_model` 使 Pi 内部改变当前 Thinking
- **THEN** PiAdapter 在一个完整 Session 状态中发布 Pi 报告的 Model 和 Thinking

#### Scenario: Resume 或 Fork 打开
- **WHEN** PiAdapter 打开持久化或派生 Native Session
- **THEN** SHALL 从该精确 Session 初始化实际 Model 和 Thinking
- **AND** 不得使用 Draft Catalog 代替 Native Session 状态
