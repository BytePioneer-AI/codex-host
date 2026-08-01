## MODIFIED Requirements

### Requirement: 选中的 Pi transport Model 保留 Harness 所有权
显式选择的 Pi 配置 carrier SHALL 与 `codexhost/pi-native` 一样路由到 Pi Harness， SHALL 只携带不透明的规范化 Model 和可选 Thinking 值，且不得被视为 Codex Model、Pi Provider、Account、Billing Source、权限路由或上游 reasoning 参数。

#### Scenario: 新 Pi Thread 携带显式配置
- **WHEN** `thread/start.params.model` 包含有效的选定 Pi carrier
- **THEN** Protocol Facade 在同一请求中解码 Pi Harness 所有权和不透明配置
- **AND** 使用这些值打开 Pi Session，不得转发给官方 Codex

#### Scenario: 选定 carrier 格式错误
- **WHEN** `thread/start` Model 看似选定 Pi carrier，但包含缺失、过大、无效或含义不明确的组件
- **THEN** Protocol Facade 明确拒绝 Pi 创建，不得将其转发为官方 Codex Model

#### Scenario: 后续 Turn 携带选定 Pi 配置
- **WHEN** 已有 Pi Thread 的 `turn/start` 携带有效选定 Pi carrier
- **THEN** Host 在接受 Agent Loop 前，通过所属 Pi Session 校验或应用不透明的 Model 和 Thinking 断言
- **AND** 无论当前页面配置如何，Thread Harness 所有权仍为 Pi

### Requirement: Pi Model 选择绝不回退到 Codex
Pi Model/Thinking 检查、创建时应用和 Idle Session 选择 SHALL 只通过 PiAdapter 和 Pi 原生 RPC 行为执行。任何失败都 SHALL 保持为 Pi 错误，不得通过 Codex Harness 重试、检查或执行。

#### Scenario: 草稿选定的 Pi 配置在首次 Turn 时不可用
- **WHEN** Pi 拒绝或无法确认创建 carrier 中选定的配置
- **THEN** 第一个 Turn SHALL 在接受前被拒绝，或依据既定接受边界以明确 Pi 错误失败
- **AND** 官方 Codex Agent Loop 不得收到 Thread 创建或 Turn

#### Scenario: 已有 Session 的选择正忙
- **WHEN** Model 或 Thinking 选择目标是有活动 Turn 的 Pi Session
- **THEN** Host 返回规范化 busy 错误，并保持当前 Pi 配置和 Turn 不变

#### Scenario: Codex 请求仍走官方路径
- **WHEN** Codex 所有的 Thread 使用官方 Model 和 Reasoning 值
- **THEN** 请求继续透明地经过 stock app-server，且不检查或打开 PiAdapter

### Requirement: Pi Fork 保留源和当前文件
原生 Pi Fork/Clone SHALL 不改变源 Session 身份、源 Entry 树或 cwd 文件，派生的 Pi Session SHALL 能独立继续，并在其上下文边界使 Model、Thinking 和当前 Thinking 选项生效。

#### Scenario: 派生 Pi Session 继续运行
- **WHEN** Forked Session 中运行新的 Turn
- **THEN** 只能追加派生 Entry 树，源树保持不变

#### Scenario: 文件不同于历史 Turn
- **WHEN** 在选定 Turn 之后 cwd 文件发生变化
- **THEN** Pi Fork SHALL 保持这些当前文件不变

#### Scenario: 派生状态打开
- **WHEN** PiAdapter 完成 Fork 或 clone 启动
- **THEN** 初始 Session 状态 SHALL 包含原生回读的 Model、生效 Thinking 和当前可用 Thinking 选项

## ADDED Requirements

### Requirement: Pi RPC 是唯一的 Thinking 能力和状态权威
PiAdapter SHALL 通过 `get_available_thinking_levels` 发现当前 Thinking 选项，只从 `get_state.thinkingLevel` 读取生效 Thinking，并只通过 `set_thinking_level` 写入。不得从 Provider、Model ID、本地 allowlist、`reasoning: true` 或 codexhost 拥有的上游参数映射推断级别。

#### Scenario: 当前 Pi Model 支持子集
- **WHEN** Pi 报告 `off`、`low`、`medium` 和 `high` 等子集
- **THEN** PiAdapter SHALL 原样暴露当前 Model 的这些选项
- **AND** Renderer 不得添加 `minimal`、`xhigh`、`max` 或任何未报告选项

#### Scenario: 当前为非 reasoning Pi Model
- **WHEN** Pi 只报告 `off`
- **THEN** PiAdapter SHALL 保留实际的 `off` 状态，Renderer SHALL 隐藏可选 Thinking UI

#### Scenario: 不支持的请求选项被修正
- **WHEN** Pi 接受 `set_thinking_level`，但 `get_state` 返回不同的生效选项
- **THEN** PiAdapter SHALL 发布返回的生效选项和当前可用选项
- **AND** 请求的 UI 状态不得被持久化或显示为生效状态

#### Scenario: Model 切换改变 Thinking 支持
- **WHEN** `set_model` 改变可用 Thinking 选项或限制生效 Thinking
- **THEN** PiAdapter SHALL 在切换后同时读取状态和选项，并在一个完整的 Session 状态事件中发布

#### Scenario: Resume 或 Fork 打开
- **WHEN** PiAdapter 打开持久化或派生的 Native Session
- **THEN** SHALL 从该精确 Native Session 初始化生效 Thinking 和可用选项
- **AND** 不得使用源页面、Mapping Store 或进程全局 UI 状态
