# ACP 实现现状与 T3 Code 源码调研

## 记录范围与版本

- 记录日期：2026-11-16。
- codexhost：以本地工作树为准，HEAD 为 `26c3460ed28e331bea7761901ddccab3882a6522`；工作树包含未提交的 Antigravity 历史读取和只读进程池改动。本文不表示这些改动已发布或已进入正在运行的 Host。
- 外部项目：仅核对了 [T3 Code（pingdotgg/t3code）](https://github.com/pingdotgg/t3code)，固定提交为 `1f698f01d9fbbc5858963c1fe81d4b3e00783a5d`。
- T3 结论来自源码和仓库文档，没有启动 T3，也没有对其各 Harness 做运行实测。
- 本文记录实现、已有观察及证据边界，不包含公共层设计、迁移步骤或开发任务。[ACP 层后续开发说明](acp-layer-follow-up.md)是另一份方案材料，不是本文的实施状态。

## 1. codexhost 的 ACP 接入结构

### 1.1 公共契约与协议实现

当前结构为：

```text
Host Runtime
  -> HarnessAdapter / HarnessSession
    -> 具体 Harness Adapter
      -> 具体 ACP Transport / Client
        -> @agentclientprotocol/sdk
          -> 原生 Harness ACP 进程
```

[`packages/harness-adapter`](../../packages/harness-adapter/src/index.ts)提供协议无关的公共契约，以及输出通道、交互校验、Usage 解析等工具。各插件通过这些契约向 Host 暴露能力。

当前没有独立的通用 ACP 实现包，也没有用于任意 ACP 命令接入的 `GenericAcpAdapter`。各 ACP Harness 已复用官方 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 和 `ndJsonStream`，并非各自从零实现 JSON-RPC 编解码。

重复实现主要位于官方 SDK 与 `HarnessAdapter` 之间。

### 1.2 ACP Harness 清单

下表对应[预装插件清单](../../scripts/release/harness-plugins.json)中的 ACP 接入。进程关系描述可写会话的主要执行路径，不表示每条持久化历史都占用进程，也不包含工具、MCP 或 Subagent 额外创建的进程。

| Harness | ACP 连接实现 | 当前可写会话进程关系 |
| --- | --- | --- |
| Antigravity | [`antigravity/src/acp-transport.ts`](../../packages/adapters/antigravity/src/acp-transport.ts) | 每个可写会话独立 Transport／进程 |
| Grok | [`grok/src/acp-transport.ts`](../../packages/adapters/grok/src/acp-transport.ts) | 每会话独立 Transport／进程 |
| Kimi Code | [`kimi-code/src/acp-transport.ts`](../../packages/adapters/kimi-code/src/acp-transport.ts) | 每会话独立 Transport／进程 |
| Kiro CLI | [`kiro-cli/src/acp-transport.ts`](../../packages/adapters/kiro-cli/src/acp-transport.ts) | 每会话独立 Transport／进程 |
| Cursor CLI | [`cursor-cli/src/transport.ts`](../../packages/adapters/cursor-cli/src/transport.ts) | 每会话独立 Transport／进程 |
| Devin | [`devin/src/transport.ts`](../../packages/adapters/devin/src/transport.ts) | 每会话独立 Transport／进程 |
| CodeBuddy | [`codebuddy/src/acp-client.ts`](../../packages/adapters/codebuddy/src/acp-client.ts) | 每会话独立 ACP Client／进程 |
| WorkBuddy | [`workbuddy/src/workbuddy-adapter.ts`](../../packages/adapters/workbuddy/src/workbuddy-adapter.ts) | 复用 CodeBuddy Adapter／ACP Client，每会话独立进程 |

WorkBuddy 继承 `CodeBuddyAdapter`，通过 Runtime Profile、启动命令及产品模型目录处理差异。因此，“每个 ACP Harness 都有完全独立的一套实现”并不准确。

Qwen Code 当前使用官方 `@qwen-code/sdk`，不属于上表。OpenCode、Copilot、DeepSeek Harness 等在 codexhost 中也不是通过上述 ACP Transport 接入。

### 1.3 多处出现的职责

| 职责 | 可核对的实例 |
| --- | --- |
| 创建子进程、连接 stdio、初始化、处理进程退出 | 上表各 Transport／Client |
| 控制请求超时、请求与连接故障竞争、关闭资源 | Cursor 与 Devin 的 `#bounded`、`prompt`、关闭路径；其他 Transport 有各自实现 |
| Session 创建／加载、Prompt、Cancel、配置更新 | Cursor、Devin、Antigravity 等 Transport |
| `sessionUpdate` 分流、历史回放缓冲、审批回调 | Cursor、Devin、Kimi、Antigravity 等 Transport／Session |
| `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update` 映射 | [`antigravity/src/acp-projection.ts`](../../packages/adapters/antigravity/src/acp-projection.ts)、[`cursor-cli/src/projection.ts`](../../packages/adapters/cursor-cli/src/projection.ts)、[`devin/src/projection.ts`](../../packages/adapters/devin/src/projection.ts)、[`codebuddy/src/projection.ts`](../../packages/adapters/codebuddy/src/projection.ts)，以及 Grok、Kimi、Kiro 的 Transport／投影代码 |

Cursor 与 Devin 的 Transport 都包含请求限时、启动失败处理、流式 Prompt 与故障 Promise 竞争，以及 POSIX 进程组／Windows `taskkill` 的关闭处理。这些职责在两个文件中分别实现。

这些实例证明存在重复职责，不表示所有实现逐行相同，也不表示其行为可以不加区分地互换。没有进行重复代码比例或可删除行数测量。

### 1.4 已存在的 Harness 差异

- Cursor 使用原生 `cursor/list_available_models` 扩展，并处理参数化模型目录；启动参数还涉及原生 Run Everything 配置。
- Devin 处理 `cognition.ai/revert` 等能力字段和扩展请求。其 Transport 记录原生 Session 的进程锁约束，历史重放使用同一连接；认证还包含原生方法及 `_meta.api_key`。
- Antigravity Transport 区分 `session/load` 与 `session/resume`，并分别处理 Session 关闭和整个 Transport 关闭。
- CodeBuddy／WorkBuddy 共用实现，但保留不同启动命令、Runtime Profile、命令目录和模型目录行为。
- 各 Harness 对模型、权限、Usage、Subagent 和历史身份的处理分布在对应插件中；相同 ACP 消息类型不意味着这些业务语义全部相同。

## 2. ACP 连接复用与多会话执行的证据范围

### 2.1 Antigravity 本地实现

本地工作树的 [`AntigravitySnapshotReaderPool`](../../packages/adapters/antigravity/src/snapshot-reader-pool.ts)复用已初始化的只读 `agy acp` 进程：

- 池按命令、权限设置及环境分组。
- 只读环境移除 `CODEXHOST_THREAD_ID`；其余环境参与分组。
- 同组读取通过队列串行执行 `session/load`。
- 一次读取完成后关闭 Native Session，保留可复用的进程。
- 只读池与可写会话的 Transport 分离。

这属于跨历史会话的串行读取复用，不是多个可写会话共用当前 Adapter Transport。该 Transport 仍持有单个当前 Session ID 和活动 Prompt 状态。

### 2.2 已有原生实验观察

前期本地实验对 agy 1.5.9 使用同一 ACP 连接创建两个合成可写 Session，观察到：

- 两个 Session 的文本 Prompt 可以并发完成，输出归属分别正确。
- 对 Session A 发送取消时，Session B 可以继续并完成。

上述观察没有覆盖并发工具调用、审批、提问、后台任务和全部关闭场景，也不是共享写连接的 Adapter 实现或完整回归测试。它不能证明其他 ACP Harness 具有相同的并发行为。

### 2.3 概念与未测量项

- 共享 ACP 代码与共享原生进程是两件事：多个独占进程可以由同一份公共实现管理。
- 原生接口存在 Session ID，不足以证明所有操作都具备跨会话隔离能力。
- 单进程先后切换 Session，不等于多个 Session 同时执行。
- 本次没有对各 Harness 做统一 RSS／PSS、CPU 或启动成本测量，没有可用于量化共享收益的数据。

## 3. T3 Code 的公共 ACP 实现

### 3.1 分层与调用方

T3 源码使用的 `Provider`／`Driver` 名称包含 Agent Harness 接入含义；这里保留其原生标识，不将其等同于 codexhost 术语中的模型 Provider。

```text
T3 ProviderAdapter
  -> provider-acp 的 makeAcpAdapterV2
    -> AcpAdapterV2Flavor 注入具体 Agent 差异
    -> AcpSessionRuntime
      -> ACP 协议连接与原生进程
```

固定提交中的主要文件：

- [公共 ACP Adapter][t3-acp-adapter]：标准会话操作、事件投影、交互和生命周期处理。
- [AcpSessionRuntime][t3-acp-runtime]：子进程、ACP 连接、初始化、Session 请求、事件及资源清理。
- [AntigravityAdapterV2][t3-agy]：通过 `makeAcpAdapterV2` 接入，构造 Antigravity Flavor。
- [ACP Registry Adapter][t3-registry]：通过同一公共 Adapter 接入 Registry Agent 和本地 ACP 命令。

Grok、Kiro、FX 的专用 Adapter 同样调用 `makeAcpAdapterV2`。

### 3.2 Agent 差异的表达

`AcpAdapterV2Flavor` 包含具体 Agent 的 Runtime 工厂、能力声明和可选处理函数，例如：

- 消息与工具更新规范化。
- 模型选择、原生权限模式和配置项映射。
- 附件 Prompt 构造。
- 权限请求选项、问题提取及响应。
- 私有扩展注册。
- Subagent、后台任务、Usage 和取消时序处理。

这些差异没有全部消失，而是通过 Flavor 与 Agent 专用文件接入公共实现。

固定提交的公共 `adapter.ts` 为 9,981 行，`AcpSessionRuntime.ts` 为 3,025 行，包含注释和空行。行数只描述源码规模，不构成质量评价或可复用比例。

### 3.3 通用 ACP 接入入口

[T3 ACP 用户文档][t3-acp-doc]描述了两个入口：

- 从 ACP Registry 选择 Agent。
- 配置本地 ACP 可执行文件和参数。

通用接入使用 Agent 自己的模型、工具和认证。该路径支持 ACP v2 preview，并为尚未迁移的 Agent 协商 ACP v1。它不要求所有 Agent 都拥有专用顶层 Driver；Registry 内仍有 Copilot、Kimi、OMP、Devin、Droid 等专用兼容代码。

## 4. T3 的进程与会话关系

[内置 Driver 注册表][t3-drivers]包含 10 个专用 Driver 和一个通用 ACP Registry Driver。下表描述受管执行路径；外部 OpenCode Server 的进程所有权不属于 T3。

| Driver／路径 | 固定提交中的实现 |
| --- | --- |
| Codex | 原生 app-server 承载多个 Thread；能力声明允许多个 Provider Thread 共用 Session |
| OpenCode 2 | 同一实例共享一个 Server，服务多个目录和 Thread |
| Cursor | 在 T3 Server 进程内加载 `@cursor/sdk`，通过 `Agent.create`／`Agent.resume` 创建独立 Agent 对象，不是每会话启动 Cursor CLI ACP |
| Claude Code | 每会话独立 SDK Query／CLI 进程 |
| OpenCode 1 | 每 Thread 独立受管聊天 Server；目录探测和文本生成可共享实例拥有的辅助 Server |
| Antigravity | 公共 ACP Adapter，每会话独立 Runtime／进程 |
| Grok | 公共 ACP Adapter，每会话独立 Runtime／进程 |
| Kiro | 公共 ACP Adapter，每会话独立 Runtime／进程 |
| FX | 公共 ACP Adapter，每会话独立 Runtime／进程 |
| Pi | 每会话独立原生 RPC 进程 |
| Muse | 每会话独立原生 SDK Host 进程 |
| ACP Registry／本地 ACP 命令 | 公共 ACP Adapter，每会话独立 Runtime／进程 |

T3 的 `supportsMultipleProviderThreadsPerSession` 在 Codex、OpenCode 2 中为 `true`；在 Claude、Pi、Muse、Cursor、OpenCode 1 和通用 ACP 中为 `false`。

该字段表示 T3 的 Provider Session 是否承载多个 Provider Thread，不直接等于操作系统进程是否独占。Cursor 是进程内 SDK，但其 Adapter Session 仍只绑定一个 Thread。

### 4.1 OpenCode 的隔离事实

[T3 的进程与账号隔离文档][t3-isolation]明确记录：

- OpenCode 的 MCP 注册按目录作用，而 T3 的 MCP 连接按 Thread 作用。
- OpenCode 1 的受管聊天路径使用独立 Server，避免同目录 Thread 覆盖彼此的 MCP 连接。
- OpenCode 2 每个 Thread 注册独立的 `t3-code-<thread>` MCP 入口，并通过 Session 权限规则拒绝其他 Thread 的入口。
- OpenCode 原生 `always` 批准影响项目范围。T3 的自动 full-access 响应使用 `once`；OpenCode 2 的会话级批准也使用 `once`，另存 T3 自己的会话规则。

这些是该项目对 OpenCode 的已记录约束，不能作为其他 Agent 选择独占进程的已证实动机。

### 4.2 生命周期

- [OpenCodeServerOwner][t3-server-owner]通过借用计数管理受管 Server；借用者归零后等待 30 秒关闭，重新借用会取消待关闭任务。
- [ProviderSessionManager][t3-session-manager]的默认空闲超时为 30 分钟，包含后台工作检查，以及共享运行时中单个 Thread 的空闲卸载处理。
- 公共 ACP Runtime 在自己的生命周期作用域中创建和清理进程。公共 ACP Adapter 并没有因代码共用而自动获得跨会话共享写进程的行为。

## 5. 调研边界

- 已核对的是 codexhost 本地实现和上述 T3 固定提交，不代表两个项目未来版本的行为。
- T3 的共享／独占声明描述其集成选择，不能据此断言底层 Harness 不支持另一种进程拓扑。
- 没有通过本次源码阅读验证所有 Harness 的原生并发能力。
- 没有将 T3 的通用 ACP 能力与 codexhost 的历史身份、Fork、Rollback、Usage、Subagent 等契约逐项做等价性验证。
- 没有进行公共 ACP 层或共享写进程的代码改造。

[t3-drivers]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/apps/server/src/provider/builtInDrivers.ts
[t3-acp-adapter]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/packages/provider-acp/src/server/adapter.ts
[t3-acp-runtime]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/packages/provider-acp/src/server/AcpSessionRuntime.ts
[t3-agy]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts
[t3-registry]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/packages/provider-acp-registry/src/server/adapter.ts
[t3-acp-doc]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/docs/user/providers-acp.md
[t3-isolation]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/docs/internals/providers.md
[t3-server-owner]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/packages/provider-opencode/src/server/OpenCodeServerOwner.ts
[t3-session-manager]: https://github.com/pingdotgg/t3code/blob/1f698f01d9fbbc5858963c1fe81d4b3e00783a5d/apps/server/src/orchestration-v2/ProviderSessionManager.ts
