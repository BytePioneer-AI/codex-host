## MODIFIED Requirements

### Requirement: 版本化 Adapter 驱动原生创建 Model 状态
对于受支持的 Desktop 构建，Renderer Adapter SHALL 仅在 Composer 选择外部 Agent 时，同步将唯一关联 Composer 的 optimistic 原生 Model 状态更新为有界内部 carrier。通用 Pi carrier SHALL 为 `codexhost/pi-native`；显式 Pi Model 和 Thinking 请求 SHALL 以向后兼容 carrier 表示。

#### Scenario: 使用选定配置创建 Pi 对话
- **WHEN** Pi Composer 在原生创建前拥有有效 Pi Model Ref 和 Thinking 请求
- **THEN** `thread/start` 携带绑定到该 Composer 的单个有界 Pi carrier
- **AND** 显示值保持为规范化标签，而非 carrier 组件

#### Scenario: 创建 Codex 对话
- **WHEN** Composer 选择 Codex
- **THEN** Adapter 恢复捕获的官方不透明状态，原生创建保留官方 Model 和 Reasoning 行为

#### Scenario: Renderer 不受支持或存在歧义
- **WHEN** asset、atom 对、Model 目标、安装时机或 Composer 关联不受支持或有歧义
- **THEN** 外部创建被 unavailable 状态阻止，不得静默路由到 Codex

### Requirement: Pi Model 状态遵循逻辑 Composer 生命周期
Renderer SHALL 将 Pi Model、Draft Thinking 请求和异步配置控件状态限定在同一逻辑 Composer 身份内，同时只允许通过经校验的当前进程 Thread 身份写入已有 Thread。

#### Scenario: 草稿替换保留配置
- **WHEN** Pi 草稿或锁定的新 Thread Composer 从默认目标过渡到 conversation 目标
- **THEN** 替换对象保留 Pi Model Ref、Thinking 请求和控件状态

#### Scenario: 新任务重置配置
- **WHEN** conversation 目标过渡到新的默认 Composer
- **THEN** 新 Composer 使用最近提交的 Agent，但不继承先前 Pi Model 或 Thinking

#### Scenario: Draft 选择其他 Pi Model
- **WHEN** 用户在 Pi Draft 中选择内存 Catalog 内另一个 Model
- **THEN** Renderer 不发送 Harness inspection，而是从该 Model 的 `supportedThinkingOptionIds` 解析请求值并更新 carrier
- **AND** 只等待已有 official prewarm clear 后完成选择

#### Scenario: 选择已有 Pi Thread 的 Model
- **WHEN** conversation 目标提供经校验的 Host Thread ID，且用户选择不同 Pi Model
- **THEN** Renderer 发送固定 Thread Model 请求，并应用 Host 返回的 Pi Session 实际 Model/Thinking 状态

#### Scenario: 选择已有 Pi Thread 的 Thinking
- **WHEN** 用户为 Idle 的当前进程 Pi Thread 选择 Thinking 请求
- **THEN** Renderer 发送固定 Thread Thinking 请求，并应用 Host 返回的 Pi Session 实际状态

#### Scenario: 异步结果过期
- **WHEN** 较早检查、prewarm clear 或已有 Thread 选择在 Composer、Agent、目标或请求代数改变后完成
- **THEN** Renderer 忽略结果并保留较新状态

### Requirement: Forked Pi Model 使用 Host 确认状态
Thread 检查 SHALL 为精确 Host Thread 返回有界 carrier，以及可选的实际 Harness Model、Thinking 和当前选项。Renderer SHALL 只将该状态应用到 forked conversation。

#### Scenario: Pi Fork 继承较早配置
- **WHEN** 选定 Checkpoint 早于源 Model 或 Thinking 的后续变更
- **THEN** forked Composer 显示并携带派生 Pi Session 报告的配置，而非源页面最新值或 Draft Catalog 推断

## ADDED Requirements

### Requirement: Pi 配置控件匹配原生组合选择器
受支持的 Renderer SHALL 在独立 Agent 控件旁呈现 Pi 配置触发器，复用捕获的原生触发器 class 和 Codex 下拉设计 token，并将 Thinking 选项置于主菜单、Model 选项置于嵌套子菜单。

#### Scenario: 组合触发器就绪
- **WHEN** Pi 初始检查返回选定 Model 和多于一个统一 Thinking 请求选项
- **THEN** 触发器显示两个规范化标签，同时不改变稳定工具栏尺寸

#### Scenario: Model 只有 Thinking off
- **WHEN** 所选 Model 的 Catalog 支持关系恰好为 `off`
- **THEN** 触发器只显示 Model，主菜单隐藏 Thinking 区域

#### Scenario: Model 支持关系缺失
- **WHEN** 所选 Model 缺少 `supportedThinkingOptionIds`
- **THEN** Renderer 不显示 Thinking 选项，不得回退到 Catalog 全局列表

#### Scenario: Draft Model 选择使用内存 Catalog
- **WHEN** 用户从嵌套子菜单选择另一个 Draft Model
- **THEN** Renderer 只关闭 Model 子菜单，同步使用内存 Catalog解析 Thinking 请求并更新原生 carrier
- **AND** 不得启动目标 Pi inspection
- **AND** codexhost菜单在 official prewarm clear 完成后确认新选项，清理期间保持 selecting

#### Scenario: Existing Thread 选择正在等待
- **WHEN** Existing Thread Model 或 Thinking 选择尚未解决
- **THEN** 配置选项和 Composer 提交保持禁用，直到 Host 返回一致的 Pi Session 状态
