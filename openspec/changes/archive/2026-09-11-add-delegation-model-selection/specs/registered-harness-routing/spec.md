## ADDED Requirements

### Requirement: 委派创建可携带显式 Model 与 Thinking
`codexhost delegate start` SHALL 接受可选 `--model <opaque-ref>` 与 `--thinking <option-id>`，并在创建目标普通可写 Thread 时应用这些配置。该能力 SHALL 支持全部已注册外部 Harness 和原生 Codex。

#### Scenario: 外部 Harness 使用显式配置创建
- **WHEN** 调用方对外部 Harness 指定有效 Model 与 Thinking
- **THEN** Coordinator SHALL 通过公共 Adapter seam 调用 `open({kind: "create", model, thinkingOptionId})`
- **AND** MUST NOT 增加 Harness 专用 Delegation 分支

#### Scenario: 原生 Codex 使用显式配置创建
- **WHEN** 调用方对 `codex` 指定有效 Model 或 Thinking/Effort
- **THEN** Host SHALL 将显式配置传给官方 `thread/start`
- **AND** 未指定的配置字段 SHALL 保持省略

#### Scenario: 创建返回实际配置
- **WHEN** 目标 Session 已确认实际 Model 或 Thinking
- **THEN** Start 响应 SHALL 返回 requested 与已确认的 effective 配置
- **AND** MUST NOT 将请求值冒充未确认的 effective 配置

#### Scenario: 外部 Thread 持久化配置
- **WHEN** 外部 Harness 委派使用显式 Model 或 Thinking 创建成功
- **THEN** Thread record SHALL 使用现有 external transport selection 编码保存配置
- **AND** Session Resume 与 Desktop Thread 展示 SHALL 继续使用同一配置语义

### Requirement: 委派幂等身份包含显式配置
委派隐式去重和显式 Request ID 一致性 SHALL 区分不同的 Model、Thinking 与 cwd 配置。

#### Scenario: 相同任务使用不同 Model
- **WHEN** 相同父 Thread、目标 Harness 和任务分别使用两个不同 Model 发起委派
- **THEN** Host MUST NOT 将第二个请求隐式去重到第一个子 Thread

#### Scenario: Request ID 配置冲突
- **WHEN** 已使用某 Request ID 创建委派后，调用方使用同一 Request ID 但改变任务、cwd、Model 或 Thinking
- **THEN** Host SHALL 返回结构化参数冲突错误
- **AND** MUST NOT 返回配置不一致的既有 Thread
