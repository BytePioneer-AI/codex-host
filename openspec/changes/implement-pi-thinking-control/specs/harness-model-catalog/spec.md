## MODIFIED Requirements

### Requirement: Harness 检查返回规范化 Model Catalog，且不创建 Session
`HarnessAdapter` SHALL 提供无副作用的配置检查，返回浏览器安全的规范化 Model、当前 Model 的 Thinking 选项，以及结构化的 Model/Thinking 选择能力；不得暴露原生协议对象或创建持久化 Native Session。检查 MAY 接收不透明的目标 Model Ref，并 SHALL 查询该 Model，但不得改变用户的原生默认配置。

#### Scenario: Pi 检查成功
- **WHEN** 调用方使用可选 cwd 和可选目标 Model Ref 检查 Pi
- **THEN** Adapter 返回 ready 状态、确定性的 Model Catalog、被检查的原生 Model 作为默认 Ref、其实际 Thinking 选项和生效的默认选项，以及真实的结构化选择能力
- **AND** 检查完成前 SHALL 关闭所有临时 Pi 进程

#### Scenario: 无法启动 Pi 检查
- **WHEN** Pi 未安装、无法启动或返回无效 Catalog
- **THEN** 检查返回明确的规范化 unavailable 或 error 结果
- **AND** 不得遗留 Native Session、后台进程或用户配置变更

#### Scenario: 原生 Catalog 含私有字段
- **WHEN** Pi Model 对象包含 base URL、价格、认证数据、绝对路径、自定义配置或未知字段
- **THEN** 这些值不得进入 Harness Catalog、Host 响应、Renderer 状态、日志或已提交的 fixture

#### Scenario: 已安装 Harness 缺少 Thinking RPC 控制
- **WHEN** 原生 Harness 明确报告 Thinking discovery 是未知命令
- **THEN** 检查对于 Model 选择仍保持 ready，但不返回 Thinking 选项，并将 `configuration.selectThinkingOption` 设为 `false`
- **AND** Adapter 不得根据版本号、Provider 或 Model 名称推断支持情况

### Requirement: Session 生效 Model 使用有序状态流
Harness Session SHALL 在完整 Session 状态中暴露结构化的 Model 和 Thinking 选择能力，以及可选的 `effectiveModel`、`effectiveThinkingOptionId` 和当前可用 Thinking 选项。`open()` 完成后，生效配置的变更 SHALL 仅通过有序的 `session.state.changed` 事件发布。

#### Scenario: 第一个 Pi Turn 使用请求配置
- **WHEN** 使用 Model Ref 和 Thinking 选项打开的惰性 Pi Session 收到第一个已接受的 Turn
- **THEN** PiAdapter 启动 Pi，应用请求的原生配置，读取原生状态和当前选项，并在 `turn.started` 之前发出一个完整且已确认的配置状态

#### Scenario: 观察命令结果
- **WHEN** `model.select` 或 `thinking.select` 成功
- **THEN** 其结果只报告 `{completed: true}`
- **AND** 调用方从结果完成前入队的完整状态事件中推导生效 Model、Thinking 和当前选项

### Requirement: Model 选择必须串行且仅限 Idle
Session SHALL 仅在 open 且 Idle 时接受 `model.select` 和 `thinking.select`， SHALL 将两个命令与 Turn 接受及其他配置写入串行化，并 SHALL 始终保持唯一的实际生效状态。

#### Scenario: Idle Pi Session 选择其他 Model
- **WHEN** 已启动且空闲的 Pi Session 收到有效的不同 Model Ref
- **THEN** PiAdapter 调用原生 Model setter，读取原生状态和 Thinking 选项，发出包含任何 Thinking 修正的完整状态，然后完成命令

#### Scenario: Idle Pi Session 选择 Thinking
- **WHEN** 已启动且空闲的 Pi Session 收到规范化的 Thinking 选项 ID
- **THEN** PiAdapter 调用原生 Thinking setter，读取原生状态和当前选项，发出一个完整的实际状态，然后完成命令

#### Scenario: 选择与活动 Turn 竞争
- **WHEN** 在 Turn 正在接受、执行、取消或收敛时请求任一配置命令
- **THEN** Session SHALL 以 `sessionBusy` 或 `invalidState` 拒绝
- **AND** 不得发生原生配置写入

#### Scenario: Turn 与选择竞争
- **WHEN** Model 或 Thinking 选择尚未完成时请求 `turn.start`
- **THEN** Session SHALL 以 busy 拒绝 Turn，或仅在选择完全完成后接受
- **AND** 配置写入与 Agent Loop 不得重叠

#### Scenario: 原生 Thinking 回读不同于请求
- **WHEN** Pi 接受 Thinking 写入，但 `get_state` 报告了修正后的生效选项
- **THEN** PiAdapter SHALL 发布并返回实际选项，不得将请求值保留为状态

#### Scenario: 原生 Model 回读不同于请求
- **WHEN** Pi 接受 Model 写入，但 `get_state` 报告了不同的实际 Model
- **THEN** PiAdapter SHALL 发布实际完整状态，并返回明确失败，不得声称请求的 Model 已生效

#### Scenario: 无法确定原生写入结果
- **WHEN** 配置写入可能已经发生且无法可靠读取 Pi 状态
- **THEN** PiAdapter SHALL 使 Session 进入 fault，并拒绝后续写入或 Turn

### Requirement: Host 仅暴露固定的 Model 控制操作
Host Runtime SHALL 处理固定的 codexhost 检查、Thread Model 选择和 Thread Thinking 选择方法， SHALL 对其参数和结果执行运行时校验，并 SHALL 不暴露通用 Harness 或原生 RPC 逃逸口。

#### Scenario: Renderer 读取草稿 Catalog
- **WHEN** Renderer 为已注册 Harness 及可选目标 Model 发送 `codexhost/harness/inspect`
- **THEN** Host 调用 `HarnessAdapter.inspect`，并在不打开 Thread Session 的情况下返回规范化检查结果

#### Scenario: Renderer 选择已有 Thread 的 Model
- **WHEN** Renderer 在 Session Idle 时，使用当前进程的 external Thread ID 和有效 Model Ref 发送 `codexhost/thread/model/select`
- **THEN** Host 执行 `model.select`，等待有序完整状态事件被消费，并返回观察到的配置状态

#### Scenario: Renderer 选择已有 Thread 的 Thinking
- **WHEN** Renderer 在 Session Idle 时，使用当前进程的 external Thread ID 和规范化选项 ID 发送 `codexhost/thread/thinking/select`
- **THEN** Host 执行 `thinking.select`，等待有序完整状态事件被消费，并返回观察到的配置状态

#### Scenario: 控制引用 Codex 或未知 Thread
- **WHEN** codexhost 配置控制方法引用了不属于当前 Host external route 的 Thread
- **THEN** Host 返回明确错误，不得将自定义方法转发给官方 Codex app-server

#### Scenario: 官方请求无关
- **WHEN** Codex 所有或未知的官方 app-server 请求未使用 codexhost 控制方法或 external resource
- **THEN** Host 保持原有的透明转发路径

### Requirement: 草稿 Model 选择绑定到精确的 Pi 创建
Renderer SHALL 将选中的 Pi Model 和 Thinking 值绑定到与 Pi Agent 选择相同的逻辑 Composer 和原生创建状态，不得使用进程级或窗口级 pending 值。

#### Scenario: 草稿选择 Pi 配置并提交
- **WHEN** Pi 草稿选择 Model 和 Thinking 选项并提交
- **THEN** 其 `thread/start.model` 携带一个包含两个不透明值的有界内部 Pi transport carrier
- **AND** Host 仅使用所选配置打开该 Pi Thread

#### Scenario: Pi 草稿使用原生默认值
- **WHEN** Pi 草稿未显式配置就提交
- **THEN** 通用的 `codexhost/pi-native` carrier 继续路由 Pi，Pi Native Mode 保持当前原生配置

#### Scenario: 两个 Composer 草稿选择不同配置
- **WHEN** 两个逻辑 Composer 选择不同的 Pi Model 或 Thinking 值
- **THEN** 每次创建只携带自身的一对值，任何请求都不得消费另一个 Composer 的状态

### Requirement: Renderer 显示与 Agent 分离的 Pi Model 控件
对于受支持的 Desktop 构建，Renderer SHALL 显示一个由 codexhost 拥有、独立于 Agent 控件的 Pi Model/Thinking 配置控件，并 SHALL 只显示规范化标签、当前选项和已确认的选择状态。

#### Scenario: 用户选择 Pi
- **WHEN** Composer 将 Agent 改为 Pi 且检查成功
- **THEN** 组合控件使用 Codex 原生组合选择器的信息架构显示已检查的 Pi Model 及其实际 Thinking 选项
- **AND** 永不显示内部 transport carrier 作为 Model 或 Thinking 值

#### Scenario: 当前 Model 不支持可选 Thinking
- **WHEN** 检查到的 Thinking 选项只有 `off`，或结构化能力为 false
- **THEN** Renderer 隐藏 Thinking 区域和触发器后缀，不得宣传不可用级别

#### Scenario: 用户保留 Codex
- **WHEN** Composer 的 Agent 为 Codex
- **THEN** codexhost 不得向官方 Codex Model picker 注入 Pi 条目，也不得修改用户的 Codex Model 配置

#### Scenario: Model 变更修正 Thinking
- **WHEN** 所选 Model 产生不同的生效 Thinking 选项或可用选项集
- **THEN** Renderer 原子地替换显示的两个值为 Adapter 或 Host 确认的状态

#### Scenario: Catalog 请求过期
- **WHEN** 先前的检查或选择在 Composer 改变 Agent、目标、请求代数或已销毁后完成
- **THEN** 忽略过期响应，不得覆盖当前控件

#### Scenario: 已有选择失败
- **WHEN** 对已有 Pi Thread 的即时原生 Model 或 Thinking 选择失败
- **THEN** 保留之前确认的一对值，并显示明确错误状态

#### Scenario: Renderer 所有权不明确
- **WHEN** 无法唯一校验受支持的请求管理器、Composer Model atom 或 conversation Thread 身份
- **THEN** 禁用 Pi 配置发现或选择，不得使用通用请求或猜测的身份回退

### Requirement: 明确当前进程范围
Renderer 草稿配置状态 SHALL 处于当前进程和 Composer 作用域内；重新打开的 Native Session SHALL 从所属 Harness 恢复实际生效的 Model 和 Thinking 状态，而非缓存的 UI 值。

#### Scenario: 同进程 Composer 替换或重新访问
- **WHEN** 同进程中等价逻辑 Pi Composer 被替换或重新访问
- **THEN** 使用现有 Composer 状态恢复其已确认的 Pi Model Ref 和 Thinking 选项

#### Scenario: 打开新的默认 Composer
- **WHEN** conversation Composer 被新的默认 Composer 替换
- **THEN** 新 Composer 不得继承之前的 Pi Model Ref 或 Thinking 选项

#### Scenario: 应用重启
- **WHEN** Renderer 进程状态丢失并重新打开持久化的 Pi Thread
- **THEN** Renderer 使用由恢复的 Pi Session 实际状态支持的 Thread 检查
- **AND** 不得从过期 carrier 或缓存 UI 数据推断当前配置
