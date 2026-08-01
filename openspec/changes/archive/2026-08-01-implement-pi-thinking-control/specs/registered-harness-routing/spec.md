## MODIFIED Requirements

### Requirement: Harness 控件通过已注册所有权分发
Host Runtime SHALL 通过请求指定的已注册 Harness ID 分发 Harness 检查，并通过所属 HarnessSession 及其声明的结构化能力分发 Thread Model 和 Thinking 选择。这些控制路径不得要求 Pi 所有权，也不得检查 Harness 原生 Provider 配置。

#### Scenario: 检查已注册的非 Pi Harness
- **WHEN** 有效的 Harness 检查请求指定已注册的非 Pi Harness
- **THEN** Host SHALL 使用规范化输入调用该 Adapter 的 `inspect()`
- **AND** 返回经过校验的检查结果，不得调用 PiAdapter

#### Scenario: 所属非 Pi Session 支持 Model 选择
- **WHEN** Model 选择请求引用的 external Thread 所属 Session 声明 `configuration.selectModel=true`
- **THEN** Host SHALL 在该所属 Session 上执行 `model.select`
- **AND** 通过有序 Session 状态确认完整的生效配置，不得按 Harness ID 分支

#### Scenario: 所属 Session 支持 Thinking 选择
- **WHEN** Thinking 选择请求引用的 external Thread 所属 Session 声明 `configuration.selectThinkingOption=true`
- **THEN** Host SHALL 在该所属 Session 上执行 `thinking.select`
- **AND** 仅返回从有序 Session 状态消费的生效选项及可用选项

#### Scenario: 所属 Session 不支持请求的配置
- **WHEN** Model 或 Thinking 请求引用的 Session 对应配置能力为 false
- **THEN** Host SHALL 返回明确的 unsupported 错误
- **AND** 不得执行配置命令或调用其他 Adapter

#### Scenario: Model 变更同时改变 Thinking
- **WHEN** 所属 Harness 因 Model 选择的副作用修正 Thinking
- **THEN** Host SHALL 返回有序输出流中的单个完整变更后状态
- **AND** 不得将请求的 Model 与之前缓存的 Thinking 值合并
