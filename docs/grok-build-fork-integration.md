# Grok Build Fork 接入背景

本文只记录 Grok Build 原生 Session Fork 的接入事实，供 codexhost 后续实现 `thread/fork` 到 Grok Adapter 的映射使用。

## 结论

Grok Build 已经把 Fork 能力暴露给外部 ACP 客户端，但它不是标准 ACP 方法，而是 Grok 自定义扩展。本机 `grok 1.0.5` 的 stdio 信封是把扩展名直接当作 JSON-RPC method，并加 `_` 前缀：

```text
ACP JSON-RPC method: _x.ai/session/fork
```

`ext_method` 是部分 ACP 实现里的内部抽象名，不是这条 stdio 线上的方法名。按 `ext_method` 发送会 Method Not Found。

因此后续接入方式应是：

```text
codexhost thread/fork
    -> GrokAdapter
    -> ACP request("_x.ai/session/fork", GrokForkParams)
    -> session/load
    -> 新的 Grok Native Session
```

Fork 能力的拥有者仍然是 Grok Harness。codexhost 只负责把 Host Thread/Turn 边界转换成 Grok 的 Native Session 参数，并保存 Host Fork 映射。

## 代码依据

本结论基于公开仓库 `https://github.com/xai-org/grok-build` 的源码检查：

- 仓库快照：`9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4`
- `xai-grok-shell` crate：`1.0.5`
- ACP handler：[crates/codegen/xai-grok-shell/src/extensions/session_admin.rs](https://github.com/xai-org/grok-build/blob/9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4/crates/codegen/xai-grok-shell/src/extensions/session_admin.rs)
- Fork 实现：[crates/codegen/xai-grok-shell/src/session/fork.rs](https://github.com/xai-org/grok-build/blob/9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4/crates/codegen/xai-grok-shell/src/session/fork.rs)
- ACP 分发：[crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs](https://github.com/xai-org/grok-build/blob/9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs)
- 官方 ACP 说明：[crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md](https://github.com/xai-org/grok-build/blob/9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)

Grok Build 是从 xAI 内部 monorepo 定期同步的公开源码，版本更新后必须重新探测方法和字段，不能只根据版本号宣称能力。

## 外部可用传输

### stdio ACP

```bash
grok agent --no-leader stdio
```

stdio 是 codexhost 当前最适合的集成方式。Grok Agent 通过 stdin/stdout 传输 ACP JSON-RPC，外部客户端不需要访问本地端口。

### WebSocket ACP Server

```bash
grok agent serve --bind 127.0.0.1:2419 --secret <token>
```

以上命令中的可执行文件是安装后的 `grok`。WebSocket 模式要求 Secret 鉴权，适合独立 Agent Server，不是 codexhost 本地适配器的首选方式。

## ACP Fork 请求

ACP 请求把 `_x.ai/session/fork` 作为 JSON-RPC method，参数直接放在 `params` 里，不要再包一层 `{ method, params }`：

```json
{
  "jsonrpc": "2.0",
  "id": "fork-1",
  "method": "_x.ai/session/fork",
  "params": {
    "sourceSessionId": "parent-session-id",
    "sourceCwd": "/workspace/project",
    "newCwd": "/workspace/project",
    "newSessionId": "optional-child-session-id",
    "newModelId": "optional-model-id",
    "targetPromptIndex": 3,
    "sessionKind": "fork"
  }
}
```

字段语义：

| 字段 | 必选 | 说明 |
| --- | --- | --- |
| `sourceSessionId` | 是 | 来源 Grok Native Session ID |
| `sourceCwd` | 是 | 来源 Session 所属 cwd，用于定位本地 Session 文件 |
| `newCwd` | 是 | 子 Session 的 cwd |
| `newSessionId` | 否 | 指定子 Session ID；省略时 Grok 生成 UUIDv7 |
| `newModelId` | 否 | 子 Session 的 Model 覆盖；省略时继承来源 Model |
| `targetPromptIndex` | 否 | 截断位置，0-based 且包含该 Prompt；省略时 Fork 当前完整历史 |
| `sessionKind` | 否 | Fork 摘要中的 Session 类型，默认是 `fork` |
| `sourceWorkspaceDir` | 否 | Worktree Fork 时记录来源 workspace |

实现中使用 camelCase wire 字段，不能发送 Rust 字段名，例如不能发送 `source_session_id`。

## ACP Fork 响应

Grok 返回的主要结果形状为：

```json
{
  "newSessionId": "child-session-id",
  "chatMessagesCopied": 12,
  "updatesCopied": 12,
  "planStateCopied": true,
  "newCwd": "/workspace/project",
  "parentSessionId": "parent-session-id",
  "newModelId": "grok-model"
}
```

`newModelId` 在没有 Model 覆盖时可以省略。

部分 ACP transport 会把扩展响应放在 JSON-RPC `result` 内，部分调用路径读取扩展原始 payload。Adapter 应同时兼容：

```json
{"newSessionId":"child"}
```

和：

```json
{"result":{"newSessionId":"child"}}
```

没有 `newSessionId`，或响应包含 `error`，必须视为 Fork 失败。

## Fork 后必须 Load

`x.ai/session/fork` 只复制并持久化 Session 数据，不启动新的 Session Actor。调用成功后，客户端必须使用标准 ACP `session/load`：

```json
{
  "jsonrpc": "2.0",
  "id": "load-child-1",
  "method": "session/load",
  "params": {
    "sessionId": "child-session-id",
    "cwd": "/workspace/project",
    "mcpServers": []
  }
}
```

正确顺序是：

```text
1. 调用 x.ai/session/fork
2. 校验 newSessionId
3. 调用 session/load(newSessionId)
4. 将后续 prompt 发给 child Session
```

如果 Fork 成功但 `session/load` 失败，Adapter 必须返回明确错误，并保留 `newSessionId` 作为诊断信息。不能把 child 当成已成功打开的 Session。

## Grok 实际复制的内容

Fork 的本地实现通过 `JsonlStorageAdapter::copy_session_data_sync` 创建新的 Session 目录并复制：

- `chat_history.jsonl`
- `updates.jsonl`
- `summary.json`
- plan state
- plan mode state
- signals
- tool state
- announcement state
- compaction segments
- 被复制 update 引用的 compaction checkpoints

子 Session 的 summary 会写入：

- 新的 Session ID
- 新的 cwd
- `parent_session_id`
- `forked_at`
- `session_kind`，默认 `fork`
- 新 Model 或继承来源 Model

这是 Harness-owned 的原生复制语义。codexhost 不应自己复制或修改 `~/.grok/sessions` 中的文件来实现 Fork。

## 历史位置 Fork

Grok 的底层 ACP Fork 请求支持 `targetPromptIndex`：

- `0` 表示保留第一个 Prompt 边界以内的历史。
- 参数是 0-based 且包含目标 Prompt。
- chat history 会按该位置截断。
- updates 会按同一位置复制。
- 复制后的 Session 是新的独立 Native Session。

因此不能再把 Grok 描述成“只能 Fork 当前末尾”。更准确的描述是：

> Grok Build 的底层 `x.ai/session/fork` 支持按 Native Prompt Index 进行完整或部分历史 Fork；当前官方 TUI 的 `/fork --at <turn>` 命令仍明确拒绝 `--at`，CLI UI 尚未把该参数暴露出来。

对 codexhost 而言，关键工作是把 Host 的 Fork 边界转换成 Grok 的 `targetPromptIndex`：

```text
Host Turn ID
    -> Grok Native Turn / Prompt Index
    -> targetPromptIndex
    -> x.ai/session/fork
```

不能直接把 Host Turn ID 当作 `targetPromptIndex`。必须从 Adapter 维护的历史映射中查找，并在映射不存在、跨 Session 或边界未完成时 fail closed。

## cwd 和 Worktree

Grok 请求明确区分 `sourceCwd` 和 `newCwd`，因此底层 Fork 数据结构支持将 child 写入另一个 cwd。普通 Fork 会重写复制历史中的 cwd 路径；Worktree Fork 可通过 `sourceWorkspaceDir` 保留原始 workspace 语义。

codexhost 首版应分别验证：

1. 同 cwd、无 Worktree 的 Fork。
2. 不同 cwd 的 Fork。
3. Worktree Fork。
4. 来源 Session 是 Worktree 的再次 Fork。

Grok Adapter 将 Desktop 准备好的目标 cwd 传给 `newCwd`。目录不同时使用 `sessionKind: "worktree"`，并设置 `sourceWorkspaceDir`（若来源已是 Worktree，则继承其原始 workspace）。`sourceWorkspaceDir` 不是任意 cwd 安全校验的替代品，目标目录仍必须由 Host 侧校验。Adapter 不创建或删除 Git Worktree。

## 官方 CLI 与 ACP 的差异

官方 CLI 已支持：

```bash
grok --resume <session-id> --fork-session
grok --continue --fork-session
grok --resume <session-id> --fork-session --session-id <child-id>
```

官方 `/fork` 还支持：

```text
/fork
/fork --worktree
/fork --no-worktree
/fork <directive>
```

但官方 TUI 当前拒绝：

```text
/fork --at <turn>
```

这只说明 CLI UI 暂未开放该参数，不代表 ACP handler 不支持 `targetPromptIndex`。

## SDK 和其他 RPC 的边界

### ACP SDK

可以使用官方 ACP SDK 建立连接并发送自定义 ACP 请求，例如 TypeScript 的 `@agentclientprotocol/sdk`。但 SDK 只提供 ACP 通信能力，不会提供 Grok 专用的 `x.ai/session/fork` 类型或业务语义。

Adapter 需要自行定义：

- `GrokForkParams`
- `GrokForkResponse`
- 参数运行时校验
- 响应运行时校验
- Method Not Found 和业务错误映射

### Grok 内部 Rust API

源码中有内部 Rust API：

```rust
xai_grok_shell::session::fork_session(
    request: ForkSessionRequest,
    agent_id: &str,
    auth_manager: Option<Arc<AuthManager>>,
) -> io::Result<ForkSessionResponse>
```

`ForkSessionRequest` 和 `ForkSessionResponse` 也从 `xai-grok-shell::session` re-export，但这属于 Grok Build 内部 crate API，不是稳定的跨语言公共 SDK。codexhost 的 TypeScript Adapter 不能依赖它。

### 内部 Sandbox REST Client

源码还有内部 HTTP client：

```text
POST {base_url}/sandbox/sessions/fork
```

它位于 `SandboxClient::fork_session`，使用 xAI 内部认证 Header 和 `SandboxForkRequest` / `SandboxForkResponse`。仓库没有把它作为公开、稳定的 Grok Build Agent API 文档发布，因此 codexhost 不应直接依赖该 endpoint。

### Workspace RPC

`xai-grok-workspace-types` 的 `SessionLifecycleRequest::Fork` 是本地 Workspace/Subagent 生命周期 RPC，主要复制工具配置、环境、能力和 Worktree 运行上下文。它不是上面 `x.ai/session/fork` 的持久对话 Session Fork API，不能用来替代 Grok Native Session Fork。

## codexhost Adapter 接入要求

### Transport 层

在 `packages/adapters/grok/src/acp-transport.ts` 增加 Grok 专用扩展调用能力，或者由 Grok Adapter 持有一个只允许 Grok 使用的扩展请求方法：

```ts
const response = await connection.request<GrokForkResponse, GrokForkParams>(
  "_x.ai/session/fork",
  params,
);
```

实际 SDK 的泛型签名以当前依赖版本为准，但 wire method 必须是 `_x.ai/session/fork`，参数必须是 camelCase 且不再包一层。

### Adapter 层

Fork 流程至少需要：

1. 从 Host Fork 请求解析来源 Thread、目标 cwd 和 Fork 边界。
2. 从 Grok Native history 找到来源 Session ID。
3. 从 `grok-history.ts` 的 Host Turn 映射得到 `targetPromptIndex`。
4. 校验目标 cwd、Session ID 和边界。
5. 调用 `x.ai/session/fork`。
6. 校验 `newSessionId` 和父子关系。
7. 对 child 执行 `session/load`。
8. 关闭或回收旧 Transport，建立 child Transport 状态。
9. 持久化 Host Thread 的 `forkSource`，包括来源 Host Thread ID 和来源 Host Turn ID。
10. 确认 child 的首个历史快照与目标边界一致后，再向 Host 返回成功。

### Capability

当前 Grok Adapter 声明：

```ts
history: {
  fork: true,
  forkAcrossCwd: true,
  rollbackLastTurn: true,
}
```

`forkAcrossCwd` 只表示可以把 Native Session 绑到 Desktop 已准备好的目标 cwd。Git Worktree 的创建仍由 Desktop 负责。如果 Grok 返回 Method Not Found、Prompt Index 映射失败，或 `session/load` 后历史不一致，单次 Fork 失败关闭，不把 child 当成已打开的 Session。

Fork 支持不等于 Rollback 支持。Grok 的「修订上一条」使用 `_x.ai/rewind/execute` 截断当前 Native Session，不创建 child Session。不能因为 Fork 有 `targetPromptIndex` 就把 last-turn 做成 Fork。

## 必须添加的测试

### 协议测试

- JSON-RPC method 是 `_x.ai/session/fork`。
- 不使用 `ext_method` 外层 envelope。
- 请求字段使用 camelCase。
- `targetPromptIndex = 0` 正确传递。
- 可选字段省略和覆盖正确。
- 顶层响应和 `result` 包装响应都能解析。
- 缺少 `newSessionId` 时失败。
- Grok 返回 Method Not Found 时降级为不支持 Fork，而不是污染整个 Session。

### 语义测试

- 完整历史 Fork。
- 指定 `targetPromptIndex` 的部分历史 Fork。
- child 拥有新的 Native Session ID。
- child summary 记录 `parent_session_id`。
- child 的 chat history 和 updates 不超过目标边界。
- Fork 后执行 `session/load`。
- child 首个 Prompt 能正常执行。
- 来源 Session 不被修改。
- Fork 失败时不创建错误的 Host mapping。
- Fork 成功但 load 失败时返回可诊断错误。
- 不同 cwd 和 Worktree 行为经过单独验证。

### 版本兼容测试

每次 Grok Build 版本变化后，至少重新验证：

- `initialize` 是否仍声明 ACP v1。
- `_x.ai/session/fork` 是否仍可路由。
- Fork 参数字段和响应字段。
- `targetPromptIndex` 的截断边界。
- `session/load` 后的历史回放。
- Native history 中的 Prompt/Turn 映射。

## 最终边界

可以依赖：

- 标准 ACP 的 `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`。
- Grok ACP 扩展 `_x.ai/session/fork`，但必须做运行时 Schema 校验。
- Grok Native Session 文件的只读历史，用于身份和边界映射。

不能依赖：

- 标准 ACP 自带的通用 Fork API，因为标准 ACP 没有统一的 Fork 方法。
- Grok 专用公共 Agent SDK，因为当前未发现稳定的对外 SDK。
- 内部 Sandbox REST endpoint。
- 直接修改 `~/.grok/sessions` 实现 Fork。
- `xai-grok-workspace` 的 Workspace/Subagent Fork 代替对话 Session Fork。

对 codexhost 来说，正确的实现判断是：

> Grok Build 的 Fork 能力可以通过 ACP 外部接入；外部接入点是同一条 ACP JSON-RPC 上的 `_x.ai/session/fork`，不是公共 Grok SDK，也不是标准 ACP 原生方法。该扩展支持完整或按 Native Prompt Index 的部分历史 Fork，Fork 成功后必须再通过 `session/load` 建立 child Session。
