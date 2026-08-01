## MODIFIED Requirements

### Requirement: Harness 检查返回规范化 Model Catalog，且不创建 Session
`HarnessAdapter` SHALL 提供无副作用的配置检查，返回浏览器安全的规范化 Model、Draft Thinking 请求选项和结构化 Model/Thinking 选择能力；不得暴露原生协议对象或创建持久化 Native Session。检查只接收可选 cwd 和 refresh，不得为目标 Model 启动第二个检查进程。

#### Scenario: Pi 检查成功
- **WHEN** 调用方使用可选 cwd 检查 Pi
- **THEN** Adapter 启动一个临时 Pi 进程，返回 ready 状态、确定性的完整 Model Catalog、当前原生 Model 作为默认 Ref，以及 reasoning Model 的统一 Thinking 请求档位
- **AND** 非 reasoning Model 只关联 `off`
- **AND** 检查完成前关闭临时 Pi 进程

#### Scenario: 同 cwd 重复检查
- **WHEN** 同一 PiAdapter 对同一 cwd 完成一次 ready 检查后再次普通检查
- **THEN** Adapter 返回进程内缓存 Catalog，不得再次启动 Pi
- **AND** 同cwd并发检查共享一个in-flight请求，`refresh:true`显式重建缓存

#### Scenario: 无法启动 Pi 检查
- **WHEN** Pi 未安装、无法启动或返回无效 Catalog
- **THEN** 检查返回明确的规范化 unavailable 或 error 结果且不缓存失败
- **AND** 不得遗留 Native Session、后台进程或用户配置变更

#### Scenario: 原生 Catalog 含私有字段
- **WHEN** Pi Model 对象包含 base URL、价格、认证数据、绝对路径、`thinkingLevelMap`、自定义配置或未知字段
- **THEN** 这些值不得进入 Harness Catalog、Host 响应、Renderer 状态、日志或已提交 fixture

#### Scenario: Model reasoning 元数据无效
- **WHEN** Pi Model 缺少布尔 `reasoning` 或同一原生身份的重复项声明冲突值
- **THEN** Adapter 返回协议错误，不得猜测该 Model 的 Thinking 菜单

#### Scenario: 已安装 Harness 缺少 Thinking RPC 控制
- **WHEN** 原生 Harness 明确报告 Thinking discovery 是未知命令
- **THEN** 检查对于 Model 选择仍保持 ready，但返回空 Thinking Catalog，并将 `configuration.selectThinkingOption` 设为 `false`

### Requirement: Session 生效 Model 使用有序状态流
Harness Session SHALL 在完整 Session 状态中暴露结构化 Model 和 Thinking 选择能力，以及可选的 `effectiveModel`、`effectiveThinkingOptionId` 和当前可用 Thinking 选项。`open()` 完成后，生效配置的变更 SHALL 仅通过有序的 `session.state.changed` 事件发布。

#### Scenario: 第一个 Pi Turn 使用请求配置
- **WHEN** 使用 Model Ref 和 Thinking 请求打开的惰性 Pi Session 收到第一个已接受 Turn
- **THEN** PiAdapter 启动 Pi，将请求值交给 Pi，并在 `turn.started` 之前发布 Pi Session 报告的完整实际状态
- **AND** codexhost 不得计算请求档位的替代值

#### Scenario: 观察命令结果
- **WHEN** `model.select` 或 `thinking.select` 成功
- **THEN** 其结果只报告 `{completed: true}`
- **AND** 调用方从结果完成前入队的完整状态事件中读取 Pi Session 实际 Model 和 Thinking

### Requirement: Model 选择必须串行且仅限 Idle
Session SHALL 仅在 open 且 Idle 时接受 `model.select` 和 `thinking.select`，SHALL 将两个命令与 Turn 接受及其他配置写入串行化，并 SHALL 始终保持唯一的实际 Session 状态。

#### Scenario: Idle Pi Session 选择其他 Model
- **WHEN** 已启动且空闲的 Pi Session 收到有效的不同 Model Ref
- **THEN** PiAdapter 调用原生 Model setter，读取原生状态，发出包含 Pi Thinking 副作用的完整状态，然后完成命令

#### Scenario: Idle Pi Session 选择 Thinking
- **WHEN** 已启动且空闲的 Pi Session 收到规范化 Thinking 请求 ID
- **THEN** PiAdapter 将该请求原样交给 Pi，读取 Pi 状态，发出完整实际状态，然后完成命令
- **AND** Pi 可以报告不同于请求的实际档位

#### Scenario: 选择与活动 Turn 竞争
- **WHEN** 在 Turn 正在接受、执行、取消或收敛时请求任一配置命令
- **THEN** Session SHALL 以 `sessionBusy` 或 `invalidState` 拒绝
- **AND** 不得发生原生配置写入

#### Scenario: Turn 与选择竞争
- **WHEN** Model 或 Thinking 选择尚未完成时请求 `turn.start`
- **THEN** Session SHALL 以 busy 拒绝 Turn，或仅在选择完全完成后接受
- **AND** 配置写入与 Agent Loop 不得重叠

#### Scenario: 原生 Model 回读不同于请求
- **WHEN** Pi 接受 Model 写入，但状态报告了不同的实际 Model
- **THEN** PiAdapter SHALL 发布实际完整状态并返回明确失败，不得声称请求 Model 已生效

#### Scenario: 无法确定原生写入结果
- **WHEN** 配置写入可能已经发生且无法可靠读取 Pi 状态
- **THEN** PiAdapter SHALL 使 Session 进入 fault，并拒绝后续写入或 Turn

### Requirement: Host 仅暴露固定的 Model 控制操作
Host Runtime SHALL 处理固定的 codexhost 检查、Thread Model 选择和 Thread Thinking 选择方法，SHALL 对其参数和结果执行运行时校验，并 SHALL 不暴露通用 Harness 或原生 RPC 逃逸口。

#### Scenario: Renderer 读取草稿 Catalog
- **WHEN** Renderer 为已注册 Harness 发送 `codexhost/harness/inspect`
- **THEN** Host 调用一次 `HarnessAdapter.inspect`，并在不打开 Thread Session 的情况下返回规范化检查结果

#### Scenario: Renderer 选择已有 Thread 的 Model
- **WHEN** Renderer 在 Session Idle 时发送固定 Thread Model 选择请求
- **THEN** Host 执行 `model.select`，等待有序状态事件被消费，并返回观察到的配置状态

#### Scenario: Renderer 选择已有 Thread 的 Thinking
- **WHEN** Renderer 在 Session Idle 时发送固定 Thread Thinking 选择请求
- **THEN** Host 执行 `thinking.select`，等待有序状态事件被消费，并返回观察到的配置状态

#### Scenario: 官方请求无关
- **WHEN** Codex 所有或未知的官方 app-server 请求未使用 codexhost 控制方法或 external resource
- **THEN** Host 保持透明转发路径

### Requirement: 草稿 Model 选择绑定到精确的 Pi 创建
Renderer SHALL 将选中的 Pi Model 和 Thinking 请求绑定到与 Pi Agent 选择相同的逻辑 Composer 和原生创建状态，不得使用进程级或窗口级 pending 值。

#### Scenario: 草稿选择 Pi 配置并提交
- **WHEN** Pi 草稿从内存 Catalog 选择 Model 和 Thinking 请求并提交
- **THEN** `thread/start.model` 携带包含两个不透明值的有界内部 Pi carrier
- **AND** Host 只使用该请求打开 Pi Thread

#### Scenario: Pi 草稿使用原生默认值
- **WHEN** Pi 草稿未显式配置就提交
- **THEN** 通用 `codexhost/pi-native` carrier 继续路由 Pi，Pi Native Mode 保持当前原生配置

#### Scenario: 两个 Composer 草稿选择不同配置
- **WHEN** 两个逻辑 Composer 选择不同 Pi Model 或 Thinking 请求
- **THEN** 每次创建只携带自身值，任何请求不得消费另一个 Composer 的状态

### Requirement: Renderer 显示与 Agent 分离的 Pi Model 控件
对于受支持的 Desktop 构建，Renderer SHALL 显示一个由 codexhost 拥有、独立于 Agent 控件的 Pi Model/Thinking 配置控件。

#### Scenario: 用户选择 Pi
- **WHEN** Composer 将 Agent 改为 Pi 且初始检查成功
- **THEN** 组合控件显示一次加载的 Pi Model Catalog 和 Adapter 提供的统一 Thinking 请求选项
- **AND** 永不显示内部 carrier

#### Scenario: Draft 选择其他 Model
- **WHEN** 用户在 Pi Draft 中选择 Catalog 内另一个 Model
- **THEN** Renderer SHALL 同步从内存 Catalog 解析该 Model 的 Thinking 请求列表并更新 carrier
- **AND** 不得发送目标 Harness inspection
- **AND** 配置控件在 official prewarm clear 完成前保持 selecting，失败时恢复旧 carrier 和控件状态

#### Scenario: 当前 Model 为非 reasoning
- **WHEN** 所选 Model 的静态列表只有 `off`
- **THEN** Renderer 隐藏 Thinking 区域和触发器后缀

#### Scenario: Model 支持关系缺失
- **WHEN** Catalog Model 缺少 `supportedThinkingOptionIds`
- **THEN** Renderer 不显示 Thinking 选项，不得回退到 Catalog 全部选项

#### Scenario: 已有选择失败
- **WHEN** 对已有 Pi Thread 的即时原生 Model 或 Thinking 选择失败
- **THEN** 保留之前状态并显示明确错误

### Requirement: 明确当前进程范围
Renderer Draft Catalog 和请求状态 SHALL 处于当前进程及 Composer 作用域内；重新打开的 Native Session SHALL 从所属 Harness 恢复实际 Model 和 Thinking 状态。

#### Scenario: 同进程 Composer 替换或重新访问
- **WHEN** 同进程中等价逻辑 Pi Composer 被替换或重新访问
- **THEN** 恢复其 Pi Model Ref、Thinking 请求和内存控件状态

#### Scenario: 打开新的默认 Composer
- **WHEN** conversation Composer 被新的默认 Composer 替换
- **THEN** 新 Composer 不得继承之前的 Pi Model 或 Thinking 请求

#### Scenario: 应用重启
- **WHEN** Renderer 进程状态丢失并重新打开持久化 Pi Thread
- **THEN** Renderer 使用恢复的 Pi Session 实际状态，不从过期 Draft Catalog 推断
