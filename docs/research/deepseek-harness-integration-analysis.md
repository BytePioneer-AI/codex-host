# DeepSeek Harness 接入 codexhost 分析

> 调研日期：2026-08-13
> DeepSeek Harness 源码基线：[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
> 结论状态：已由本地 DSH Web Host API 实机验证更新。早期 JSON-RPC/Cordis 方案保留为历史分析，不再是实施建议；ACP 仍不作为生产主路径。

## 1. 结论

DeepSeek Harness 应作为 codexhost 的第三个外部 Harness 接入，稳定标识建议为 `deepseek-harness`。它不是一个 DeepSeek Model Provider SDK，而是拥有 Agent Loop、工具、会话、持久化、沙箱和交互能力的完整 Harness。官方也将其描述为基于 Cordis、由模型/工具/技能/会话/沙箱/存储/循环/UI 等插件组合的运行时。[产品页](https://www.deepseek.com/harness/) [插件文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)

当前实施架构：

```text
Codex Desktop Renderer
  -> codexhost transport model: codexhost/deepseek-harness-native@...
  -> Host Runtime
  -> @codexhost/harness-adapter contract
       - DeepSeekHarnessAdapter implements HarnessAdapter
       - DeepSeekHarnessSession implements HarnessSession
  -> official loopback DSH Web Host HTTP/WebSocket API
  -> user's local DSH Web profile and official Session Store
```

这里不会绕过 codexhost 的 Adapter 抽象层。Host Runtime 只依赖现有 `HarnessAdapter`/`HarnessSession`：`DeepSeekHarnessAdapter` 负责 `inspect/open/close`，其 Session 实现负责 `readSnapshot/execute/close` 并输出标准 `HarnessOutput`。DSH Host wire 类型和事件名仍封装在 Adapter 内。Adapter 优先连接现有 loopback Host，不可达时可启动本地已安装或已缓存的 `dsh web`；它不维护 Cordis配置、凭据、Skills、工具或第二份 Native Transcript。

官方已有 `@deepseek-ai/dsh-sdk-jsonrpc-server` 和 `@deepseek-ai/dsh-sdk-client`，传输是 stdout 专用的 newline-delimited JSON-RPC，Session 的完整 append-only event 会实时推送。这与 Pi Adapter 当前的子进程 RPC 形态相近，也是最符合 codexhost “使用 Harness 原生接口并保真投影”原则的入口。[SDK 总览](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/README.zh.md) [协议定义](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/protocol/src/types.ts) [服务端实现](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/server/src/server.ts)

但当前 SDK 控制面只包含 `initialize`、`session/prompt`、`shutdown`。它没有逐 Turn 取消、单 Session 关闭、恢复/读取历史、Fork、运行时 Model 切换、权限响应或用户问题响应；握手也没有协议版本协商。官方把这些列为已知限制。[协议说明](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/protocol/README.zh.md) [服务端限制](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/server/README.zh.md)

因此，不应直接把现有 SDK 包装成“完整 Adapter”。合理路径是：

1. 先做正式 Gate，证明固定版本运行时在 macOS/Windows 上启动、执行、持久化和退出。
2. 在 DeepSeek Harness 侧增加一个很薄的 codexhost 控制插件，或推动官方 SDK 协议补齐 `session/open|resume|read|cancel|close`。
3. MVP 只发布已经有明确原生语义的能力；Fork、Permission Mode、Question 等后续按协议能力开启，不能模拟成功。

## 2. 为什么不把它当 Model Provider

codexhost 的 Harness 定义是拥有 Agent Loop、上下文组织、工具、权限交互和 Native Session 的执行主体。DeepSeek Harness 正好符合这个定义；其中 `deepseek-official` 是 Provider route，`deepseek-v4-flash` 等才是 Model。把它加入 Pi 或 Claude Code 的 Model Catalog 会导致：

- DeepSeek Harness 自己的 Session/Event/Persistence 被绕过；
- 工具、沙箱、插件、压缩和子 Agent 语义丢失；
- `Thread -> Harness` 所有权被错误表示；
- Provider 凭据与 Harness 安装状态被混为一谈。

因此边界必须是独立的 `packages/adapters/deepseek-harness`，Harness-specific wire details 只存在于这个包内，符合仓库 [领域术语表](../领域术语表.md) 和 Adapter 边界规则。

## 3. 接口选择

### 3.1 推荐：原生 SDK JSON-RPC + Session Event

优势：

- stdout 是严格 JSON-RPC 通道，诊断走 stderr，适合受控子进程。[服务插件](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/server/src/index.ts)
- `session.event` 推送完整 SessionEvent envelope，而不是只给最终文本。
- 原生事件包含 `turn/start`、`turn/end`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`request/header` 和 Usage，可形成稳定投影。[Session 类型](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts)
- Native Session 是 append-only event log；恢复、分叉和回放共享同一事实源，和 codexhost 不持有第二份 Transcript 的方向一致。[产品说明](https://www.deepseek.com/harness/)
- TypeScript SDK 客户端允许显式指定 runtime executable、args、cwd 和 env，进程生命周期边界清楚。[客户端 API](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/src/api.ts)

当前缺口：

| codexhost Adapter 能力 | 当前 SDK | 结论 |
|---|---:|---|
| 创建 Session | 支持，首次 `session/prompt` 懒创建 | 可用；建议补显式 `session/open`，避免首轮前无 Native Ref |
| 多轮文本 | 支持 | 可用 |
| 文本/Reasoning 流 | 支持 `assistant/chunk` | 可用，但必须处理 committed message 对流片段的校验 |
| Tool 生命周期 | 支持 `tool/call` / `tool/result` | 可用 |
| Usage | `assistant/message.usage` | 可聚合并投影 |
| 取消 Turn | 不支持 | 发布前必须补齐；不能仅在 UI 上假取消 |
| 关闭单 Session | 不支持 | MVP 可用“一进程一 Session”使进程关闭等价于 Session 关闭 |
| 读取历史 | wire 不支持 | 必须补 `session/read`，不要直接解析私有 JSONL/压缩格式 |
| 恢复 Session | Harness 内核支持，wire 不支持 | 必须补 `session/resume`，内部调用 `ctx.agents.resume()` |
| Fork | Harness 内核支持，wire 不支持 | 后续补；Native Checkpoint 可基于已完成 Turn 的 event seq |
| Model 发现/切换 | wire 不支持 | 首版使用配置声明的固定 catalog；后续补 inspect/select |
| Permission Mode | Harness 有 policy/preset，wire 不支持 | 首版不宣称可选；后续映射原生 preset |
| Approval/Question | Harness 有原生 service，SDK 未桥接 | 后续用 server-to-client JSON-RPC request 桥接 |

DeepSeek Harness 内核本身已经有恢复和 Fork 原语：`ctx.agents.resume()` 可从 persistence 加载 Session，`SessionStore.fork()` 可按平衡事件边界派生 Session。因此主要缺失位于 SDK transport plugin，不是 Harness domain model。[Agent Registry](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/index.ts) [Session Store](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts)

### 3.2 不推荐：ACP 生产接入

DeepSeek Harness 自带 ACP bridge，确实支持 `session/new`、`session/prompt`、`session/cancel` 和一次性 `session/request_permission`。但该桥接明确：

- 只支持新 Session，不支持加载、恢复、列出、删除或 Fork；
- 只发送 committed assistant text；
- 实时进度、Reasoning、Tool activity、Plan、Title、Usage 全部不出 wire；
- 不公开 Question、配置选择器或 Transcript replay。

来源：[ACP 说明和限制](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/acp/acp/README.zh.md)

这会直接违反 codexhost 当前 README 所述的原生保真目标。因此 ACP 只适合：

- 早期连通性探针；
- 对照取消/审批语义；
- SDK 控制面尚未补齐时的实验性验证。

它不应成为 `DeepSeekHarnessAdapter` 的正式 transport。

### 3.3 不推荐：复用 DeepSeek Web API

Web Host 的 API Proxy/Typert Remote 面向其自有 Client 组合，并且 Remote 只处理 unary request/result；Session event stream 明确不属于 Remote 描述符范围。[API Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/api-gateway.zh.md)

依赖 Web server 会额外引入端口、origin/trust fence、浏览器 Host 生命周期和私有 API 漂移。codexhost 不需要 DeepSeek Harness UI，因此没有理由承担这一层。

## 4. 建议补齐的原生协议

建议优先向 DeepSeek Harness 上游贡献，而不是在 codexhost 内长期维护 fork。最小扩展如下：

```text
initialize({ clientInfo, protocolVersion })
runtime/inspect() -> providers, models, capabilities, serverInfo
session/open({ sessionId, cwd, provider, model, ... })
session/resume({ sessionId, cwd, provider?, model? })
session/read({ sessionId }) -> header + ordered SessionEvents
session/prompt({ sessionId, contentBlocks }) -> messageId
session/cancel({ sessionId, cause: "user" })
session/close({ sessionId })
shutdown()
```

第二阶段：

```text
session/fork({ sourceSessionId, boundarySeq, childSessionId, cwd })
session/selectModel(...)
session/selectPermissionPreset(...)
server -> client: interaction/request
client -> server response: approval or structured question answer
```

协议要求：

- `initialize` 必须协商版本；当前只返回未校验的 `serverInfo.version = 0.0.1`，预发布期没有兼容保证。
- `session/prompt` 的 `messageId` 仅证明 inbox 准入，Turn 归属必须由该回执后的 `turn/start`/`turn/end` 和 idle barrier 建立，不能把任意下一条 assistant message 猜成结果。
- `session/cancel` 必须等待/证明对应 Agent 进入已取消终态，不能只 ACK 请求。
- `session/read` 应从 `sessionPersistence`/Session API 返回结构化事件；codexhost 不应读取 JSONL 文件、猜压缩格式或复制 DeepSeek Session parser。
- 每个交互必须有 request id、Session id、Turn/Tool call 关联和取消语义；无回答者时按 DeepSeek Harness 原生规则 fail closed。
- 未识别且 `ignorable !== true` 的 Session event 必须导致 protocol error，不能静默丢失可能影响重放的事实。

## 5. Adapter 内部设计

建议包结构：

```text
packages/adapters/deepseek-harness/
  src/
    deepseek-harness-adapter.ts   # HarnessAdapter/HarnessSession 状态机
    transport.ts                  # 子进程、JSONL-RPC、超时、关闭
    protocol.ts                   # wire schema，仅 Adapter 内部
    event-mapper.ts               # SessionEvent -> HostEvent
    history.ts                    # SessionEvents -> HostThreadSnapshot
    model-catalog.ts              # Provider/Model opaque refs
    command.ts                    # runtime/config/executable 解析
  test/
```

不要把 DeepSeek SDK 的类型提升到 `shared-contracts`，也不要让 Host Runtime 按 DeepSeek event name 分支。Host 只看现有 `HarnessAdapter`/`HarnessSession`。

### 5.1 进程模型

MVP 推荐“一 live Native Session 一子进程”：

- 当前 `initialize` 的 `cwd/provider/model` 是进程级配置，不能正确表达不同 workspace/model 的多 Session runtime。
- 单 Session 进程让 `HarnessSession.close()` 可以可靠映射到 SDK shutdown + EOF/SIGTERM/SIGKILL 阶梯。
- 某一 Session 崩溃不会污染其他 Thread。
- 代价是内存和启动开销更高；协议支持 per-session open/config 后再考虑共享进程。

Adapter 必须像 Pi transport 一样确认进程树终止，Windows 使用 `taskkill` 或仓库既有 process-tree helper，macOS 使用独立 process group。stdout 只解析协议，stderr 只保留有界、脱敏尾部。

### 5.2 Native 身份

建议：

- `harnessId = "deepseek-harness"`
- `nativeSessionId = DeepSeek SessionId`
- `NativeTurnRef.nativeTurnKey = "turn:<native turn number>"`
- `NativeCheckpointRef = completed turn/end event seq`（只有协议补齐 Fork 并验证平衡边界后才发布）
- `NativeSessionRef.locator` 最多存 storage domain/profile id，不存 Prompt、事件正文、API key 或任意用户路径；Session root 由 Adapter 配置恢复。

DeepSeek 当前 `SESSION_FORMAT_VERSION` 仍为 `0`，源码明确说明预发布期不提供兼容承诺且不做迁移。codexhost 必须同时 pin runtime package family 和 Session format，升级前做旧 Session recovery Gate。[Session format](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts)

### 5.3 Event 映射

| DeepSeek Session Event | codexhost Host 语义 |
|---|---|
| `turn/start` | `turn.started`；绑定已准入的 Host Turn |
| `assistant/chunk` `text-delta` | `agentMessage` item + `text.append` |
| `assistant/chunk` `reasoning-delta` | `reasoning` item + `text.append` |
| `assistant/message` | 校验/完成当前文本与 Reasoning item，读取 Usage |
| `tool/call` | `toolExecution`；已验证为 shell 时可映射 `commandExecution` |
| `tool/result` | 完成 Tool item，提取 text/image result 和失败状态 |
| `turn/end` | `turn.completed`，映射 completed/aborted/error/max-tokens/interrupted |
| `compaction/start/end` | 完成后投影 `contextCompaction` item |
| `request/header/context` | 更新 effective Model/Thinking；不作为 Transcript item |
| `approval/*`, `permission/*` | 状态/审计；交互必须来自实时 request bridge，不能从日志反推待回答请求 |

两个保真注意点：

1. `assistant/chunk` 是原始 provider stream，`assistant/message` 才是 committed assembled message。若组合启用 retry，失败尝试的 partial chunk 可能不能进入最终消息。首版运行时应排除会产生不可撤销 partial stream 的 retry wrapper，或先给 Host contract 增加 `text.replace` 并在 committed message 到达时严格 reconcile；不能把错误尝试永久显示为答案。
2. `tool/call` 提供稳定名称和原始 JSON arguments，`tool/result` 提供模型可见结果及 tool-owned `meta`。首版可将未知工具保真投影为 generic `toolExecution`。只有对 codexhost 自有 Cordis 配置中固定、已测试的 shell/fs 工具，才增强为 `commandExecution`/`fileChange`。File diff 必须来自结构化 `meta.diffs` 或工具 presentation contract，不从自然语言输出猜测。

### 5.4 History

`readSnapshot()` 应把完整 Native Session event log 按 `turn/start...turn/end` 分组，并保持 stable Native Turn Ref。映射必须覆盖：

- 空 Turn、blocked、max-tokens、error、aborted、interrupted；
- 一个 Turn 多 Step；
- Tool call/result 配对与 orphan repair；
- compaction 的 surface replacement；
- `session/end-seed` 和 plugin event；
- 重复读取时稳定 item/turn identity。

DeepSeek 的 event log 是 Native Transcript 的唯一事实源；codexhost Mapping Store 只保存 Host/Native identity 和 checkpoint anchor，不复制正文。

## 6. Model、认证和权限

### Model Catalog

当前 SDK 没有 Model discovery。首版应由 codexhost-owned deployment 显式配置一个小型 catalog，例如 provider/model 列表，而不是扫描用户插件目录或硬编码所有 DeepSeek 产品型号。Model Ref 编码为 Adapter-owned opaque id，内部解析为 `{provider, model}`。

不要把 `provider=deepseek-official` 当作 Harness id。官方 SDK 默认 route 是 `deepseek-official`，默认 Model 示例是 `deepseek-v4-flash`，但这些仍是 Provider/Model。[SDK client defaults](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/src/api.ts)

### Authentication

官方 DeepSeek adapter 从 `DEEPSEEK_API_KEY` 和可选 `DEEPSEEK_BASE_URL` 读取凭据。Adapter `inspect()` 对官方 deployment 应区分：

- runtime 未安装：`notInstalled`；
- runtime/config 无法启动：`unavailable`；
- key 缺失或 Provider 拒绝认证：`authenticationRequired`；
- protocol/schema 不兼容：`error/protocolError`。

凭据只传给 DeepSeek 子进程，不进入 Renderer、transport model id、Mapping Store 或诊断。

### Permission

DeepSeek 的原生 approval policy 是 `ask | never`，只有 `allowed-once` 是 grant；缺少 answerer 时为 `unavailable` 并 fail closed。另有 sandbox/approval 组合的 Permission Presets。[Approval service](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/interaction/user-approval/src/index.ts) [Permission Presets 配置](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/config-catalog.zh.md#deepseek-aidsh-permission-presets)

MVP 在没有实时交互 bridge 时必须使用确定性的 `never` 或只提供无需升级审批的受控工具配置，并将 `selectPermissionMode=false`。不能展示可选 Permission Mode 后在后台自动允许。

## 7. codexhost 改动面

### Protocol Core

在 [`model-routing.ts`](../../packages/protocol-core/src/model-routing.ts) 增加：

- `DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID = "codexhost/deepseek-harness-native"`
- `EXTERNAL_HARNESS_IDS` 的 `deepseek-harness`
- transport selection encode/decode
- create route 与测试

配置 carrier 首版只需要 Model；Thinking/Permission 在 Native control 可用前不编码。

### Host Runtime

在 [`adapter-composition.ts`](../../packages/host-runtime/src/adapter-composition.ts) 注册 Adapter，并增加显式环境变量：

- `CODEXHOST_DEEPSEEK_HARNESS_COMMAND`
- `CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT`

Session 直接进入本地 DSH官方 Session Store；codexhost只通过 Mapping Store记录自己创建的 Native Session ID，不配置私有 Session root。

同时更新 package dependency、tsconfig references、release closure、Harness display name 和 generic tests。`approvalServerName()` 当前只有 Claude/Pi 二分逻辑，必须改成完整映射，避免 DeepSeek 被错误标为 Pi。

### Renderer Extension

当前 Agent 枚举和每个 Agent 的 Model/Thinking state 对 Pi/Claude Code 有硬编码。需要增加：

- `deepseek-harness` Agent、label、icon、安装 URL；
- availability inspection；
- transport model 检测/注入；
- per-Agent Model state；
- Thread restore/ownership；
- 选择器和 e2e coverage。

建议顺手把 per-Agent selection state 改为 `Partial<Record<ExternalRendererAgent, ...>>`，因为第三个 Agent 会使继续增加 `piModel/claudeModel/...` 字段变得脆弱。这是与本次接入直接相关的有界重构，不应扩散到通用插件系统。

### Mapping Store

现有记录已经使用通用 `HarnessId`、`NativeSessionRef` 和 opaque locator，原则上不需要 schema 版本升级。需要增加 DeepSeek 的恢复、历史对齐、归档、删除和隐私测试。只有 locator 需要新字段且旧 schema 不接受时才升级。

### Release

必须 pin 同一个 DeepSeek Harness prerelease family，不能混用 npm `latest` 与 `next` 的不同 RC。调研时 `@deepseek-ai/dsh` 为 `0.1.0-rc.6`，而部分 SDK package 的 `latest` 仍指向较旧 RC；应固定 exact version 并在升级 PR 中统一验证。[npm: dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) [npm: sdk client](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-client)

codexhost 开发使用 Node 22.19+（固定 22.22.0），满足 DeepSeek Harness `^22.19.0 || >=24.0.0` 的要求；发布安装包内嵌的私有 runtime 固定 24.13.1。真正风险是 native/runtime closure 与平台工具：

- 官方 Python bundled runtime 当前只列 Linux x64/arm64 和 macOS arm64，没有 Windows artifact。[platforms.json](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk-runtime/platforms.json)
- 官方 JSON-RPC coding-agent 示例使用 local bash；Windows deployment 需要单独组合/验证 PowerShell、filesystem 和 Windows sandbox，不能照搬 POSIX config。[示例配置](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/examples/jsonrpc-agent/cordis.yml)
- stdout logger 会破坏协议，发布配置必须静态 Gate 禁止 console/stdout logger。

codexhost发布物只携带 exact-pinned Host API client contract，不携带第二套 DSH Runtime或自有 Cordis config。用户本地 `dsh web` profile是工具、Skills、设置、凭据、权限和官方 Session Store的事实源；`CODEXHOST_DEEPSEEK_HARNESS_COMMAND`与`CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT`用于显式覆盖本地发现。

## 8. 分阶段实施

### Gate D0：可运行性（不进产品 UI）

- 固定 DeepSeek package 版本和独立临时 Session root。
- 启动真实 JSON-RPC runtime，验证 initialize、首轮、多轮、Tool、Usage、shutdown。
- 分别验证 macOS arm64、Windows x64。
- 验证 stdout 纯净、stderr 脱敏、进程树无残留、无 key 时错误分类。

退出条件：两个平台都能通过真实 runtime，不依赖源码 checkout 或全局 profile。

### Gate D1：协议控制面

- 实现/上游贡献 version negotiation。
- 实现 `session/open|resume|read|cancel|close`。
- 用 mock LLM 和真实 persistence 做 crash/restart、取消竞态、重复 read 和 cwd ownership 测试。
- 明确未知 required Session event 的拒绝行为。

退出条件：Adapter 可以诚实实现 codexhost 必需的 create/resume/read/cancel/close，不靠读取存储文件或 kill 模拟普通取消。

### Gate D2：Headless Adapter

- 新建 `packages/adapters/deepseek-harness`。
- 完成 Model inspection、Session 状态机、事件 mapper、history mapper、Usage 和错误分类。
- Hermetic fake transport tests + real runtime Gate。

退出条件：两轮文本、流式文本/Reasoning、Tool、文件修改、取消、恢复全部通过；未实现能力在 capabilities 中为 false。

### Gate D3：Host/Renderer Vertical Slice

- Protocol route、Host registry、Renderer Agent picker、transport injection。
- 新 Thread 选择 DeepSeek Harness，首轮/第二轮闭环。
- Thread ownership、read/resume、archive/delete、应用重启恢复。
- Codex/Pi/Claude Code 路径保持不变。

### Gate D4：交互与高级历史

- Approval 和 Question 双向 bridge。
- 原生 Permission Presets。
- Fork/checkpoint。
- 命令目录、插件模式或其他能力只在 DeepSeek 原生 API 能给出 executable promise 时加入。

## 9. 主要风险

| 风险 | 影响 | 控制措施 |
|---|---|---|
| SDK 预发布且无版本协商 | wire/Session 不兼容 | exact pin、握手协商、升级 recovery Gate |
| 缺少取消/恢复/read | 不能满足现有 HarnessSession | 先补原生 plugin，不发布假能力 |
| Session format 仍为 0 | 升级后旧 Thread 不可恢复 | runtime 与 format 一起 pin，升级前 fixture migration decision |
| Raw chunk 与 committed message 不一致 | UI 显示失败 retry 文本 | 限制 composition 或支持 replace/reconcile |
| Tool `meta` 是 tool-owned | diff/terminal 误分类 | 只增强固定 deployment 的已测试工具，未知工具保持 generic |
| 一进程一 Session 资源成本 | 多 Thread 内存/启动时间 | MVP 优先隔离；协议 per-session config 完成后评估共享 runtime |
| Windows 无官方 bundled runtime | 发布阻塞 | npm closure + Windows-native Cordis config + 实机 Gate |
| 插件配置可加载 stdout logger | JSON-RPC 通道损坏 | codexhost-owned immutable config + config lint + startup handshake timeout |
| 用户插件使能力集合变化 | Mapper 不能理解新事件/工具 | required event fail closed；unknown tool generic；不承诺任意 profile 兼容 |
| API key 泄漏 | 安全事故 | 子进程 env 最小化、日志脱敏、禁止 Renderer/Mapping Store 携带凭据 |

## 10. 最小产品范围建议

首个可发布版本应明确限制为：

- codexhost 自带、固定版本的 DeepSeek Harness coding deployment；
- DeepSeek official Provider + 配置声明的 Model；
- 每个 Thread 独立 Native Session 和进程；
- 文本、Reasoning、固定 shell/fs Tool、可靠 diff、Usage；
- 新建、多轮、取消、应用重启恢复、read/archive/delete；
- 无用户自定义 Cordis profile；
- 无 Fork、动态插件 UI、任意 Provider、Question、可选 Permission Mode，直到对应原生控制面完成。

这一路径能保持 codexhost 的核心承诺：Thread 始终由一个 Harness 拥有，Native Session 是事实源，Adapter 使用 Harness 自己的结构化事件，Host 不猜测工具/审批/历史语义。
