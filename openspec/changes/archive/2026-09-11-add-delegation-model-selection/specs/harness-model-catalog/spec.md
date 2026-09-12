## ADDED Requirements

### Requirement: Delegation 使用公共 Harness Catalog 验证显式配置
当 `delegate start` 显式指定外部 Harness Model 或 Thinking 时，Host SHALL 使用目标 `HarnessAdapter.inspect()` 返回的公共 Catalog 和 capabilities 验证请求，并 SHALL 由 Adapter `open()` 执行最终原生校验。

#### Scenario: 显式 Model 存在
- **WHEN** 调用方指定 Catalog 中存在的 opaque Model Ref
- **THEN** Host SHALL 将该 Model Ref 传给目标 Adapter 的 Create Session 输入

#### Scenario: 显式 Model 不存在
- **WHEN** 调用方指定的 Model Ref 不属于目标 Harness 当前 Catalog
- **THEN** 创建 SHALL 以结构化参数错误失败
- **AND** 错误详情 SHALL 提供目标 Harness 和可用 Model Ref
- **AND** MUST NOT 发布子 Thread 或 Delegation 成功结果

#### Scenario: 显式 Thinking 受所选 Model 支持
- **WHEN** 调用方指定 Thinking Option 且该 Option 被显式 Model 或目标默认 Model 支持
- **THEN** Host SHALL 将该 Thinking Option 传给 Adapter 的 Create Session 输入

#### Scenario: Thinking 能力不受支持
- **WHEN** 调用方对不支持 Thinking 选择的 Harness 指定 `--thinking`
- **THEN** 创建 SHALL 以结构化参数错误失败
- **AND** MUST NOT 静默忽略该选项

### Requirement: 省略配置时保持 Harness 默认选择
当调用方未显式指定 Model 或 Thinking 时，Host MUST NOT 从 Catalog 人为填充该配置，目标 Harness SHALL 继续使用自身当前或默认选择。

#### Scenario: 同时省略 Model 和 Thinking
- **WHEN** 调用方执行 `delegate start` 且未传入 `--model` 与 `--thinking`
- **THEN** Adapter Create Session 输入 SHALL 省略 `model` 与 `thinkingOptionId`
- **AND** 行为 SHALL 与本能力加入前的默认委派一致

#### Scenario: 只指定 Model
- **WHEN** 调用方指定 Model 但省略 Thinking
- **THEN** Host SHALL 传递 Model 并省略 `thinkingOptionId`
- **AND** 目标 SHALL 使用该 Model 自身的默认 Thinking 配置

#### Scenario: 只指定 Thinking
- **WHEN** 调用方省略 Model 但指定 Thinking
- **THEN** Host SHALL 针对目标默认 Model 验证该 Thinking
- **AND** SHALL 省略 Model 并传递 Thinking Option
