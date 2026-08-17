# Grok CLI Adapter 接入分析

## 1. 背景

codexhost 当前已经接入两个非 Codex Harness：

- Pi：通过 Pi 官方 RPC Mode 接入。
- Claude Code：通过 Claude Agent SDK / CLI 接入。

两者最终都实现 codexhost 的 `HarnessAdapter` 接口，将各自的原生 Session、Turn、工具、权限和历史语义投影到 Codex Desktop。

现在需要判断 Grok CLI 是否能够以相同方式作为独立 Harness 接入，以及应该使用 Grok 专用接口还是 ACP（Agent Client Protocol）。

本文结论最初基于本机 Grok CLI `1.0.3`，并使用 `1.0.4` 的命令、初始化响应、ACP Diff Content 和随安装文档复核。后续版本可能改变 Grok 扩展字段，因此实现必须进行运行时能力探测和结构校验。

## 2. 核心结论

Grok CLI 可以接入 codexhost，推荐采用：

> 标准 ACP 负责核心实时执行，Grok ACP 扩展负责可探测增强，Grok 原生 Session 文件只读补充历史事实。

Grok 与 ACP 不是平行关系。准确关系是：

> Grok CLI 是一个支持 ACP 的 Harness，GrokAdapter 内部使用 ACP 与 Grok CLI 通信。

推荐结构：

```text
Host Runtime
    |
    | codexhost 领域语义
    v
HarnessAdapter
    |
    v
GrokAdapter
    |
    +-- 标准 ACP 能力映射
    +-- Grok x.ai/* 扩展映射
    +-- Grok History Reader
    |
    v
ACP Client / Transport
    |
    | JSON-RPC 2.0 over stdio
    v
grok agent --no-leader stdio
```

ACP 不替代 `HarnessAdapter`。ACP 是 GrokAdapter 内部的通信协议；`HarnessAdapter` 仍是 Host Runtime 唯一依赖的 codexhost 领域接口。

## 3. 为什么不能直接用 ACP 替代 HarnessAdapter

ACP 和 `HarnessAdapter` 解决的问题不同：

| 层 | 责任 |
| --- | --- |
| `HarnessAdapter` | 统一 codexhost 的 Thread、Turn、Item、Approval、Usage、Fork 和 Checkpoint 语义 |
| ACP | 统一 Client 与 Agent Harness 之间的 Session、Prompt、Streaming、Tool、Permission 和 Cancel 通信 |

例如，Grok 发出的 ACP `tool_call` / `tool_call_update` 不能直接交给 Host Runtime，需要由 GrokAdapter 转换成：

- `HostCommandExecutionItem`
- `HostToolExecutionItem`
- `HostFileChangeItem`（仅当存在可靠 Diff）

ACP `session/request_permission` 也需要转换为 `HostApprovalInteraction`，ACP `PromptResponse.stopReason` 需要转换为 codexhost 的 `TurnOutcome`。

因此 ACP 类型和 Grok 扩展字段不应泄漏到 `host-runtime`、`protocol-core` 或 Renderer。

## 4. Grok CLI 提供的接口

### 4.1 标准 ACP RPC

Grok CLI 提供本地 stdio Agent 模式：

```bash
grok agent --no-leader stdio
```

通信协议是 JSON-RPC 2.0 over stdin/stdout。已确认的标准能力包括：

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/update`
- `session/request_permission`
- `session/set_config_option`

Grok 还提供 WebSocket Server：

```bash
grok agent serve --bind 127.0.0.1:2419 --secret <token>
```

codexhost 是本机进程集成，推荐 stdio，不需要端口、Secret 或本地网络服务，并且进程生命周期和故障隔离更明确。

### 4.2 ACP SDK

TypeScript 可以使用官方 ACP SDK：

```text
@agentclientprotocol/sdk
```

它提供 ACP 类型、JSON-RPC 请求关联、反向权限请求、通知、取消和连接生命周期管理。Grok 当前初始化协商的协议版本是 ACP v1，因此首版应按 v1 能力实现，不假设 ACP v2 能力可用。

Grok 文档还列出了 Rust、Python、Go 和 Kotlin ACP SDK，但 Grok Adapter 属于 TypeScript Workspace，应优先使用 TypeScript SDK。

### 4.3 Grok ACP 扩展 RPC

Grok 在同一条 ACP JSON-RPC 通道上提供 `x.ai/*` 扩展，例如：

```text
x.ai/session/*
x.ai/rewind/*
x.ai/git/*
x.ai/fs/*
x.ai/terminal/*
x.ai/search/*
x.ai/auth/*
```

其中包括：

- `x.ai/session/fork`
- `x.ai/prompt_history`
- `x.ai/compact_conversation`
- `x.ai/session_notification`
- `x.ai/git/diffs`

这些不是另一套传输，而是 Grok 在 ACP 上增加的自定义 RPC。ACP SDK 可以发送自定义请求，但不会提供这些 Grok 扩展的完整 TypeScript 类型。Adapter 需要为实际使用的扩展定义局部类型和运行时 Schema。

### 4.4 Grok 原生 Session 文件

Grok 将 Session 存放在：

```text
~/.grok/sessions/<encoded-cwd>/<session-id>/
```

主要文件包括：

```text
summary.json
updates.jsonl
chat_history.jsonl
rewind_points.jsonl
signals.json
```

Grok 文档将 `updates.jsonl` 定义为恢复会话的权威内容日志。codexhost 可以只读这些文件，用于历史快照、稳定 Turn 映射和 Usage 兜底。

不得直接修改这些文件来实现 Fork、Rollback 或 Session 配置。所有写操作必须通过 Grok RPC/CLI 完成，Native Session 的所有权仍属于 Grok Harness。

### 4.5 没有 Grok 专用 Agent SDK

目前没有发现类似 `@anthropic-ai/claude-agent-sdk` 的 Grok 专用 Agent SDK。

官方 npm 包：

```text
@xai-official/grok
```

是 CLI 和平台二进制分发包，没有 `main`、`exports` 或 TypeScript 类型，不能作为可嵌入的 Agent SDK 使用。

xAI Model API、OpenAI-compatible API 或 `@ai-sdk/xai` 属于 Model/Provider 调用，不包含 Grok CLI 的 Agent Loop、工具、权限和原生 Session。使用这些接口会变成重新实现一个 Harness，而不是接入 Grok CLI，因此不适合本任务。

## 5. ACP 能力与 codexhost 能力对照

| 能力 | Codex | Pi | Claude Code | 标准 ACP | Grok ACP / 原生增强 |
| --- | --- | --- | --- | --- | --- |
| 流式回复 | 原生 | 支持 | 支持 | 支持 | 不需要增强 |
| Reasoning / Thinking 流 | 原生 | 支持 | 支持 | 支持 | 不需要增强 |
| 工具状态 | 原生 | 支持 | 支持 | 支持 | 可补充 Grok 元数据 |
| Edit Diff | 原生 | 支持 | 支持 | Tool Content 可提供前后文本 | 成功终态提供可靠 ACP Diff Content |
| 提问 | 原生 | 支持 | 支持 | 取决于 Agent 实现 | Grok 可通过原生交互补充 |
| 工具审批 | 原生 | 支持 | 支持 | 支持 | 保留 Grok 原生 Option ID |
| 取消 Turn | 原生 | 支持 | 支持 | 支持 | 不需要增强 |
| Model 选择 | 原生 | 支持 | 支持 | 可通过 `configOptions` 探测 | `_meta.modelState` 提供目录 |
| Thinking 选择 | 原生 | 支持 | 支持 | 可通过 `configOptions` 探测 | `_meta.reasoningEfforts` 提供选项 |
| 权限模式 | 原生 | 不支持 | 支持 | 可通过 modes/config 探测 | Grok 定义具体模式语义 |
| Usage / 上下文用量 | 原生 | 支持 | 支持 | Usage 字段仍有限/实验性 | `turn_completed.usage`、`signals.json` |
| 会话恢复 | 原生 | 支持 | 支持 | 支持 | `updates.jsonl` 校验历史 |
| 完整历史读取 | 原生 | 支持 | 支持 | 可回放但稳定身份不足 | `updates.jsonl`、`summary.json` |
| Thread / Session 管理 | 原生 | 支持 | 部分支持 | 基础能力可协商 | Grok Session 扩展 |
| Fork | 原生 | 任意 Turn | 任意 Turn | ACP v1 不统一保证 | `_x.ai/session/fork` 支持按 Prompt Index Fork |
| 上下文压缩 | 原生 | 支持 | 支持 | 不统一保证 | Grok Compaction 通知/扩展 |
| 斜杠命令 | 原生 | 开发中 | 开发中 | 可发现，执行语义不统一 | Grok Commands 扩展 |
| 修订/回滚上一条 | 原生 | 支持 | 部分支持 | 标准能力不足 | Grok Rewind 语义需验证 |

标准 ACP 最适合覆盖核心实时链路：

- Session 创建和恢复
- Prompt
- Streaming Text/Thinking
- Tool 生命周期
- Approval
- Cancel
- 基础配置项

ACP 不能统一保证高保真历史、任意 Turn Fork、Rollback、Unified Diff、完整 Usage 和 Compaction 生命周期。

## 6. 为什么不同 ACP Harness 的能力不同

ACP 标准只有一套，但每个 Harness：

1. 可以只实现标准能力的一部分。
2. 通过 `initialize` 声明自己支持的能力。
3. 通过 `session/new` / `session/load` 返回可用 modes 和 `configOptions`。
4. 可以增加自己的扩展 RPC。

因此 ACP 统一的是通信方式，不保证所有 Harness 业务能力相同。

例如：

| 能力 | Harness A | Harness B |
| --- | --- | --- |
| 文本 Prompt | 支持 | 支持 |
| 图片输入 | 支持 | 不支持 |
| Session Load | 支持 | 不支持 |
| Approval | 支持 | 支持 |
| Fork | 自定义扩展 | 不支持 |

codexhost 必须进行能力协商，再将协商结果转换为 `HarnessSessionCapabilities`。Host Runtime 不需要知道能力来自标准 ACP、Grok 扩展还是原生历史文件。

## 7. 推荐架构

### 7.1 当前接入结构

首个 ACP Harness 接入时，建议先将 ACP Transport 放在 Grok Adapter 内部：

```text
packages/adapters/grok/
  src/
    command.ts
    acp-client.ts
    acp-transport.ts
    grok-adapter.ts
    grok-capabilities.ts
    grok-extensions.ts
    grok-history.ts
    grok-models.ts
    grok-usage.ts
```

职责如下：

| 模块 | 职责 |
| --- | --- |
| `command.ts` | 查找 Grok 可执行文件，构造环境和启动参数 |
| `acp-client.ts` | ACP SDK 连接和 JSON-RPC 生命周期 |
| `acp-transport.ts` | 标准 Session、Prompt、Cancel、Tool、Permission 流程 |
| `grok-adapter.ts` | 实现 codexhost `HarnessAdapter` |
| `grok-capabilities.ts` | 汇总 ACP 和 Grok 扩展能力，生成最终 capability |
| `grok-extensions.ts` | 封装实际使用的 `x.ai/*` RPC 和 Schema |
| `grok-history.ts` | 只读 Grok Session，投影 `HostThreadSnapshot` |
| `grok-models.ts` | Model Catalog 和 Thinking/Effort 映射 |
| `grok-usage.ts` | ACP/Grok Usage 映射 |

### 7.2 多个 ACP Harness 后的共享结构

未来接入第二个 ACP Harness 后，再抽取真正相同的 ACP Core：

```text
HarnessAdapter
├── GrokAdapter
│   ├── Grok Extensions
│   ├── Grok History
│   └── AcpAdapterCore
├── OtherAcpHarnessAdapter
│   ├── Other Extensions
│   ├── Other History
│   └── AcpAdapterCore
├── ClaudeCodeAdapter
│   └── Claude Agent SDK
└── PiAdapter
    └── Pi RPC
```

可复用的 `AcpAdapterCore` 只负责：

- stdio 子进程和 ACP 连接
- `initialize`
- `session/new` / `session/load`
- `session/prompt` / `session/cancel`
- Text、Thinking 和 Tool Updates
- Permission Request/Response
- `configOptions`
- ACP Error 和进程 Fault

每个 Harness Adapter 仍负责：

- `harnessId`
- 安装位置和启动参数
- 登录状态
- Model/Thinking/Permission 的原生语义
- 历史快照和稳定 Turn 身份
- Usage 扩展
- Fork、Rollback 和 Diff
- Harness-specific RPC

不建议现在直接创建带大量回调的 `GenericAcpAdapter`。只有一个 ACP Harness 时，通用接口很容易退化成 Grok Adapter 的参数化复制。第二个 ACP Harness 出现后，再根据两套真实实现抽取共享 Core。

## 8. Grok 能力探测

能力来源应按以下顺序汇总：

```text
initialize.agentCapabilities
             +
session/new 或 session/load 的 modes/configOptions
             +
Grok initialize._meta
             +
已验证的 x.ai/* 扩展
             |
             v
HarnessSessionCapabilities
```

原则：

- 不根据 Grok 版本号硬编码能力。
- 不根据按钮文案推断权限语义。
- 不把 Method Not Found 当成整个 Session 的协议故障。
- 对未知扩展字段进行忽略和降级。
- 只有经过响应 Schema 校验和行为验证的能力才能声明为支持。

示例：

```ts
const capabilities = {
  configuration: {
    selectModel: hasConfigCategory("model"),
    selectThinkingOption: hasConfigCategory("thought_level"),
    selectPermissionMode: hasSessionModes,
  },
  history: {
    fork: true,
    forkAcrossCwd: true,
    rollbackLastTurn: false,
  },
};
```

## 9. Fork 和 Rollback 限制

Grok 通过同一条 ACP JSON-RPC 提供 `_x.ai/session/fork`，参数使用 camelCase。本机 `grok 1.0.5` 已验证该扩展支持完整历史和 `targetPromptIndex` 部分历史 Fork。这不是标准 ACP `session/fork`，也不是 `ext_method` 信封。

codexhost 的映射是：

```text
指定 Host Turn
    -> Native Checkpoint（Grok Prompt Index）
    -> _x.ai/session/fork
    -> session/load
    -> 创建独立 Native Session
```

Grok Adapter 声明：

```ts
history: {
  fork: true,
  forkAcrossCwd: true,
  rollbackLastTurn: false,
}
```

`forkAcrossCwd` 让 Desktop 的「在新工作树中创建分支」可以把目标 cwd 交给 Grok `_x.ai/session/fork`。Adapter 不创建 Git Worktree。Grok Rewind 会截断或修改原生会话历史，而 codexhost 的 Rollback 还要求生成独立 Native Session 并保持配置。未验证满足该语义之前，不能声明 `rollbackLastTurn: true`。

## 10. Edit Diff

Grok CLI `1.0.4` 已验证会在 Tool-owned ACP `tool_call_update.content` 中提供标准 Diff Content：

- `type: "diff"`
- 绝对 `path`
- 原生 `oldText`
- 原生 `newText`

GrokAdapter 只接受成功终态 `status: "completed"` 携带的 Diff Content。进行中更新可能包含不完整的 `oldText`，失败、取消、无终态、无效、no-op 或超限数据保持 Tool-only。Adapter 使用原生前后文本确定性生成 Unified Diff，不读取修改后的文件，不检查 Git，也不根据 Tool 名称或参数推断。

`oldText: null` 是唯一可靠的新增文件信号；空字符串仍按更新处理。ACP v1 没有无歧义的删除文件表示，因此不推断 `delete`。`x.ai/git/diffs` 和 `diff_review` 属于工作区或审阅状态，不作为具体 Tool/Turn 的 File Change 证据。

恢复历史时使用同一成功终态规则重建 `HostFileChangeItem`，codexhost 不另行持久化 Diff。

## 11. 推荐的首版范围

### 支持

- Grok 安装检查和认证状态分类
- 创建、恢复、关闭 Native Session
- 流式文本和 Reasoning
- Tool 开始、更新和完成
- Tool Approval
- Turn Cancel
- Model Catalog
- 创建时 Model 和 Thinking/Effort 选择
- 运行时 Model/Thinking 切换（仅 capability 探测成功时）
- Token、Cache、Reasoning、Context 和 Cost Usage
- 从 `updates.jsonl` 读取历史快照
- 成功终态 ACP Diff Content 的实时与历史 File Change 投影
- Session Fault 和进程退出映射

### 暂不支持

- 任意历史 Turn Fork
- codexhost 语义的 Rollback Last Turn
- ACP 无法无歧义表达的删除文件 Diff
- 依赖未文档化 RPC 的功能
- 直接修改 Grok Session 文件
- 远程 WebSocket Grok Agent

## 12. 需要修改的 codexhost 模块

### 新增

```text
packages/adapters/grok/
```

### Host Runtime

- 注册 `GrokAdapter`。
- 增加 Grok 可执行文件环境变量配置。
- 增加 package metadata 和 release bundling。

### protocol-core

- 将 `grok` 加入 `ExternalHarnessId`。
- 增加 `codexhost/grok-native` Transport Model ID。
- 增加 Grok Model/Thinking/Permission 配置的编码和解码。

### renderer-extension

- 将 `grok` 加入 Agent union 和 Agent Picker。
- 增加 Grok Label、Icon 和安装链接。
- 保存每个 Agent 独立的 Model、Thinking 和 Permission 偏好。
- 根据 capability 控制 Fork、配置和 Usage UI。

### shared-contracts / harness-adapter

首版原则上不需要为 ACP 增加新协议类型。ACP 类型应留在 Grok Adapter 内。

如果产品决定展示“仅最新位置 Fork”，再修改 history capability，而不是为 Grok 特判 Renderer 行为。

### 测试

至少覆盖：

- ACP initialize 和 capability 探测
- 创建/恢复 Session
- Text/Thinking/Tool 事件投影
- Permission Request/Response
- Cancel
- Model/Thinking Catalog
- Usage 映射
- `updates.jsonl` 历史投影和稳定 Turn 身份
- 未知扩展和 Method Not Found 降级
- Grok 未安装、未认证、进程退出和协议错误

## 13. 接口选择原则

未来接入其他 Harness 时，使用以下优先级：

1. 官方、完整、稳定的 Harness SDK。
2. Harness 官方支持的标准 ACP。
3. 官方扩展 RPC，用来补充 ACP 缺失能力。
4. 原生 Session 文件，只读补充历史和元数据。
5. 不使用未公开内部协议。

“SDK 优先”只适用于完整 Harness SDK。如果所谓 SDK 只是 Model API，它不能替代 ACP，因为它不拥有 Agent Loop、工具、权限和原生 Session。

当前推荐：

| Harness | 接入方式 |
| --- | --- |
| Pi | Pi 官方 RPC |
| Claude Code | Claude Agent SDK / CLI |
| Grok CLI | 标准 ACP + Grok 扩展 + 原生 Session 只读历史 |
| 其他仅支持 ACP 的 Harness | ACP + Harness-specific Adapter |

## 14. 最终决策

Grok CLI 接入应满足以下原则：

- Grok 是独立 Harness，不能被建模为 Pi Model 或 Claude Provider。
- `GrokAdapter` 实现 codexhost `HarnessAdapter`。
- ACP 位于 `GrokAdapter` 内部，是其主要通信协议。
- 标准 ACP 承担核心实时链路。
- Grok 扩展只用于可探测、可降级的增强能力。
- Grok Session 文件只读，作为历史事实来源和 Usage 兜底。
- 只从成功终态 ACP Diff Content 投影可归因 File Change，不推断 Fork、Rollback 或删除语义。
- 接入第二个 ACP Harness 后再抽取共享 `AcpAdapterCore`。

该结构既保留 codexhost 的统一领域语义，也能复用 ACP 的标准实时能力，同时避免把不同 ACP Harness 错误地当成能力完全相同的实现。
