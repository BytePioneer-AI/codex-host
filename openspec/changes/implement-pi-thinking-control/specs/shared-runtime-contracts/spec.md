## MODIFIED Requirements

### Requirement: 共享 Model Catalog 契约保持浏览器安全且严格
Shared Contracts SHALL 导出浏览器安全的类型和 Runtime Schema，用于不透明 Harness Model Ref、规范化 Model 条目、规范化 Thinking 选项、每个 Model 支持的选项 ID、Model Catalog、检查结果、结构化 Model/Thinking 选择能力，以及完整的生效配置状态。V1 对象 SHALL 在第一个正式控制边界解析时拒绝未声明字段。

#### Scenario: Renderer 校验 ready 检查结果
- **WHEN** Renderer 收到包含有效不透明 Model Ref、Model 标签、当前 Thinking 选项、默认/生效值和结构化能力的 ready 检查结果
- **THEN** 公共 Runtime Schema 接受完整值，且不引入 Node.js、Electron、Harness SDK 或其他 codexhost 包

#### Scenario: 检查结果泄露原生配置
- **WHEN** Catalog 条目、Thinking 选项或检查结果包含未声明的 Provider 对象、base URL、价格、路径、凭证、预算、上游参数或任意原生 payload
- **THEN** 严格 Runtime Schema 拒绝该值，不得保留或静默投影

#### Scenario: Model 或 Thinking Ref 不适合 transport carrier
- **WHEN** Model Ref 或 Thinking 选项 ID 为空、仅含空白、超过有界长度，或包含定义的不透明 transport-safe 字母表之外的字符
- **THEN** 对应 Runtime Schema 拒绝它

#### Scenario: Catalog 关系不一致
- **WHEN** 默认 Thinking 选项或 Model 支持的选项 ID 不在规范化选项列表中，或出现重复 ID
- **THEN** Catalog Runtime Schema 拒绝不一致的值

### Requirement: 共享 Model 控制参数必须按方法区分
Shared Contracts SHALL 为 Harness 检查参数、当前进程 Thread Model 选择参数和当前进程 Thread Thinking 选择参数分别提供严格 Runtime Schema，不得提供任意 method/payload 控制信封。Harness 检查参数 SHALL 携带经校验的不透明 Harness ID，以及可选 cwd、refresh 和目标 Model Ref，不得限制为某一种具体 Harness。

#### Scenario: 有效的已注册 Harness 检查参数
- **WHEN** 控制边界收到带可选 cwd、refresh 和规范化目标 Model Ref 的非空 Harness 标识
- **THEN** 检查参数 schema 接受并仅保留这些字段

#### Scenario: 有效的 Thread Model 选择参数
- **WHEN** 控制边界收到非空 Host Thread ID 和有效 Harness Model Ref
- **THEN** Thread Model 选择参数 schema 接受该请求

#### Scenario: 有效的 Thread Thinking 选择参数
- **WHEN** 控制边界收到非空 Host Thread ID 和有效规范化 Thinking 选项 ID
- **THEN** Thread Thinking 选择参数 schema 接受该请求

#### Scenario: 注入原生方法
- **WHEN** 控制请求包含 Pi RPC 方法名、原生 Provider/Model 字段、上游 reasoning 参数或其他未声明属性
- **THEN** 方法专用 schema 在 Host 或 Renderer 使用请求前拒绝它
