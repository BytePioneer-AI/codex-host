## ADDED Requirements

### Requirement: 受支持 Desktop 必须为外部 Thread 使用原生上下文 Usage 界面

对于受支持的 Codex Desktop build，Host MUST 通过已评审的原生 `thread/tokenUsage/updated` Notification 投影完整外部 Thread Usage，使现有上下文窗口界面反映所选 Harness 的真实 Native Session。Renderer Extension MUST NOT 增加第二个上下文表盘、轮询 Pi 专用 Request、检查 Model carrier 获取上下文大小，或暴露通用 Host Request bridge。

#### Scenario: Pi 上下文 Usage 可用

- **WHEN** 可见 Pi Thread 收到协议有效的 Usage Notification，其中包含实际上下文已用 Token 和最大窗口
- **THEN** 现有 Desktop 上下文窗口界面 MUST 显示相应的有界百分比和 Token 数值关系
- **AND** 该 Thread MUST 保持选中 Pi 且锁定

#### Scenario: Usage 缺失或不完整

- **WHEN** 所属 Harness 尚未报告完整且可投影的上下文快照
- **THEN** 外部 Thread MUST 保持可用，且不得显示虚构百分比
- **AND** Renderer MUST NOT 复用其他 Composer、Thread、Session、Model 或过期 Request generation 的 Usage

#### Scenario: 恢复后的外部 Thread 变为可见

- **WHEN** 受支持 conversation target 已恢复，且 Host 从其 Native Session 读取当前 Usage
- **THEN** 原生上下文窗口界面 MUST 在归属解析之后为准确的 Host Thread 刷新
- **AND** Renderer MUST NOT 解析 Prompt、Transcript、Native Ref 或 Model carrier

#### Scenario: Desktop 协议结构改变

- **WHEN** 当前生成的 app-server Schema 或受控视觉 Gate 不再接受已评审的 Usage Notification 结构
- **THEN** 外部 Usage 投影 MUST fail closed 并保持隐藏
- **AND** 系统 MUST NOT 安装启发式 DOM 表盘作为 fallback
