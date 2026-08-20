## Context

codexhost 的 Host Runtime 只依赖 `HarnessAdapter`，Pi 和 Claude Code 分别在具体 Adapter 内使用原生 RPC 和 Agent SDK。Grok CLI `1.0.3` 没有可嵌入的专用 Agent SDK，但官方提供 ACP v1 JSON-RPC stdio：`grok agent --no-leader stdio`。该接口已经覆盖 Session、Prompt、流式文本/Thinking、Tool、Approval 和 Cancel，并通过 Grok `_meta` 提供 Model/Effort 和 Usage 增强。

快速上线要求优先交付可用的 Grok Thread，不建设完整 ACP 平台，不承诺 Grok 当前无法精确表达的历史 Fork、Rollback 和 Unified Diff。

## Goals / Non-Goals

**Goals:**

- 在现有 `HarnessAdapter` 下接入独立 `grok` Harness。
- 通过 ACP stdio 打通创建、恢复、连续 Turn、流式输出、Tool、Approval 和 Cancel。
- 探测并展示 Grok Model 与 Thinking/Effort，可靠 Usage 可用时复用现有 Usage UI。
- 保持官方 Codex、Pi 和 Claude Code 路径不变。
- 用少量聚焦测试和一条可选真实冒烟验证支持快速发布。

**Non-Goals:**

- 任意历史 Turn Fork、Rollback Last Turn、Slash Commands 或 Worktree 管理。
- 在没有可靠 Unified Diff 时制造 File Change Item。
- 构建通用 `GenericAcpAdapter` 或立即抽取独立 ACP package。
- 直接调用 xAI Model API、接管 Grok 登录或修改 Grok Session 文件。
- 大规模版本矩阵、完整 Desktop E2E Gate 或真实模型测试套件。

## Decisions

### 1. ACP 位于 GrokAdapter 内部

调用关系为：

```text
Host Runtime -> HarnessAdapter -> GrokAdapter -> ACP Transport -> grok agent stdio
```

Host Runtime 只看到 codexhost 的 Session、Turn、Item 和 capability。ACP 类型与 `x.ai/*` payload 不跨出 Grok package。

替代方案：让 Host Runtime 直接消费 ACP。拒绝，因为这会把通信协议变成领域接口，并使其他非 ACP Adapter 无法保持同一语义。

### 2. 首版在 Grok package 内实现可抽取的 ACP Transport

`packages/adapters/grok` 内部分为：

- `acp-transport`：进程、JSON-RPC、initialize、Session、Prompt、Cancel、Update、Permission。
- `grok-adapter`：ACP Event 到 Host Event 的映射和 Session 生命周期。
- `grok-models` / `grok-usage`：Grok `_meta` 与 Usage 增强。
- `grok-history`：只读 Native Session 历史；若 ACP load 回放已能稳定构造 Snapshot，可延后文件读取实现。

ACP Transport 不引用 Grok Session 文件或 Host Item 类型。接入第二个 ACP Harness 时，再把已证明通用的 Transport 抽到共享 package。

替代方案：先建设独立 `acp-adapter-core`。拒绝，因为当前只有一个确定调用方，容易形成大量 Grok-specific Hook，拖慢 MVP。

### 3. 使用标准 ACP 承担实时主链路

使用 `@agentclientprotocol/sdk` 和独立 `grok agent --no-leader stdio` 进程。标准事件映射为：

```text
agent_message_chunk -> Agent Message text append
agent_thought_chunk -> Reasoning text append
tool_call           -> Tool Item start
tool_call_update    -> Tool Item update/complete
request_permission  -> Host Approval
PromptResponse      -> Turn terminal
```

未知通知被忽略；标准消息结构错误或进程异常按现有 `HarnessError` fail closed。一个 Grok HarnessSession 同一时间只接受一个 Turn。

### 4. 能力通过响应探测，不按版本硬编码

Adapter 汇总：

- `initialize.agentCapabilities`
- `initialize._meta.modelState`
- `session/new` / `session/load` 的 modes 与 `configOptions`
- 已验证的 Grok扩展字段

只有返回结构通过校验时才声明 Model、Thinking 或 Permission Mode 可选。扩展字段缺失不得破坏基础文本 Session。

### 5. MVP 历史能力保守声明

Grok 当前只支持从 Session 末尾 Fork，不能满足 codexhost 的任意 Checkpoint Fork 契约。MVP 固定声明：

```ts
history: {
  fork: false,
  forkAcrossCwd: false,
  rollbackLastTurn: false,
}
```

Session 恢复使用 Grok 原生 Session ID 和 ACP `session/load`。`readSnapshot()` 优先消费 load 回放的结构化更新；只有稳定身份不足时才只读 `updates.jsonl`。Mapping Store 不持久化 Transcript。

### 6. Tool 保真优先于功能标记

ACP Tool Call 映射为 `HostToolExecutionItem`。只有原生事件提供可验证的 path、change kind 和 Unified Diff 时才映射 `HostFileChangeItem`；否则不声明 Edit Diff。

Approval 仅暴露 Grok 原生请求实际提供的 action。Adapter 保存原生 Option ID 的内存关联，Host 不解释 Grok 权限规则。

### 7. 最小验证策略

自动化验证仅包括：

- 一个 ACP Transport fixture 测试：initialize、Prompt Update、Permission、Cancel、terminal。
- 一个 Grok Adapter 测试：事件投影、capability 降级、resume Snapshot。
- 受影响 package 的 typecheck，以及 OpenSpec validate。

另提供一个显式启用、使用合成 Prompt 的真实 Grok 冒烟命令；它不进入默认测试，也不记录内容或凭据。Renderer 和 Host 复用现有 Fake Adapter/路由行为，不复制完整测试矩阵。

## Risks / Trade-offs

- [Grok `_meta` 或扩展字段变化] -> 严格校验并关闭对应增强，保留标准 ACP 文本链路。
- [ACP load 回放没有稳定 Turn 身份] -> 只读 `updates.jsonl` 构造 Snapshot；不持久化第二份 Transcript。
- [Tool Update 缺少 Diff] -> 显示 Tool Execution，不伪造 Edit Diff。
- [认证过期] -> 映射为 `authenticationRequired`，提示用户通过 Grok CLI 登录；codexhost 不读取或记录凭据。
- [每 Session 一个进程增加资源] -> 使用 lazy startup、idle close 和现有 bounded close；MVP 不引入共享 leader。
- [测试范围小导致版本回归漏检] -> capability fail closed，并保留一条发布前真实冒烟验证。

## Migration Plan

1. 发布含 Grok Adapter 和 Renderer 入口的版本，默认继续保留现有 Agent 行为。
2. Grok 未安装或未认证时只将 Grok 标记为不可用，不影响其他 Harness。
3. 发布前显式运行一次真实 Grok ACP 冒烟验证。
4. 回滚时移除 Grok 注册和 Renderer 入口；已创建的 Grok Native Session 保留在 Grok 自有目录，不需要数据迁移。

## Resolved Questions

- 真实 Grok CLI `1.0.3` 冒烟验证确认 `session/load` 会回放足够的 user/agent/thought/tool 更新，MVP 可直接构造历史 Snapshot；`updates.jsonl` Reader 保留为未来兼容兜底，不在首版实现。
- Grok `1.0.3` 没有返回标准可写 `configOptions`，但提供并成功验证了 `session/set_model { sessionId, modelId, reasoningEffort }`；Adapter 严格验证响应后启用 Model/Thinking 选择。
