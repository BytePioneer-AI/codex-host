## MODIFIED Requirements

### Requirement: 版本化 Adapter 驱动原生创建 Model 状态
对于受支持的 Desktop 构建，Renderer Adapter SHALL 仅在 Composer 选择外部 Agent 时，同步将唯一关联 Composer 的 optimistic 原生 Model 状态更新为一个有界内部 transport carrier。通用 Pi carrier SHALL 为 `codexhost/pi-native`；显式选择的 Pi Model 和 Thinking 值 SHALL 以向后兼容的 carrier 表示，并保持内部属性而非用户可见值。

#### Scenario: 创建 Pi 对话
- **WHEN** 受支持的 Adapter 在原生创建前观察到没有显式 Pi 配置的唯一 Pi Composer
- **THEN** 原生 conversation `thread/start` 携带 `codexhost/pi-native` 作为内部 Model transport token

#### Scenario: 使用选定配置创建 Pi 对话
- **WHEN** 受支持的 Pi Composer 在原生创建前拥有已确认的有效 Pi Model Ref 和 Thinking 选项
- **THEN** 原生 conversation `thread/start` 携带绑定到该 Composer 的单个有界 Pi transport carrier
- **AND** 显示值保持为规范化标签，而非 carrier 组件

#### Scenario: 创建 Codex 对话
- **WHEN** Composer 选择 Codex
- **THEN** Adapter 恢复捕获的官方不透明状态，原生创建保留官方 Model 和 Reasoning 行为

#### Scenario: Renderer 不受支持或存在歧义
- **WHEN** asset、atom 对、Model 目标、安装时机或 Composer 关联不受支持或有歧义
- **THEN** 外部创建被明确的 unavailable 状态阻止，不得静默路由到 Codex

#### Scenario: 官方预热桥不可用
- **WHEN** 版本锁定的 Adapter 无法唯一恢复所属官方请求桥，或其签名不受支持
- **THEN** 草稿 Agent 切换不可用，不得向 Renderer Extension 暴露通用 Desktop 请求能力

#### Scenario: 配置请求管理器不可用
- **WHEN** Agent 路由仍受支持，但 Adapter 无法唯一恢复固定配置控件所需的活动请求管理器
- **THEN** Pi Model/Thinking 检查和即时选择不可用
- **AND** Adapter 不得暴露或调用通用请求方法

#### Scenario: transport 状态是临时的
- **WHEN** 选择 Pi 后挂载新的 Codex Composer
- **THEN** Adapter 恢复不透明的 Pi 前状态，不得调用官方持久化 Model setter，也不得将 Pi carrier 持久化为 Codex 默认值

### Requirement: Pi Model 状态遵循逻辑 Composer 生命周期
Renderer SHALL 将已确认的 Pi Model 和 Thinking 状态以及异步配置控件状态限定在用于 Agent 路由的同一逻辑 Composer 身份内，同时只允许通过经校验的当前进程 Thread 身份执行已有 Thread 的写入。

#### Scenario: 草稿替换保留配置
- **WHEN** Pi 草稿或锁定的新 Thread Composer 从不透明默认目标过渡到已创建 conversation 目标
- **THEN** 替换对象保留所选 Pi Model Ref、Thinking 选项和控件状态

#### Scenario: 同进程重新访问 conversation
- **WHEN** 同进程中重新访问等价的不透明 conversation 目标
- **THEN** Renderer 恢复已确认的 Pi 配置，不得持久化或记录 Thread 身份

#### Scenario: 新任务重置配置
- **WHEN** conversation 目标过渡到新的默认 Composer
- **THEN** 新 Composer 使用最近提交的 Agent，但不得继承先前 Composer 的 Pi Model 或 Thinking 值

#### Scenario: 选择已有 Pi Thread 的 Model
- **WHEN** 受支持的 conversation 目标提供一个经校验的当前进程 Host Thread ID，且用户选择不同的 Pi Model
- **THEN** Renderer 发送固定的 Thread Model 选择请求，并原子地应用 Host 状态观察返回的确认 Model、Thinking 和当前选项

#### Scenario: 选择已有 Pi Thread 的 Thinking
- **WHEN** 用户为 Idle 的当前进程 Pi Thread 选择可用 Thinking 选项
- **THEN** Renderer 发送固定的 Thread Thinking 选择请求，并只应用 Host 确认的生效状态

#### Scenario: 异步结果过期
- **WHEN** 较早的检查或选择在逻辑 Composer、Agent、目标或请求代数改变后完成
- **THEN** Renderer 忽略该结果并保留较新的确认状态

### Requirement: Forked Pi Model 使用 Host 确认状态
Thread 检查 SHALL 为精确的 Host Thread 返回有界 transport carrier，以及可选的生效 Harness Model、Thinking 选项和当前 Thinking 选项。Renderer SHALL 只将该确认状态应用到 forked conversation，并保持 Agent、Model 和 Thinking 语义分离。

#### Scenario: Pi Fork 继承较早配置
- **WHEN** 选定的 Checkpoint 早于源 Model 或 Thinking 的后续变更
- **THEN** forked Composer SHALL 显示并携带派生 Pi Session 报告的配置，而非源页面的最新值

## ADDED Requirements

### Requirement: Pi 配置控件匹配原生组合选择器
受支持的 Renderer SHALL 在独立 Agent 控件旁呈现一个 Pi 配置触发器，复用捕获的原生触发器 class 和 Codex 下拉菜单设计 token，并将 Thinking 选项置于主菜单、Model 选项置于嵌套子菜单。

#### Scenario: 组合触发器就绪
- **WHEN** Pi 检查返回一个选定 Model 和多于一个有意义的 Thinking 选项
- **THEN** 触发器 SHALL 显示两个规范化标签，同时不改变稳定的 Composer 工具栏尺寸

#### Scenario: Model 只有 Thinking off
- **WHEN** 当前可用选项列表恰好为 `off`
- **THEN** 触发器 SHALL 只显示 Model，主菜单 SHALL 隐藏 Thinking 区域

#### Scenario: 选择正在等待
- **WHEN** Model 或 Thinking 检查/选择尚未解决
- **THEN** 两个配置选项和 Composer 提交 SHALL 保持禁用，直到获得一个一致的已确认配置对

#### Scenario: Model 选择刷新 Thinking 菜单
- **WHEN** 用户从嵌套子菜单选择另一个 Model
- **THEN** Renderer SHALL 只关闭 Model 子菜单并在请求等待期间保持主菜单打开且配置选项禁用
- **AND** Adapter 或 Host 回读完成后，主菜单 SHALL 就地显示该确认 Model 实际可用的 Thinking 选项
