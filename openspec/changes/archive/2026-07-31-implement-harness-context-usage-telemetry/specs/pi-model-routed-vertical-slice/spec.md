## ADDED Requirements

### Requirement: Pi 必须发布当前 Native Session Usage 且不得拥有 UI 投影

Pi Adapter MUST 只从当前 Native Session 的结构化 Pi RPC 获取 Usage，将其规范化为 Harness Usage，并通过 HarnessSession Telemetry 契约发布。Pi Adapter MUST NOT 构造 Codex `thread/tokenUsage/updated` 对象、维护 Renderer store、根据所选 Model Ref 推断上下文大小，或持久化第二份 Usage history。

#### Scenario: Pi 首个 Turn 完成

- **WHEN** 使用 Model 路由的 Pi Thread 到达首个稳定 Turn terminal，且 Pi 报告当前 Session 统计
- **THEN** Pi Adapter MUST 发布同一 Native Session 和 effective Model 的规范化 Usage
- **AND** Host 选择的 transport Model carrier MUST NOT 参与 Token 计算

#### Scenario: Pi Model 改变

- **WHEN** 空闲 Pi Session 确认 Model 选择，且原生 Usage context 发生变化
- **THEN** Pi Adapter MUST 在同一串行化配置边界中使旧 Usage 失效或刷新它
- **AND** 先前 effective configuration 的过期 Usage MUST NOT 在此后成为当前值

#### Scenario: Pi Thread 恢复

- **WHEN** 已持久化 Pi Thread 根据其 Native Session Ref 恢复
- **THEN** Pi Adapter MUST 尝试使用恢复后的 Native Session 为 `initialUsage` 提供初始值
- **AND** Host MUST NOT 需要 Pi 专用恢复查询

#### Scenario: Pi Telemetry 不可用

- **WHEN** Pi 仍支持所选 Model 和 Turn，但没有提供可靠的 Usage Response
- **THEN** Pi Turn MUST 保持其原生 outcome 和路由
- **AND** 只有可选 Usage 界面 MUST 保持不可用
