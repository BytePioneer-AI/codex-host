## ADDED Requirements

### Requirement: 委派默认模型与思考强度按 Harness 持久化并在新建委派时按三级优先级生效
codexhost SHALL 在共享 Harness 偏好中为每个 Harness 独立保存被委派时的默认 Model 与默认 Thinking 选项，与普通新会话偏好分离，并支持官方 Codex 与外部 Harness。发起新委派时，Host SHALL 按「本次显式指定 › 委派默认设置 › Agent 原生默认」解析模型与思考强度，不改变既有 CLI 协议、去重语义或已存在的委派子 Thread。

#### Scenario: 发起委派未显式指定模型与思考强度
- **WHEN** 调用方发起一次新委派且省略模型与思考强度参数，且目标 Harness 已保存委派默认模型与思考强度
- **THEN** Host SHALL 在创建目标子 Thread 时应用该委派默认模型与思考强度
- **AND** 官方 Codex 与外部 Harness 均 SHALL 按各自既有原生路径接收该选择

#### Scenario: 发起委派显式指定模型或思考强度
- **WHEN** 调用方在单次委派中显式指定了模型或思考强度
- **THEN** 显式指定的参数 SHALL 覆盖委派默认设置
- **AND** 若仅显式指定了与已保存默认不同的模型而未指定思考强度，Host MUST NOT 将旧默认模型的思考强度套用到本次显式模型上

#### Scenario: 未配置委派默认或已清空覆盖
- **WHEN** 目标 Harness 未保存委派默认设置或用户已在设置中重置该 Harness 的默认配置
- **THEN** Host SHALL 在省略参数时不传入额外模型或思考强度，继续沿用该 Harness 原生默认行为

#### Scenario: 已保存的委派默认确认失效
- **WHEN** 发起未显式指定参数的委派，且已保存的默认模型或思考强度不再被目标 Harness 当前目录支持
- **THEN** Host SHALL 静默忽略失效的默认项并回退到该 Harness 原生默认，不中断委派
- **AND** 若调用方本次显式传入了非法模型或思考强度，Host SHALL 继续拒绝并返回错误

#### Scenario: 修改委派默认不影响既有请求幂等性
- **WHEN** 调用方以同一 Request ID 重试此前已创建的委派，且期间用户修改了委派默认模型
- **THEN** Host SHALL 基于调用方原始请求保持幂等并命中原委派记录，MUST NOT 误报参数冲突
