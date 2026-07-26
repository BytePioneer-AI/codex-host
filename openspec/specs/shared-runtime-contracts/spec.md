# shared-runtime-contracts Specification

## Purpose
TBD - created by archiving change define-evidence-based-shared-contracts. Update Purpose after archive.
## Requirements
### Requirement: Shared Contracts 保持浏览器安全和公共可消费

`@codexhost/shared-contracts` MUST 只使用浏览器安全的 TypeScript/JavaScript 能力和依赖，并 MUST 从 package 公共入口导出本 capability 定义的类型与 Runtime Schema。该 package MUST NOT 依赖 Node.js built-in、Electron 私有 API、Harness SDK 或其他 codexhost package。

#### Scenario: Renderer 消费公共契约

- **WHEN** Browser Target 构建从 `@codexhost/shared-contracts` 公共入口导入代表性 ID 和 Runtime Schema
- **THEN** 构建 MUST 成功且 MUST NOT 引入 Node.js、Electron 或 Harness Runtime 能力

#### Scenario: Shared Contracts 引入本地 Runtime 能力

- **WHEN** `shared-contracts`源码导入 Node.js built-in、Electron 私有 API或 Harness SDK
- **THEN** 普通边界检查 MUST 失败并指出违规 import

### Requirement: 公共 JSON 值可被严格序列化

Shared Contracts MUST 提供递归 `JsonValue`类型和 Runtime Schema，只接受 JSON 可表达的 primitive、array 和 string-keyed object。Schema MUST 拒绝不能由 JSON 可靠表达的 Runtime 值。

#### Scenario: 校验嵌套 JSON 值

- **WHEN** 调用方校验包含 string、finite number、boolean、null、嵌套 array 和 object 的值
- **THEN** Schema MUST 接受该值且 JSON round-trip 后结构保持一致

#### Scenario: 拒绝非 JSON 值

- **WHEN** 调用方提交 `undefined`、`bigint`、函数、Symbol、非有限数字或其他非 JSON 值
- **THEN** Schema MUST 返回校验失败而不是静默删除或转换该值

### Requirement: Host 和 Harness 标识符保持类型隔离

Shared Contracts MUST 提供 `HarnessId`、`HostThreadId`、`HostTurnId`、`HostItemId`和 `HostInteractionId`的品牌类型及 Runtime Schema。Schema MUST 保留原始字符串且只接受非空、非纯空白值；MUST NOT 假设 UUID、前缀、大小写或其他未验证编码格式。

#### Scenario: 校验 opaque 标识符

- **WHEN** 调用方通过对应 Schema 校验一个非空 opaque 字符串
- **THEN** Schema MUST 返回内容不变且带对应 TypeScript 品牌的值

#### Scenario: 不同标识符不能混用

- **WHEN** TypeScript 调用方尝试把 Host Turn ID 赋给 Host Thread、Item 或 Interaction ID
- **THEN** 类型检查 MUST 失败

#### Scenario: 拒绝空标识符

- **WHEN** 调用方校验空字符串或纯空白字符串
- **THEN** 每个标识符 Schema MUST 返回校验失败

### Requirement: Envelope 覆盖已验证的双向 JSON-RPC 形状

Shared Contracts MUST 提供 Request、Notification、Success Response 和 Error Response 的 Runtime Schema及判别联合。Envelope MUST NOT 要求当前 Codex app-server 未提供的 `jsonrpc`字段；该字段存在时 MUST 等于 `"2.0"`。Request 和 Response ID MUST 接受 string 或 integer，并 MUST NOT 接受 `null`。

#### Scenario: 解析 Gate A Request 和 Notification

- **WHEN** Schema 解析已评审 Gate A Fixture 中没有 `jsonrpc`字段的带 ID Request 和不带 ID Notification
- **THEN** Request 与 Notification MUST 分别通过对应 Schema并被正确分类

#### Scenario: 同一 Request 结构用于两个方向

- **WHEN** Desktop 或 Server 发出具有 ID、非空 method 和可选 JSON params 的请求
- **THEN** 同一个 Request Schema MUST 接受该 Envelope，且方向所有权不被编码进 Envelope 类型

#### Scenario: 区分成功和错误 Response

- **WHEN** Response 具有匹配 ID并且只包含 `result`或只包含结构化 `error`
- **THEN** Schema MUST 将其分类为 Success Response 或 Error Response

#### Scenario: 拒绝冲突 Envelope

- **WHEN** 消息同时包含 `result`和 `error`、Notification 包含 `id`、Response 包含 `method`，或 Error 缺少 integer code/message
- **THEN** Envelope Schema MUST 返回校验失败

### Requirement: Envelope 校验不得丢失透明扩展字段

Envelope Runtime Schema MUST 保留顶层消息和 JSON-RPC Error 对象中的未知字段。Schema MUST 只校验通用 Envelope，不得猜测或固化 Codex Method 专属 params/result。

#### Scenario: 保留未知字段

- **WHEN** 合法 Envelope 含有当前 Shared Contracts 未识别的顶层字段或 Error 扩展字段
- **THEN** Schema parse 结果 MUST 保留这些字段和值

#### Scenario: 接受未知 Method 的 JSON payload

- **WHEN** Request 使用未识别的 method 且 params 是合法 JSON 值
- **THEN** 通用 Envelope Schema MUST 接受该消息而不要求 Method 专属 Schema

### Requirement: Native 引用保持 versioned opaque 语义

Shared Contracts MUST 提供 `NativeSessionRef`、`NativeTurnRef`和 `NativeCheckpointRef` V1 类型及 Runtime Schema。每个 Ref MUST 包含 `harnessId`、`nativeSessionId`和 `formatVersion: 1`；Turn Ref MUST 额外包含 `nativeTurnKey`，Checkpoint Ref MUST 额外包含 `checkpointId`。可选 locator MUST 是 `JsonValue`。

#### Scenario: 校验 Native Session Ref

- **WHEN** Adapter 提交包含 Harness、Native Session 身份、可选 JSON locator 和 `formatVersion: 1`的 Session Ref
- **THEN** Session Ref Schema MUST 接受并保留该 opaque 引用

#### Scenario: Turn 身份与 Checkpoint 独立

- **WHEN** 同一个底层原生 ID分别用于稳定 Native Turn 身份和可 Fork Checkpoint
- **THEN** 调用方 MUST 使用不同的 Native Turn Ref 和 Native Checkpoint Ref 类型表达两种语义

#### Scenario: 拒绝未知 Ref 格式

- **WHEN** Native Ref 使用未知 formatVersion、缺少必填身份字段、包含纯空白 Key或在 V1 顶层包含未声明字段
- **THEN** 对应 V1 Schema MUST 返回校验失败

#### Scenario: 拒绝不可序列化 locator

- **WHEN** Native Session 或 Checkpoint locator包含非 JSON 值
- **THEN** 对应 Ref Schema MUST 返回校验失败

### Requirement: Native 引用不得成为第二事实源或凭据容器

Native Ref producer MUST NOT 将 Transcript、Prompt、完整消息正文、Tool 输出、Diff、Access Token、API Key或 OAuth Secret写入 Native Ref。非所属 Adapter MUST 把 locator 视为 opaque，只允许保存、比较和回传。

#### Scenario: 非所属模块处理 locator

- **WHEN** Protocol Core 或 Mapping Store 收到合法 Native Ref
- **THEN** 该模块 MUST NOT 根据 locator 内容推导 Harness、Turn、Checkpoint、消息或权限语义

#### Scenario: Adapter 构造持久化 Ref

- **WHEN** Adapter 发布将由 Host 持久化的 Native Ref
- **THEN** Ref MUST 只包含恢复或定位所需的非敏感 JSON 元数据且 MUST NOT 包含会话内容

### Requirement: 跨边界错误具有统一最小结构

Shared Contracts MUST 提供由非空 `code`、非空用户可理解 `message`、`retryable` boolean和可选非空 `diagnostic`组成的错误类型与 strict Runtime Schema。公共 Schema MUST NOT 提前固定 HarnessAdapter、Mapping Store、Bridge 或 Protocol Core 的领域错误码全集。

#### Scenario: 校验结构化错误

- **WHEN** owning package 提交包含 code、message、retryable和可选 diagnostic 的错误
- **THEN**公共错误 Schema MUST 接受该值并保留所有字段

#### Scenario: 拒绝不完整或扩展错误

- **WHEN** 错误缺少 code/message/retryable、使用空 code/message，或携带未声明的顶层字段
- **THEN**公共错误 Schema MUST 返回校验失败

#### Scenario: 领域 package 收窄错误码

- **WHEN** HarnessAdapter、Mapping Store、Bridge 或 Protocol Core 定义自己的错误分类
- **THEN**该 package MUST 在保持公共错误字段的前提下收窄 code，而不是修改公共 Schema 为单一跨领域 enum

### Requirement: 契约范围必须由已提交证据支持

Shared Contracts 的本次公共导出 MUST 只包含 Gate A/C 已证实或正式架构已明确要求的基础值。测试和构建 MUST NOT 读取本地 Gate C Capture、用户 Pi Session、用户配置、真实 Codex Desktop 或网络。

#### Scenario: 普通质量检查

- **WHEN** 开发者在没有 Codex Desktop、Pi、用户认证或本地 Gate C 证据的环境运行 `npm run check`
- **THEN** Shared Contracts 的全部 Runtime、类型和边界测试 MUST 确定性通过

#### Scenario: 审计未验证类型

- **WHEN** 本变更完成范围审计
- **THEN**公共导出 MUST NOT 包含 `CreateThreadIntent`、完整 Bridge、Host Operation/Event/Interaction、Mapping Store Record、Pi RPC 或 Codex Method 专属 Schema

