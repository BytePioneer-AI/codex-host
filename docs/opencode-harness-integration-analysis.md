# OpenCode Harness 接入调研

> 调研基线：OpenCode `v1.18.25`（2026-08-28 发布）。本文只把 OpenCode 官方仓库、官方文档、官方 Release、官方 npm 包和本机实际运行结果作为能力证据。

本文同时记录接入设计、官方能力证据和 `codex/opencode-harness` 分支的第一版实现。下文单独区分“官方接口存在”“当前已实现”“当前已对外声明”和“仍需真实 Gate”，避免把类型或 endpoint 的存在误报成平台能力。

## 结论

OpenCode 最原生的 codexhost 接入方式不是解析 TUI，也不是只调用 `opencode run --format json`，也不应把 ACP 当作唯一能力面。建议由 codexhost 管理一个只监听 loopback 的 `opencode serve` 子进程，并通过固定、已测试版本的 `@opencode-ai/sdk/v2` 连接它：

- 第一阶段使用 SDK 暴露的现行 Session API、SSE、Question、Permission、Diff、Fork、Revert、Compact 和 Abort，完整投影到 codexhost 的 Harness 契约。
- `@opencode-ai/sdk/v2` 同时包含现行 API 和 `client.v2.*`，因此后续无需更换传输层即可逐项启用原生 V2 能力。
- OpenCode V2 的 durable event、按 Session replay、queue/durable steer、幂等 prompt admission、staged revert 等能力很适合平台集成，但官方自己的 V2 parity 清单仍有关键缺口，应先做成实验性 capability，不能直接替换现行执行链。当前活动 Turn steering 使用已验证的现行 V1 prompt 路径，不依赖 V2 delivery。
- ACP 可以作为标准协议兼容路径或快速 MVP，但它本身也是 OpenCode HTTP SDK 的一次降维投影，会丢失原生 Question、部分 Session 控制和更完整的事件。
- OpenCode Plugin 的 `experimental_workspace` 是值得利用的“平台能力”：未来可用一个可选插件把 codexhost 管理的本地或远程 workspace 注册给 OpenCode；基础 Harness Adapter 不应依赖这个实验接口。

推荐的目标运行时结构：

```text
codexhost host-runtime
  └─ OpenCode Adapter
      ├─ 启动/监管 opencode serve
      ├─ health + version + OpenAPI capability handshake
      ├─ OpenCodeServerTransport（显式 executable、loopback、Basic Auth）
      ├─ @opencode-ai/sdk/v2 client
      │   ├─ client.session.*       现行 Session 执行与控制
      │   ├─ client.event.*         SSE 实时事件
      │   ├─ client.question.*      原生 Question
      │   ├─ client.permission.*    原生 Approval
      │   └─ client.v2.*            实验性 durable/replay/queue 能力
      └─ codexhost HarnessSession / HarnessEvent / Interaction 映射
```

## 当前分支的落地状态

当前分支已经注册独立的 `opencode` Harness，生产主路径是：

```text
OpenCodeAdapter
  -> OpenCodeServerConnection
     -> opencode serve --hostname=127.0.0.1 --port=0
     -> 每次启动生成随机 Basic Auth
     -> bounded stderr + process-tree shutdown + 异常退出后可重启
  -> SdkOpenCodeTransport
     -> @opencode-ai/sdk/v2/client
     -> Session API + SSE
```

实现位于 [`packages/adapters/opencode`](../packages/adapters/opencode)，并已接入：

- Host Runtime 的默认 Adapter composition、`CODEXHOST_OPENCODE_COMMAND` 显式命令和发布 Bundle closure；
- Protocol Core 的 `codexhost/opencode-native` carrier；
- Renderer 的 Agent picker、Model/Thinking 草稿状态、Thread ownership 恢复和 OpenCode 图标；
- Text/Reasoning streaming、Tool lifecycle、Question、Approval once/deny、Cancel、Usage、完整 Diff、Native command、Compact、Model 与 variant；
- 活动 Turn steering：复用现行 `promptAsync()` admission，在同一 Host Turn 中串行接受调整，并在恢复时保持逻辑 Turn、Diff、Fork 与 rollback 边界；
- transcript Snapshot、精确 Checkpoint Fork、SSE 重连后的 status/messages/pending interaction 对账；
- conversation-only 的 distinct `rollbackLastTurn` Session；已用 loopback 假模型驱动 OpenCode `1.18.4` 的真实 `edit` Tool，验证 Git-backed Diff、精确历史派生、来源 Session 隔离和工作树保持不变。

当前明确不对外声明：

- OpenCode `executionPolicy=default` 保留原生 Question 和 Approval once/deny；
- 提供 `default`、`ask`、`allow` 三种 Permission Mode；`ask`/`allow` 使用 Session 原生 PermissionRuleset 并跨 Resume 保留，`allow` 标记为危险模式；
- `executionPolicy=unattended-full-access` 要求 `allow` Permission Mode，并继续在每个受管 Server 的进程环境中注入 OpenCode 原生 `permission: "allow"`；不使用共享 `always` 规则；
- `build`/`plan` 是 Agent，不会冒充 Permission Mode；
- cross-cwd Fork、Subagent identity/transcript；
- V2 durable replay、queue/durable steer、幂等 admission 和 staged revert；
- `experimental_workspace` Plugin。它是本文找到的平台扩展点，但仍属于后续实验增强。

生产 Bundle 只导入 `@opencode-ai/sdk/v2/client`。没有使用 SDK 顶层 `v2` 入口，因为后者会把 SDK 自带的 `createOpencodeServer()` 和 `cross-spawn` 一并打包，重复 codexhost 已拥有的进程监管责任。

当前验证结果如下。活动 Turn steering 变更已重新执行适用的 TypeScript、Vitest、lint、格式与 OpenSpec 检查；Release Bundle、真实 smoke、Git Gate 与进程清理保留既有基线，本次未重复执行：

| 验证 | 结果 | 时点 |
| --- | --- | --- |
| 全仓库 TypeScript build + test typecheck | 通过 | 本次重跑 |
| steering contract/transport/Adapter/history/Host 聚焦测试 | 297 项通过 | 本次重跑 |
| 全仓库 Vitest（含既有 Harness 与 Renderer） | 2,425 项通过，9 项按环境跳过 | 本次重跑 |
| ESLint + package boundary audit | 通过 | 本次重跑 |
| Prettier + Rust format check | 通过 | 本次重跑 |
| OpenSpec strict validation | 通过 | 本次重跑 |
| Release Host Bundle 审计与真实 build | 通过 | 既有基线，本次未重跑 |
| 隔离 OpenCode `1.18.25` real smoke | inspect、create、read、command list、close、resume 通过；没有调用付费/外部 Model | 既有基线，本次未重跑 |
| Git-backed real Gate | loopback 假模型驱动原生 `edit` Tool；stream、Tool、Diff、精确 Fork、distinct rollback、来源 Session 与工作树保持不变通过 | 既有基线，本次未重跑 |
| 进程清理 | real smoke 结束后没有残留受管 `opencode serve` 进程 | 既有基线，本次未重跑 |

真实 smoke 还发现并修正了 macOS `/var` 与 `/private/var` realpath 别名导致的 Resume/Fork cwd 误拒绝。尚未执行 Desktop 启动，也没有覆盖本机 OpenCode `1.18.4`。

## 版本与运行验证

本机原有 `opencode`：

```text
/Users/chongwen.zhang/.nvm/versions/node/v24.18.0/bin/opencode
1.18.4
```

调研时官方最新版本为 `1.18.25`：

- [GitHub Release v1.18.25](https://github.com/anomalyco/opencode/releases/tag/v1.18.25)
- npm `latest`：`opencode-ai@1.18.25`
- npm `latest`：`@opencode-ai/sdk@1.18.25`
- npm `latest`：`@opencode-ai/plugin@1.18.25`

最新版只下载到临时目录进行验证，没有覆盖本机 `1.18.4`：

- 官方 macOS arm64 CLI：`/private/tmp/codexhost-opencode-v1.18.25-UZLrC3/extracted/opencode`
- 下载 ZIP SHA-256：`606b09722d98069605e16037fb8c3c7c8ebbfed9ba713079a5efb2e5b065ae27`
- 官方源码 tag：`v1.18.25`，commit `cb7d8b2f5e44876ef98b661dc10590c915af3a9f`
- 隔离的 Server 数据和 OpenAPI 探测目录：`/tmp/opencode-runtime.SUbAqe`

用临时版在 `127.0.0.1:49096` 启动 Server 后实测：

| 验证项 | 结果 |
| --- | --- |
| `GET /global/health` | `healthy: true`，版本为 `1.18.25` |
| `GET /api/health` | `healthy: true` |
| `GET /doc` | OpenAPI `3.1.0`，共 162 个 path |
| 现行 API | 同时存在 `/session` 与 `/event` |
| 原生 V2 API | 同时存在 `/api/session` 与 `/api/event` |
| `/event` | SSE，首个事件为 `server.connected` |
| `/api/event` | SSE，首个事件为 `server.connected`，并发送 heartbeat comment |
| Session 持久化 | 创建 V1、V2 Session，重启 Server 后均可重新读取 |
| 数据库 | SQLite：`data/opencode/opencode.db` |

还做了两组兼容性实测：

- `@opencode-ai/sdk@1.18.25` 连接本机 OpenCode Server `1.18.4` 时，health、agents、providers、Question list、Permission list 均成功。因此通用 Adapter 能力应以 Server health、OpenAPI 和关键方法探测决定，不能因 patch 版本不同整体拒绝运行；但活动 Turn steering 依赖 caller Message ID、排序和 busy-loop 语义，当前只在精确验证的 `1.18.25` 上声明，其他版本继续使用原生生成的 root Message ID。
- 在隔离数据目录中，用上述新 SDK 向 `1.18.4` Session 写入两条 `noReply` 用户消息，再以第二条 message ID Fork；源 Session 保留两条，派生 Session 只含第一条。临时 Session 随后已删除。这证明精确 message boundary Fork 在旧 Server 上也可用，但还没有证明所有目标最低版本都可用。

`1.18.4` 与 `1.18.25` 的 `opencode acp` 均通过了真实 `initialize` 探测。`1.18.25` 还用 `@agentclientprotocol/sdk@1.3.0` 验证了 `session/list`、`session/new`、配置选项和 `session/close`；配置选项包括 Model、`build`/`plan` Agent mode，以及模型提供时的 effort/variant。

官方 OpenAPI 定义见 [`packages/sdk/openapi.json`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/sdk/openapi.json)。实测 Server 已停止，未留下监听进程。

## codexhost 现有 Harness 是怎样接入的

codexhost 没有让 Renderer 直接理解某个 Harness 的 wire protocol。所有外部 Harness 最终都实现 [`HarnessAdapter` / `HarnessSession`](../packages/harness-adapter/src/text-session.ts)，再输出统一的 Turn、Item、Question、Approval、Usage、Subagent、Checkpoint 和历史 Snapshot；注册与路由分别位于 [`adapter-composition.ts`](../packages/host-runtime/src/adapter-composition.ts) 和 [`model-routing.ts`](../packages/protocol-core/src/model-routing.ts)。

当前仓库有五种有代表性的接入形态：

| Harness | 原生入口 | codexhost 当前做法 | 关键特征 |
| --- | --- | --- | --- |
| Pi | `pi --mode rpc` | 每个活跃 Session 管理一个 stdin/stdout 私有 JSON RPC 子进程；结合 Session 文件读历史、Fork、Rollback | Model/Thinking、Usage、Tool、Extension UI Question；没有可选 Permission Mode |
| OMP | `omp --mode rpc` | Pi 同类的私有 RPC Adapter，但有自己的 Session/历史协议 | 在 Pi 类能力上增加 Subagent observe/transcript |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | 通过 SDK `query()` 启动明确路径的 Claude Code；消费 partial message，并用 `canUseTool` 处理 Question/Approval | 当前最直接的 SDK 接入；动态 Model/Thinking/Permission、interrupt、Subagent、Usage；历史/Fork 还要结合原生 transcript |
| Grok | `grok agent --no-leader stdio` | `@agentclientprotocol/sdk` 连接 stdio 上的标准 ACP；Grok 私有扩展补齐 Fork、Rewind、历史、Compaction 等 | 标准 ACP 负责 prompt/update/permission/cancel，私有扩展提高原生保真度 |
| DeepSeek Harness | `dsh web` / loopback endpoint | 官方 Host API 包 + loopback HTTP/WebSocket；必要时由 Adapter 启动 Web 进程 | 进程拓扑最接近 OpenCode Server，但当前能力声明不含 Fork、Rollback、Question/Approval |

对应源码证据：

- Pi：[`pi-rpc-session.ts`](../packages/adapters/pi/src/pi-rpc-session.ts)、[`pi-adapter.ts`](../packages/adapters/pi/src/pi-adapter.ts)
- OMP：[`omp-rpc-session.ts`](../packages/adapters/omp/src/omp-rpc-session.ts)、[`omp-adapter.ts`](../packages/adapters/omp/src/omp-adapter.ts)
- Claude Code：[`sdk-transport.ts`](../packages/adapters/claude-code/src/sdk-transport.ts)、[`claude-code-adapter.ts`](../packages/adapters/claude-code/src/claude-code-adapter.ts)
- Grok：[`acp-transport.ts`](../packages/adapters/grok/src/acp-transport.ts)、[`grok-adapter.ts`](../packages/adapters/grok/src/grok-adapter.ts)
- DeepSeek：[`host-client.ts`](../packages/adapters/deepseek-harness/src/host-client.ts)、[`deepseek-harness-adapter.ts`](../packages/adapters/deepseek-harness/src/deepseek-harness-adapter.ts)

能力保真度对比如下；“有”只描述当前仓库实现，“可做”表示本文推荐路径在完成 Gate 后有原生依据：

| 接入路径 | Question | Approval | 精确 Checkpoint Fork | Last-Turn Rollback | Subagent identity/transcript |
| --- | --- | --- | --- | --- | --- |
| Pi 私有 RPC | 有 | 无独立 Approval | 有 | 有 | 无 |
| OMP 私有 RPC | 无 | 无 | 有 | 有 | 有 |
| Claude Agent SDK | 有 | 有 | 有 | 有 | 有 |
| Grok ACP + 私有扩展 | 无 | ACP 有 | 私有扩展有 | 私有扩展有 | 无 |
| DeepSeek Host API | 无 | 无 | 无 | 无 | 无 |
| OpenCode ACP | 无 | ACP 有 | 无 message boundary | `/undo`/`redo` 不支持 | 主要降为 Tool call |
| OpenCode Server + SDK | 可做 | 可做 | 可做 | 可做但会改真实文件 | 可做，child Session 是原生身份 |

OpenCode 的最佳类比不是单一现有 Adapter：它在协议层像 DeepSeek 的本地平台 Server，在类型和控制面上像 Claude Code 的官方 SDK，在标准兼容面上又能像 Grok 一样走 ACP。生产实现应新建独立 `packages/adapters/opencode`，不能把 OpenCode API 类型提升到 `shared-contracts`，也不应复制整个 Grok Adapter。

## 可编程接口比较

| 接口 | 传输 | 原生能力覆盖 | 建议定位 |
| --- | --- | --- | --- |
| `opencode serve` + `@opencode-ai/sdk/v2` | HTTP + SSE；部分 V2 PTY 使用 WebSocket | 最完整；现行 API 与 V2 API 可共存 | 主接入方式 |
| `opencode acp` | stdio 上的 ACP JSON-RPC / NDJSON | 标准化 Session/Prompt/Permission/Diff，但会丢失 OpenCode 特有能力 | 兼容或快速 MVP |
| `opencode run --format json` | 子进程 stdout JSON event | 事件和交互被大幅简化 | Smoke test / headless fallback |
| Plugin / Custom Tool | OpenCode 进程内扩展 | 可扩展 tool、auth、hooks、workspace | 可选增强，不作为基础传输 |

OpenCode 没有另一套已文档化的专有 JSON-RPC Harness 接口。其 Server API 是按资源组织的 HTTP RPC 风格接口，由 OpenAPI 描述；真正的 JSON-RPC 标准接口是 ACP。

直接接 Anthropic/OpenAI/其他 Model Provider API 也不是 OpenCode Harness 接入：那会绕过 OpenCode 的 Agent loop、Tool、Permission、Question、Session、Plugin、规则和文件 Snapshot。Provider API 只能说明模型怎样被调用，不能承担 codexhost 需要的 Harness 语义。

## 为什么首选 Server + SDK

### 公共、版本化的 SDK 边界

官方 JS SDK 包公开以下入口：

- `@opencode-ai/sdk`
- `@opencode-ai/sdk/client`
- `@opencode-ai/sdk/server`
- `@opencode-ai/sdk/v2`
- `@opencode-ai/sdk/v2/client`
- `@opencode-ai/sdk/v2/types`

证据：[`packages/sdk/js/package.json`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/sdk/js/package.json)、[SDK 文档](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/web/src/content/docs/sdk.mdx)。

`@opencode-ai/sdk/v2` 创建的 client 既暴露现行分组，如 `client.session`、`client.question`、`client.permission`，又把新接口放在 `client.v2` 下。它还统一处理 directory/workspace 的 header 或 query 重写。因此 codexhost 可以先依赖成熟执行路径，再以 capability gate 渐进启用 V2，而不需要维护两套基础 transport。

SDK 客户端实现与生成代码：

- [`packages/sdk/js/src/v2/client.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/sdk/js/src/v2/client.ts)
- [`packages/sdk/js/src/v2/gen/sdk.gen.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/sdk/js/src/v2/gen/sdk.gen.ts)
- [`packages/sdk/js/src/v2/gen/types.gen.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/sdk/js/src/v2/gen/types.gen.ts)

OpenCode 自己的 ACP 实现也导入 `@opencode-ai/sdk/v2`，说明 SDK/Server 是 ACP 下层的原生能力面，而非另一个外围封装。

### 进程所有权与安全

codexhost 应负责 Server 的启动、健康检查、退出和重启：

1. 在 loopback 上为每个受管实例选择端口。
2. 生成随机 `OPENCODE_SERVER_PASSWORD`，不要以无密码模式启动。
3. 仅把认证 header 保存在 Adapter 进程内，不进入 Renderer、日志或持久化 Thread 元数据。
4. 请求 `/global/health`、`/api/health` 和 `/doc`，校验运行版本与实际 capability。
5. SDK 依赖固定到已测试版本；Server 版本通过最低版本、OpenAPI endpoint 和方法级探测判定，缺失能力 fail closed 或降级，而不是只比较版本字符串。
6. SSE 断线后先重新订阅，再用 Session status、messages 及 pending Question/Permission 做状态对账。

官方 [Server 文档](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/web/src/content/docs/server.mdx) 说明了 Server、认证环境变量和 OpenAPI。`1.18.25` 无密码启动时也会明确给出安全警告。

官方 SDK 自带的 [`createOpencodeServer()`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/sdk/js/src/v2/server.ts) 硬编码从 `PATH` 启动 `opencode`，没有显式 executable 参数，也没有替 codexhost 建立随机 Basic Auth。codexhost 因此应自己实现很小的 `OpenCodeServerTransport`，复用现有 Harness executable discovery、bounded stderr 和跨平台 process-tree shutdown，只把已连接的 `createOpencodeClient()` 交给业务 Adapter。

初版建议一个 Host Runtime 管理一个 OpenCode Server，多个 Native Session 复用它；但该方案已被 per-Session environment 与 execution-policy 隔离要求否决。当前拓扑是每次 OpenSession 启动一个独立的受管 OpenCode Server；共享 Server 仅保留为后续实验方向，不是当前实现。不要每个 Turn 启动一次 Server，也不要将 loopback 端口暴露给 Renderer。

Remote SSH 场景中，Server 应由远端 Host Runtime 在 workspace 所在机器上启动并只监听远端 `127.0.0.1`；不应通过 SSH 对本机开放 OpenCode 端口。Windows 则需沿用现有 Adapter 的进程树终止策略，避免只退出父进程而残留 OpenCode 子进程。

## 现行 API 能力

现行 Session 路由定义在 [`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts)。SDK 能直接调用：

- Session 生命周期：`list`、`create`、`get`、`update`、`delete`、`status`、`children`、`todo`。
- Transcript：`messages`、`message`。
- 执行：`prompt`、`promptAsync`、`command`、`shell`。
- 控制：`fork`、`abort`、`summarize`、`revert`、`unrevert`。
- 文件变化：`diff`。
- 实时事件：`event.subscribe()` 对应 `/event`，`global.event()` 对应 `/global/event`。

交互不是只能从文本里解析：

- Question：`question.list`、`question.reply`、`question.reject`。路由见 [`question.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/server/routes/instance/httpapi/groups/question.ts)。
- Permission：`permission.list`、`permission.reply`。路由见 [`permission.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts)。新 Adapter 应使用 `/permission/{requestID}/reply`，不要依赖已废弃的 Session-scoped response。

这使 codexhost 可以保留原生 Question 和 Approval 语义，而不是把它们伪装成聊天文本。建议的映射是：

| OpenCode | codexhost 投影 |
| --- | --- |
| message/part text delta | assistant text event |
| reasoning delta | reasoning event |
| tool part pending/running/completed/error | tool lifecycle event |
| permission asked/replied | Approval interaction |
| question asked/replied/rejected | Question interaction |
| session status | busy/idle/error lifecycle |
| `session.diff()` | file-change/diff projection |
| `session.abort()` | cancel turn |
| `session.fork()` | Harness session fork |
| `session.summarize()` | compact |
| `session.revert()` / `unrevert()` | rollback / restore capability |

### Turn、事件流与完成边界

Adapter 应在提交 prompt **之前**建立 SSE 订阅。OpenCode `v1.18.25` 的消息分页先按 `time.created`、再按 ID 排序，latest-message 选择也把 ID 用作同毫秒消息的确定性 tie-breaker；调用方因此不能注入不具备原生排序形状的随机 UUID。当前实现复刻原生 [`id.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/id/id.ts#L15-L65) 的 6 字节 timestamp/counter 前缀，并只在 14 字符 Base62 不透明后缀中加入 namespaced Turn token 与递增序号，最后一个序号专门保留给单次 recovery；排序依据见 [`message-v2.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/message-v2.ts#L402-L443) 与 [`message-v2.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/message-v2.ts#L548-L573)。这样既能精确绑定 root/steer User Message，也能在 Resume 后恢复逻辑分组。只有 `parentID` 指向该活动 Turn 所有权集合中 User Message 的 Assistant Part 才允许实时投影。OpenCode 自己的 ACP 实现也是先注册 idle waiter，再发请求，且源码明确说明 idle 排在该 Turn 的事件之后；证据见 [`acp/event.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/acp/event.ts#L54-L74) 和 [`session/status.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/status.ts#L39-L48)。若未来版本改变 Message ID 接受或排序约束，必须先关闭 steering capability 并重新 Gate，不能回退为随机 ID。

`promptAsync()` 的客户端请求有超时 AbortSignal；超时或响应丢失后，Adapter 以 caller Message ID 查询权威 transcript，已落盘即视为 admission 成功，未落盘才返回失败。多个 steer 按进入顺序串行，并用 lifecycle version 同时围住 transcript 与 Diff 对账。最新 user 的终态 Assistant 后续进入 idle 且没有 pending admission/Interaction 时才关闭 steering；busy 中的 tool-call Assistant 终态仍属于可调整阶段。

OpenCode 上游存在一个窄窗口：steer user 已落盘，但旧 busy loop 恰好退出而没有消费它。Adapter 只为“已成功持久化的 steer、没有 Assistant、没有 Interaction”启用恢复，并统一等待 50 ms 后再次核验 status 与 transcript；最终 preflight 还会用 lifecycle epoch 拦住期间恢复 busy、新 User、owned Assistant、短暂打开又关闭的 Interaction，以及更新的 steer/cancel/fault。满足条件时最多写入一次 namespaced recovery prompt；普通 root、失败 steer、grace 内重新 busy 都不会触发。恢复仍无 Assistant 或 admission 失败时，同一 Host Turn 明确失败，不会无限等待。Transport stream 永久故障同样先等待 admission chain、保留所有已进入 native admission 的 Message identity、串行 abort，并用有界 transcript 读取重新发现 prompt response 与首次查询都失败后才晚落盘的 steer；随后统一对账每段 Diff，按 root Native Turn identity 发布失败。Fault finalization、Session 输出结束、Transport/受管 Server teardown 与并发 `close()` 共享同一 Promise，不会在 close fulfilled 后继续输出。

不能把 HTTP `204`、一次 text delta 或短暂没有新事件当作 Turn 完成。建议终止条件同时满足：

1. 观察到目标 Session 从 busy 回到 idle；
2. 目标 user message 对应的 assistant message 已有 `time.completed` / `finish`，或有明确 `error`；
3. 该 message 的 tool/reasoning/text part 已完成最终投影。

`MessageAbortedError` 在 Host 已请求 cancel 时映射为 cancelled；其他原生 error 映射为 failed；无 error 且达到 idle barrier 才映射为 succeeded。SSE 断线时不能猜结果，应暂停增量完成、重连后读取 status + messages + pending interactions 对账，再决定是否补发终态。

历史 Snapshot 应以持久的 User/Assistant Message 与 Part 为事实源，而不是重放临时 SSE 文本。普通 Host Turn 由一个 user message 及其后、下一个 user message 前的 assistant/compaction/tool parts 组成；带 namespaced root/steer 序号的连续 user message 则合并为一个逻辑 Host Turn。该 Turn 的 Native identity 使用 root User Message，Checkpoint 与 outcome 使用最后一个 steer/recovery 段的 Assistant 终态，每段 Diff 分别读取后归入同一 Turn。内部 recovery input 只在仍属于完整 root-led 分组时隐藏；被其他 user 打断或独立出现的 recovery-shaped ID 必须作为普通可见 Turn，避免吞掉真实用户输入。Native Turn/Item identity 直接使用 OpenCode ID，避免重连后生成新 ID 导致 UI 重复。Model/Thinking 选择写入 namespaced Session metadata，原生更新成功后才发布 effective state；这样即使尚未产生下一条 User Message，Resume 也能恢复当前选择，同时保留其他原生 metadata。

### Adapter 内部责任边界

`packages/adapters/opencode/src/opencode-adapter.ts` 仍保留为一个 Session façade，但它内部有四类必须保持同一状态机原子性的职责：Turn admission/completion、OpenCode SSE 到 Host Item/Interaction 的投影、Session state/usage projection，以及 history lifecycle/reconnect reconciliation。当前已将受管 Server 的进程生命周期与 SDK transport 拆到 `server-connection.ts` / `sdk-transport.ts`；暂不把上述四类状态机进一步拆成多个对象，因为它们共享 `ActiveTurn`、admission buffer、interaction closure 和 exactly-once completion invariant。下一次拆分应以可观察的 HarnessSession seam 为边界，并先为跨模块事件顺序建立契约测试，避免用 event bus 或共享可变全局状态替代现有显式状态机。

本文件不把当前已明显超过 2,500 行的实现视为已完成的结构优化：这是后续设计审查信号，而不是已经满足的重构目标。

### Question 与 Approval 的保真映射

OpenCode Question 原生结构包含一组问题、选项、`multiple`、`custom`，以及可选的 `{ messageID, callID }` Tool 关联；它可映射为 codexhost `choice` Question，并将 `custom` 映射为 `allowOther`。当前 OpenCode Question 没有 secret 或 multiline 语义，因此不能宣称支持 codexhost 的 secret/multiline text Question。结构定义见 [`question-v1.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/schema/src/v1/question.ts)。

Permission 的 wire reply 是 `once | always | reject`，但 OpenCode `always` 的真实作用域是 **当前 Server 进程内的共享 approved rules**：不持久化，也没有 Session ID 约束。它既不等于 codexhost 的持久 `allowAlways`，在共享 Server 下也不严格等于 `allowForSession`。因此第一版建议：

- 直接支持 `allowOnce` 和 `deny`；
- `allowForSession` 如要支持，由 Adapter 保存 Session-scoped 规则，后续命中时向 OpenCode 自动回复 `once`，不要把原生 `always` 泄漏到其他 Session；
- 在没有明确、可审计的持久 policy 写入设计前，不提供 `allowAlways`，也不修改用户的 `opencode.json`。

Permission/Question 的 asked、replied、rejected 事件和 list endpoint 应互相对账。收到回复后关闭 Host Interaction；Session cancel、Server 退出或请求从 list 消失时，以 cancelled/superseded 关闭，不能让 UI 永久 pending。

### Agent、Model、Thinking 与 Permission Mode 不是同一概念

OpenCode 的 `build`、`plan` 和自定义 Agent 是 Harness Agent；Model 是 `providerID/modelID`；variant/effort 是模型推理选项；Permission 是规则请求。这四者不能因为 ACP 都放在 `configOptions` 中就混成一个选择器。

当前 [`HarnessSessionCapabilities`](../packages/shared-contracts/src/harness-models.ts) 只声明 Model、Thinking Option 和 Permission Mode，没有 Agent selection。因此建议：

- Model：从 provider/model catalog 生成 `HarnessModelRef`，V1 每次 prompt 带上选中的 Model；
- Thinking：只有目标 Model 明确暴露 variant 且通过实测时，才映射为 `HarnessThinkingOption`；
- Permission Mode：映射为 `default`、`ask`、`allow` 三个 codexhost 模式，使用 Session 原生 PermissionRuleset；不要把 `build/plan` 冒充 Permission Mode；
- Agent：初版沿用 OpenCode 默认 Agent；若产品需要切换 `build/plan` 或自定义 Agent，应给 Harness 合约增加独立 Agent capability，或先作为明确命名的 OpenCode command 暴露。

V2 的 `switchAgent` / `switchModel` 适合未来原生 Agent picker，但在 V2 parity Gate 通过前不能替代 V1 prompt 上的稳定 Model/Agent 参数。

### 精确 Checkpoint Fork 与 Rollback

OpenCode `Session.fork({ messageID })` 会复制 **目标 message 之前**的消息；Fork Session 不设置 `parentID`。`parentID` 专用于 Task/Subagent child Session，不能拿它判断 Fork lineage。

为了满足 codexhost 的“Fork 到已完成 Turn”而不是“Fork 到当前 Session 尾部”，建议：

1. Snapshot 将该 Turn 最后一个 assistant message ID 记为 `NativeCheckpointRef.checkpointId`；
2. Fork 时重新读取源 transcript，找到这个 assistant message 后的第一个 message；
3. 有下一条 message 时，把它作为 OpenCode 的 exclusive `messageID` boundary；目标是最后一条时省略 `messageID`；
4. 派生后再次读历史，验证 Turn 数、保留 Turn 的完整语义内容以及目标边界的 checkpoint presence；不要要求派生 checkpoint ID 与源请求 ID 相等，因为 Fork 可以重新分配 Native Session、message、Turn、Checkpoint 和 Item ID。验证失败时删除派生 Session 并返回 `checkpointNotFound` / `nativeFailure`。

这和本仓库 Pi Adapter 先解析“目标 Turn 后的下一条 user entry”再调用原生 Fork 的做法一致。ACP 的 `session/fork` 没有 checkpoint/message 参数，所以只走 ACP 无法实现这项精确能力。

`forkAcrossCwd` 第一版应声明 `false`。OpenCode request 可以带另一个 directory，但复制的旧 assistant message 仍保存原 path，而且 transcript Fork 不复制文件系统；只有跨 cwd 的历史、工具路径和文件安全 Gate 全部通过后才能开启。

`rollbackLastTurn` 复用同一个 exclusive boundary，但调用 `session.fork({ messageID })` 派生新的 Native Session。派生历史精确截止在最后一个 User Message 之前；来源 Session 和项目文件保持不变。Adapter 会验证新旧 Session ID 不同、Turn 数精确少一，并在配置或 attach 校验失败时删除派生 Session。这里不能使用 `session.revert()`：该 API 原地修改来源 Session，还会通过 Git-backed Snapshot 恢复工作区文件，不符合 Desktop 编辑消息只改对话历史的语义。

### Diff、Usage 与 Subagent

`session.diff({ messageID })` 是 Turn 级文件变化的首选来源。codexhost `HostFileChange` 要求 path、add/update/delete 和 unified diff；OpenCode V1 `SnapshotFileDiff` 的 `file`、`status`、`patch` 在 schema 中是可选字段，所以 Adapter 必须验证完整性，不能用 additions/deletions 猜 path 或伪造 patch。严格回滚校验还要通过 `/path` 读取权威 worktree，把 Patch 的绝对路径与 diff 的 worktree-relative 路径归一到同一文件身份，并拒绝越出 worktree、路径元数据不一致或 Patch 文件覆盖不完整的结果。缺字段或无法完成对账时，不宣称该 Turn 有可用 FileChange。

Usage 可直接来自 Assistant Message 的 `tokens.input/output/reasoning/cache.read/cache.write` 与 `cost`，Context Window 来自实际 Provider Model 的 `limit.context`。建议：

- 当前 context used = 最新 assistant message 的 input + cache read + cache write；
- Session total cost = assistant message cost 求和；
- token 各字段按 OpenCode 原值映射，不把 Provider 估算的美元 cost 说成账单；
- OpenCode 没有统一的订阅计划窗口时，不填 codexhost plan limit 字段。

OpenCode Task Tool 会创建带 `parentID` 的 child Session，并在 tool metadata 中给出 `parentSessionId`、`sessionId`、model、background/job ID；`session.children()`、child status 和 child messages 可分别映射为 `subagent.state.changed` 与 `subagent.transcript.changed`。`nativeSubagentId` 应使用 child Session ID，Task resume 的 `task_id` 可映射为 send/continue，而普通 Fork 不能误报成 Subagent。源码见 [`task.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/tool/task.ts)。

这条路径能比 ACP 把 Task 仅显示为普通 Tool call 更原生，但前台/后台 Task、取消、失败、父 Session idle 时 child 仍运行、Server 重启和 transcript 权限都需要独立 Gate。第一版可先展示 Task Tool，Gate 通过后再声明 `subagents.observe/readTranscript: true`。

需要特别区分两个容易误映射的语义：

- OpenCode Session fork 复制所选 message 之前的 transcript；它不是 Git worktree 或文件系统 fork。实现见 [`session.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/session.ts#L691)。
- Revert 通过 snapshot/patch 操作真实文件，并保存恢复信息；不是只隐藏聊天记录。实现见 [`revert.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/revert.ts#L38)。

### 持久性边界

Session、message、part 和 durable event 数据保存在 SQLite：

- 数据库位置、WAL 配置：[`packages/core/src/database/database.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/core/src/database/database.ts)
- Session/message/input 表：[`packages/core/src/session/sql.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/core/src/session/sql.ts)
- durable event 表：[`packages/core/src/event/sql.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/core/src/event/sql.ts)

但现行 V1 Question 和 Permission 的 pending request 是进程内状态；Server 退出时 finalizer 会拒绝它们。Permission 的 `always` 只在当前 OpenCode 进程生命周期内有效，而且规则状态对该进程管理的 Session 共享。这意味着 Adapter 重启恢复时：

- 可以恢复 Session 和 transcript；
- 不能假设旧进程中的未决 Question/Approval 仍然可回复；
- 必须把旧 interaction 终止为 interrupted/rejected，并从新进程重新对账。

## 原生 V2：平台价值与当前限制

V2 `/api/*` 面向更强的控制平面/平台集成，提供：

- Session 固定到明确 `Location`。
- 调用者提供 ID 的幂等、持久 prompt admission。
- `delivery: "steer" | "queue"`。
- 显式 `resume`、`switchAgent`、`switchModel`。
- `compact`、`wait`、`interrupt`。
- 有限但持久的 event history。
- 按 aggregate sequence 对单个 Session replay-and-tail 的 SSE。
- staged / clear / commit revert。
- V2 Permission 和 Question。
- models、providers、integrations、credentials。
- 带短期 token 的 PTY WebSocket。

对应 SDK 入口包括：

```text
client.v2.session.create/list/get/active
client.v2.session.switchAgent/switchModel
client.v2.session.prompt/compact/wait/context/history/events/interrupt
client.v2.session.revert.stage/clear/commit
client.v2.session.permission.*
client.v2.session.question.*
client.v2.model.list
client.v2.provider.list/get
client.v2.integration.*
client.v2.credential.*
client.v2.event.subscribe
```

这些特性可以解决平台集成最难的几类问题：进程重连后增量 replay、调用幂等、用户输入排队或 steering、明确切换 agent/model、把 revert 做成可预览再提交的事务。

但是 OpenCode 的官方 V2 parity 规格仍把下列行为标为部分完成或缺失：

- project/configured/nested instructions；
- selected-agent prompt/policy；
- provider-family base instructions；
- 完整 built-in、MCP、plugin、structured-output tools；
- per-prompt system/tool override；
- steering reminders；
- plugin transforms；
- variants/settings；
- structured output；
- template/mention/reference expansion；
- file/media/MCP attachment materialization；
- crash continuation recovery 和 clustered execution ownership。

权威清单见 [`specs/v2/session.md` 的 V1 parity checklist](https://github.com/anomalyco/opencode/blob/v1.18.25/specs/v2/session.md#L123-L181)。因此建议：

- V1/现行 API 负责第一版真实执行链；
- V2 的 event replay、queue/durable steer、idempotency、staged revert 分别设独立实验 capability；现行 V1 steering 的 capability 与它们相互独立；
- 每项只有通过 codexhost interaction Gate 后才宣称支持；
- 不用一个笼统的 `supportsV2` 开关掩盖不同能力的成熟度。

## ACP 能做什么，以及为什么不是最原生路径

官方 [ACP 文档](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/web/src/content/docs/acp.mdx) 和实现表明，`opencode acp`：

- 在 stdio 上运行 ACP JSON-RPC / NDJSON；
- 支持 initialize/authenticate；
- 支持 new/load/list/resume/close/fork Session；
- 支持 model、effort/variant、mode 选择；
- 支持 prompt/cancel；
- 支持嵌入 context 和 image；
- 声明 MCP HTTP/SSE；
- 投影 assistant text、reasoning、tool status、usage/cost；
- 把 Permission 映射为 once/always/reject；
- 把 proposed edit 映射为 ACP diff content。

入口与实现：

- CLI：[`packages/opencode/src/cli/cmd/acp.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/cli/cmd/acp.ts)
- Service：[`packages/opencode/src/acp/service.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/acp/service.ts)
- Event translation：[`packages/opencode/src/acp/event.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/acp/event.ts)
- Permission/diff translation：[`packages/opencode/src/acp/permission.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/acp/permission.ts)

ACP 进程内部会启动 `Server.listen(...)`，再创建 `createOpencodeClient({ baseUrl, headers })`。因此它是原生 SDK/Server 上的一层协议投影。当前实现存在这些降维：

- 不转发 OpenCode 原生 Question；
- `/undo` 和 `/redo` 明确不支持；
- ACP `closeSession` 只 abort 并移除 ACP 内存状态，不删除持久化 OpenCode Session；
- `resume` 只 replay 最新 20 条 message，而 `load` replay 全部；
- model/mode/variant 的 ACP 状态位于内存，并从 message 重建；
- fork 通过 unstable ACP method 暴露，但请求只有 Session/cwd，没有 checkpoint/message ID，当前实现调用原生 SDK Fork 时也不传 message boundary；
- Task/Subagent 主要投影为 Tool call，缺少 child Session identity、状态和 transcript 的完整映射；
- event translator 只处理 session status、permission、message-part update/delta，无法携带全部原生事件。

所以 ACP 很适合复用标准 Transport/Adapter，但无法提供问题中所说的“更原生能力”。如果 codexhost 后续要支持多个只提供 ACP 的 Harness，ACP 仍可作为共享适配层；OpenCode 专用 Adapter 应优先走 SDK。

## Headless CLI 只适合作为 fallback

官方 [CLI 文档](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/web/src/content/docs/cli.mdx) 显示 `opencode run` 支持 continue/session/fork、model/agent/variant、file、attach server、JSON raw event 和 auto permission。

但 [`run.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/cli/cmd/run.ts#L670-L878) 的实现表明：

- 不带 `--auto` 时 Permission 会自动 reject；
- 带 `--auto` 时 Permission 会直接 approve once；
- 没有原生 Question 交互；
- 输出只保留 `tool_use`、`step_start`、`step_finish`、`text`、`reasoning`、`error` 等简化投影。

它适合安装探测、smoke test 或服务不可用时的一次性 headless fallback，不适合长期 Harness Session。

## Plugin、Custom Tool 与 Workspace 平台能力

OpenCode Plugin 会拿到 project、directory、worktree、SDK client、Server URL 和 shell，并可提供：

- tools；
- provider/auth integration；
- event hook；
- chat transform；
- permission hook；
- tool before/after hook；
- environment hook。

接口定义见 [`packages/plugin/src/index.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/plugin/src/index.ts)。Custom Tool 可以放在 `.opencode/tools/` 或全局配置目录，用 `@opencode-ai/plugin` 提供类型，并收到 agent/session/message/directory/worktree 上下文；详见 [Custom Tools 文档](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/web/src/content/docs/custom-tools.mdx)。

对 codexhost 最有价值的平台扩展点是：

```ts
experimental_workspace.register(type, WorkspaceAdapter)
```

`WorkspaceAdapter` 能执行 configure/create/remove/target，target 既可指向本地 directory，也可指向带 headers 的 remote URL。OpenCode 内置 Worktree Adapter 已证明这个模式可运行：

- Plugin 注册接口：[`packages/plugin/src/index.ts#L36-L64`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/plugin/src/index.ts#L36-L64)
- Control-plane 类型：[`packages/opencode/src/control-plane/types.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/control-plane/types.ts)
- 内置 Worktree Adapter：[`packages/opencode/src/control-plane/adapters/worktree.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/control-plane/adapters/worktree.ts)

可选的 `codexhost-opencode-plugin` 因此可以在后续做两类增强：

1. 把 codexhost 管理的本地 worktree 或远程 workspace 注册给 OpenCode。
2. 提供少量真正属于 Host 平台的 tools/hooks，例如请求 Host UI、报告 workspace metadata。

但该 API 名称明确带 `experimental`。第一版 Adapter 应由 codexhost 驱动 OpenCode，而不是强制 OpenCode 加载插件后反向驱动 Host；否则安装、版本耦合、安全授权和远程环境都会变成基础接入的前置条件。

## Model、Provider、Account 与凭据

现行 API 已支持：

- provider 列表和默认 model；
- provider auth method discovery；
- OAuth authorize/callback；
- auth set/remove。

V2 又将其拆成更适合平台 UI 的能力：

- model list；
- provider list/get；
- integration list/get；
- key/OAuth connect；
- OAuth attempt status/cancel/complete；
- credential label/update/remove。

OpenCode Console 还存在多 account/org 的隐藏实验功能，如 `opencode console login/logout/switch/orgs/open` 和 console metadata/org-switch HTTP API。实现见：

- [`packages/opencode/src/cli/cmd/account.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/cli/cmd/account.ts)
- [`packages/opencode/src/account/account.ts`](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/account/account.ts)

这些隐藏能力不应被当作稳定的 Harness Account 契约。Provider credential 独立保存在 mode `0600` 的 `auth.json`；codexhost 不应读取、复制、记录或向 Renderer 返回 secret，只应显示 OpenCode 提供的脱敏连接状态和授权动作。

## 建议的 capability 分层

以下是目标 capability 分层；当前分支的实际声明以上一节为准：

| capability | 目标状态 | 依据/策略 |
| --- | --- | --- |
| Session create/list/load/resume | 支持 | 现行 SDK + SQLite 持久化 |
| Text/reasoning/tool streaming | 支持 | `/event` SSE + idle barrier + transcript reconciliation |
| Permission/Approval | 部分支持 | 原生 once/reject；Session/Always scope 按前述策略收敛 |
| Permission Mode picker | 支持 | codexhost 命名的 `default` / `ask` / `allow`，映射 Session 原生 PermissionRuleset |
| Question | 支持其原生子集 | choice/multiple/custom；不宣称 secret/multiline，ACP 路径不支持 |
| Cancel | 支持 | `session.abort()` |
| Usage/cost/context | 支持 | message token/cost + Provider Model context limit |
| Diff | 支持其完整记录 | `session.diff(messageID)`；缺 path/patch 时 fail closed |
| Fork | 支持但标明语义 | exact transcript checkpoint fork；不是文件系统 Fork |
| Fork across cwd | 首版不支持 | 新旧 message path 和文件系统不随 transcript 一起 Fork |
| Compact | 支持 | `session.summarize()` |
| Last-Turn rollback | 支持 | exclusive transcript Fork 到 distinct Session；来源 Session 与工作区保持不变 |
| Model selection | 支持 | provider/model API；凭据留在 OpenCode |
| Permission Mode | 支持 | `default` / `ask` / `allow`；Session 原生 PermissionRuleset |
| Thinking/effort | 按 Model 探测 | 只映射已验证的 variant |
| Agent selection | 需新增 Host capability | 不能用 Permission Mode 代替 Agent |
| Subagent observe/transcript | 第二阶段 | child Session + task metadata；逐项 Gate |
| Durable event replay | 实验 | V2 per-session sequence/replay |
| Active-Turn steer | 支持（精确 Gate `1.18.25`） | 现行 `promptAsync()`；串行 admission、幂等、单次 stable-idle recovery、Host Turn 分组、完成/取消/transport fault 竞态 Gate |
| Durable prompt queue/steer | 实验 | V2 delivery 模式；不作为现行 steering 的回退路径 |
| Idempotent prompt admission | 实验 | V2 caller-supplied ID |
| Staged revert | 实验 | V2 stage/clear/commit |
| PTY WebSocket | 延后 | 需要单独终端权限和 token 生命周期设计 |
| Console multi-account/org | 不支持 | 隐藏/实验接口，不作为稳定契约 |
| Workspace Plugin | 可选实验增强 | `experimental_workspace` |

## 发布前与后续能力的验证 Gate

不能把 API 存在、类型声明或 `initialize` 元数据直接当成可用能力。实现时至少逐项验证：

1. Server 首次启动、异常退出、端口冲突、认证失败、版本不匹配。
2. SSE 正常流、断线、重复 event、缺失 event、重连后的 transcript/status 对账。
3. Permission 的 once/reject、Adapter Session scope、原生 always 的进程共享行为，以及进程退出时 pending request 的终止语义。
4. Question 的单选、多选、custom、reject、cancel；明确验证不支持的 secret/multiline 与重启恢复边界。
5. Tool 生命周期、proposed edit、真实 diff 和 tool error。
6. Prompt admission timeout/落盘对账、busy→idle 完成边界、连续 steer、取消后的幂等重试、瞬时 idle、单次 orphan recovery、transport fault、steer/完成/cancel 竞态，以及 V2 durable queue/steer（启用时）。
7. Session load/resume、跨 OpenCode 进程恢复、最后/中间 Checkpoint Fork、Fork 后目录语义和派生历史校验。
8. Last-Turn rollback 的 distinct Session、精确前缀、来源 Session 隔离、工作树不变和派生失败清理。
9. Model/provider/variant 切换、未登录 provider、OAuth 中断、凭据脱敏；Agent 不得误投影为 Permission Mode。
10. 前台/后台 Task、child Session 状态、取消/失败、父 Turn 完成与 Subagent transcript。
11. 单 Server 多 Session、跨 cwd 并发、Interaction 路由与 Permission 隔离。
12. 本地、codexhost remote SSH、Windows、无 OpenCode、旧版 OpenCode、升级/降级场景。

## 后续落地顺序

1. 补 OpenAPI 方法级 capability handshake，避免只根据 Server 版本或 SDK 类型推断能力。
2. 用隔离 Provider/fixture 完成 Question、Permission、Tool error、Cancel、真实 Model streaming 的 live Gate。
3. 在 Remote SSH 和 Windows 环境复核 distinct rollback 的进程树与路径语义。
4. 验证单 Server 多 Session、跨 cwd 并发、Interaction 路由和 Remote SSH/Windows 进程树。
5. 增加 Session-scoped approval policy 和 Subagent observe/transcript；Agent picker 需先补独立 Host capability。
6. 以独立实验开关接入 V2 replay、durable queue/steer、idempotency 和 staged revert；不替换已验证的现行 steering 路径。
7. 最后评估可选 Workspace Plugin；它不是发布第一版 OpenCode Harness 的阻塞项。

在这个顺序下，codexhost 能先获得比 ACP 和 CLI 更完整的 OpenCode 原生交互，同时把快速演进中的 V2 风险隔离在可探测、可回退的 capability 后面。
