## ADDED Requirements

### Requirement: 调用方可检查目标 Harness 的 Model 与 Thinking 能力
系统 SHALL 提供 `codexhost harness inspect <harness> [--cwd <path>] [--refresh]`，返回指定目标的可用 Model Catalog、默认 Model、Thinking 选项和配置能力。`<harness>` SHALL 接受原生 `codex` 及全部已注册外部 Harness ID。

#### Scenario: 检查外部 Harness
- **WHEN** 调用方检查一个已注册且可用的外部 Harness
- **THEN** Host SHALL 通过该 Harness 的公共 `HarnessAdapter.inspect()` 获取 Catalog 与 capabilities
- **AND** 响应 SHALL 保留 Adapter 拥有的 opaque Model Ref、展示标签、默认 Model、Thinking Options 和每个 Model 的 Thinking 支持关系

#### Scenario: 检查原生 Codex
- **WHEN** 调用方执行 `codexhost harness inspect codex`
- **THEN** Host SHALL 通过官方 App Server 的 `model/list` 请求获取 Model Catalog
- **AND** SHALL 将官方 Model 与 Thinking/Effort 元数据投影成结构化检查结果

#### Scenario: Harness 不可用
- **WHEN** 指定 Harness 未注册、未安装、需要认证或当前不可用
- **THEN** 命令 SHALL 返回结构化状态或错误
- **AND** MUST NOT 创建 Session、Thread 或 Turn

#### Scenario: 调用方请求刷新
- **WHEN** 调用方传入 `--refresh`
- **THEN** 外部 Harness inspection SHALL 请求刷新其 Catalog 缓存
- **AND** 未传入时 SHALL 允许 Adapter 使用现有缓存策略

### Requirement: Inspection 是只读发现操作
Harness inspection MUST NOT 改变用户 Thread、Session 配置或默认 Model。

#### Scenario: 检查 Catalog 不产生会话
- **WHEN** 调用方检查 Harness 的 Model 与 Thinking
- **THEN** Host MUST NOT 发布 Thread、启动 Turn、改变现有 Thread 配置或写入 Delegation 关系
