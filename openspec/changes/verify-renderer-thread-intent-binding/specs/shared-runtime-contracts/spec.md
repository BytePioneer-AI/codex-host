## ADDED Requirements

### Requirement: 创建请求标识符保持请求级类型隔离

Shared Contracts MUST提供`CreateRequestId`品牌类型和Runtime Schema，用于唯一标识一次Thread创建尝试。Schema MUST保留原始非空、非纯空白字符串，MUST NOT假设UUID或前缀格式，并 MUST使CreateRequestId在TypeScript中不能与Harness、Host Thread、Turn、Item或Interaction ID互换。

#### Scenario: 校验opaque创建请求ID

- **WHEN**Renderer生成非空opaque字符串并通过CreateRequestId Schema校验
- **THEN**Schema MUST返回内容不变且带CreateRequestId品牌的值
- **AND**该值 MUST可作为CreateThreadIntent的创建尝试身份

#### Scenario: 拒绝空创建请求ID

- **WHEN**调用方校验空字符串或纯空白字符串
- **THEN**CreateRequestId Schema MUST返回校验失败

#### Scenario: 创建请求ID与其他身份不可互换

- **WHEN**TypeScript调用方尝试把CreateRequestId赋给HarnessId、HostThreadId或HostTurnId
- **THEN**类型检查 MUST失败

### Requirement: 创建Thread意图保持最小且严格

Shared Contracts MUST提供strict `CreateThreadIntent`类型和Runtime Schema。Intent MUST只包含必填`requestId`、`harnessId`、非空`cwd`，以及可选非空`modelId`和`thinkingOptionId`。Schema MUST拒绝未知字段、显式`undefined`、非JSON值和空身份，并 MUST保持Agent选择与Model选择为独立字段。

#### Scenario: 校验最小Codex或Pi创建意图

- **WHEN**Renderer构造包含合法CreateRequestId、HarnessId和cwd的Intent，并可选提供Model和Thinking
- **THEN**Schema MUST接受并原样保留这些字段
- **AND**Intent MUST能JSON round-trip而不丢失字段

#### Scenario: Agent与Model保持独立

- **WHEN**Intent同时包含HarnessId和modelId
- **THEN**HarnessId MUST表示Thread执行主体且modelId MUST只表示该Harness内的Model选择
- **AND**Schema MUST NOT从modelId推导Harness或把carrier编码定义为产品语义

#### Scenario: 拒绝扩展或不可序列化意图

- **WHEN**Intent包含未知顶层字段、显式`undefined`、函数、bigint、循环值、空cwd或空可选ID
- **THEN**CreateThreadIntent Schema MUST返回校验失败而不是删除、转换或保留该值

#### Scenario: 不提前加入项目或Host领域字段

- **WHEN**调用方需要projectRef、HostThreadId、Mapping Store状态、首条Prompt或Codex Method payload
- **THEN**首版CreateThreadIntent Schema MUST拒绝这些未声明字段
- **AND**后续只有在对应Gate或正式调用方提供证据时才能增加版本化契约

## MODIFIED Requirements

### Requirement: 契约范围必须由已提交证据支持

Shared Contracts 的公共导出 MUST只包含Gate A/B/C已证实或正式架构已明确要求的基础值。Gate B新增范围 MUST限制为CreateRequestId和最小CreateThreadIntent；MUST NOT包含Gate-only Request扩展、Renderer Bridge消息、CDP/DOM/页面身份、Codex Method完整Schema、Host Operation/Event/Interaction、Mapping Store Record或Pi RPC。测试和构建 MUST NOT读取本地Gate Capture、用户Session、用户配置、真实Codex Desktop或网络。

#### Scenario: 普通质量检查

- **WHEN**开发者在没有Codex Desktop、Pi、用户认证或本地Gate证据的环境运行`npm run check`
- **THEN**Shared Contracts的全部Runtime、类型和边界测试 MUST确定性通过

#### Scenario: 审计未验证类型

- **WHEN**本变更完成公共导出范围审计
- **THEN**公共导出 MAY包含Gate B已验证的CreateRequestId和CreateThreadIntent
- **AND**公共导出 MUST NOT包含Gate-only carrier、Composer DOM类型、CDP session、Renderer Bridge消息、完整Harness inspect/Model目录、Host Operation/Event/Interaction、Mapping Store Record、Pi RPC或Codex Method专属完整Schema
