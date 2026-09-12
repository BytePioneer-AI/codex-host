# Qoder Agent 适配实施文档

> 目标：把 Qoder CLI/SDK 接入 `codex-host`，并在 Desktop 的 Agent 选择器中显示为可用的 `Qoder` 选项。
>
> 读者：没有现成上下文、需要独立完成实现的模型或开发者。
>
> 适用分支：`Qoder`。
>
> 本文是实施说明，不是代码审查结论。实现时应以当前安装的 Qoder SDK 类型定义和仓库当前公共契约为准；Qoder 官方文档会变化，下面所有“官方行为”都必须在编码前用文末链接重新核对一次。

## 1. 先确定交付范围

“新增一个 Agent 选项”在本仓库里有三个不同层次，不能混成一个任务：

| 层次 | 结果 | 必须修改的范围 | 本文默认是否包含 |
| --- | --- | --- | --- |
| 插件后端 | Host 能加载 `qoder` 插件、创建/恢复会话、流式输出、处理权限和错误 | `packages/adapters/qoder`，公共插件契约，测试 | 是 |
| 预装发行 | 正式构建产物中自带 Qoder 插件 | `scripts/release/harness-plugins.json`、包锁文件、发布构建 | 只有产品要求预装时 |
| Desktop 选项 | 用户能在 Agent Picker 里看到并选择 Qoder | `packages/renderer-extension` 多处静态 Agent 映射、路由、图标、设置页 | 是，因为用户明确要求 Agent 选项 |

如果只想先做后端插件，可以完成第 5 至第 12 节后停止；不要为了“动态插件已经能加载”而假设 Desktop Picker 会自动出现 Qoder。当前 Renderer 有静态 Agent 列表，插件 Loader 本身不会自动改变它。

推荐的最终交付顺序：

1. 先让插件在 Host Runtime 中可以被加载。
2. 再验证 Qoder SDK 的会话、消息、权限、错误映射。
3. 再决定是否把插件加入预装发行清单。
4. 最后接入 Renderer 的选择器和通用插件路由。

不要在后端协议尚未跑通时先改一大批 UI 分支；这样出现问题时很难区分是 Qoder SDK、Host Adapter 还是 Renderer 状态错误。

## 2. 不能混用的三个 Qoder 接口

Qoder 提供三个看起来都像“JSON 流”的接口，但它们不是同一协议：

| 接口 | 用途 | 适配时的结论 |
| --- | --- | --- |
| `@qoder-ai/qoder-agent-sdk` | TypeScript 应用通过 SDK 启动并控制本地 `qodercli` | **本项目首选**。负责会话、流式消息、权限、模型、恢复和关闭。 |
| `qoder --output-format stream-json` | 脚本或命令行调用的公开 JSON 输出 | 适合一次性脚本；不要把它当成 SDK 的内部控制协议。 |
| `qoder --acp` | ACP 客户端/编辑器集成 | 是第三条集成路线；除非明确选择 ACP，否则不要把 ACP 消息硬塞进 SDK Adapter。 |

SDK 的架构可以按下面理解：

```mermaid
flowchart LR
  H[Host Runtime] --> A[Qoder Harness Adapter]
  A --> S[@qoder-ai/qoder-agent-sdk]
  S --> C[qodercli 子进程]
  C -->|stdin/stdout JSONL| S
  C -->|stderr 诊断| S
  A --> R[HarnessSession 公共契约]
  R --> P[Protocol/Renderer]
```

SDK 负责读取和解释 `qodercli` 的 JSONL。Adapter 不应直接读取 Qoder 子进程的 stdout，也不应根据文本行猜消息类型。SDK 的 stdin/stdout 是内部传输；CLI 的 `stream-json` 是另一种面向脚本的输出；ACP 又是另一种协议。

## 3. 固定的命名和边界

除非仓库已经有冲突，统一使用下面的名称：

| 项目 | 固定值 |
| --- | --- |
| Harness ID | `qoder` |
| npm workspace 包 | `@codexhost/adapter-qoder` |
| Manifest `id` | `qoder` |
| 官方 SDK 包 | `@qoder-ai/qoder-agent-sdk` |
| Host 自有 CLI 覆盖变量 | `CODEXHOST_QODER_COMMAND` |
| 官方个人令牌变量 | `QODER_PERSONAL_ACCESS_TOKEN` |
| Desktop 显示名 | `Qoder` |

`CODEXHOST_QODER_COMMAND` 是本仓库自己的覆盖约定，不要把它写成 Qoder 官方环境变量。它只用于测试或用户安装了非默认 CLI 路径时覆盖启动命令。官方令牌变量可以交给 Qoder SDK 的 `accessTokenFromEnv` 处理，不能在 Host 日志、错误文本、SessionStore 或 Renderer 状态里保存令牌值。

必须遵守的边界：

- `packages/renderer-extension` 不得导入 Node 内置模块、Qoder SDK 或任何 Harness SDK。
- Qoder 特有的 JSONL、SDK 消息、权限参数、错误码只放在 `packages/adapters/qoder`。
- Host Runtime 通过插件 Manifest/Factory 加载 Qoder，不得静态导入 `@codexhost/adapter-qoder`。
- `shared-contracts` 只增加真正跨进程、浏览器安全的公共类型；不要把 Qoder SDK 类型泄漏进去。
- 不修改 Rust 来承载 Qoder 协议；Rust 只负责现有原生启动/进程能力。

## 4. 建议的最小目录

先使用最少的文件，只有文件明显变大时再拆分。建议初始结构如下：

```text
packages/adapters/qoder/
  manifest.json
  package.json
  tsconfig.json
  src/
    plugin.ts
    qoder-adapter.ts
    qoder-sdk-transport.ts
    qoder-model-catalog.ts
    qoder-usage.ts
  test/
    qoder-adapter.test.ts
```

可以把消息类型和权限桥接先放在 `qoder-sdk-transport.ts` 或 `qoder-adapter.ts` 中。只有在实现超过约 500 行且职责确实分离时，才新增：

```text
    qoder-messages.ts
    qoder-permissions.ts
    qoder-history.ts
    qoder-errors.ts
```

不要一开始生成“通用 SDK 抽象层”“多后端传输层”或空的未来适配器接口。仓库已经有 `HarnessSession` 和 `HarnessPluginModule` 公共抽象，Qoder 只实现一次即可。

## 5. 插件 Manifest、包和构建

### 5.1 `manifest.json`

使用仓库已有 Manifest Schema，不要自定义字段。最小示例：

```json
{
  "manifestVersion": 1,
  "adapterApiVersion": 1,
  "id": "qoder",
  "displayName": "Qoder",
  "entry": "dist/plugin.mjs",
  "icon": "assets/icon.svg",
  "links": {
    "homepage": "https://qoder.com/",
    "documentation": "https://docs.qoder.com/"
  }
}
```

注意：

- `id` 必须是小写 kebab/dot/underscore 形式；`qoder` 合法。
- `entry` 和 `icon` 必须是插件包内相对路径。
- 链接必须是 HTTPS。
- 如果当前 Manifest Schema 的字段名和示例不同，以 `packages/shared-contracts/src/harness-plugins.ts` 为准，不要凭记忆补字段。
- 图标可以先复用仓库允许的最小 SVG 资源；不要把网络请求、远程图标或 base64 凭据放进 Manifest。

### 5.2 `package.json`

包应放在 workspace `packages/adapters/*` 下，依赖只声明实际使用的公共包和 Qoder SDK。版本必须使用编码时 npm/锁文件中可解析的真实版本，不要在文档或代码里臆造版本号：

```json
{
  "name": "@codexhost/adapter-qoder",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./dist/plugin.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@qoder-ai/qoder-agent-sdk": "<按当前可用版本锁定>",
    "@codexhost/harness-adapter": "workspace:*",
    "@codexhost/shared-contracts": "workspace:*"
  }
}
```

实际 package 名称和 workspace 包导出名必须查当前 `packages/*/package.json`。如果 `harness-adapter` 和 `shared-contracts` 的导入不需要作为运行时依赖，遵循现有插件的写法，不要重复添加。

Qoder SDK 的 TypeScript 快速开始要求 Node.js 18 或更高；Qoder CLI 安装页目前要求 Node.js 20 或更高。Host 本身的运行时约束优先，以仓库 package/toolchain 现状为准。不要为了 Qoder 单独改全仓 Node 版本。

### 5.3 `tsconfig.json`

复制最接近的 SDK 风格插件（优先 `packages/adapters/claude-code`）的 tsconfig，保持：

- `module`、`moduleResolution`、`target` 与其他适配器一致；
- 通过公共包 exports 引入 `HarnessAdapter` 和共享类型；
- 不直接引用 Host Runtime 私有实现；
- 项目引用或 root `tsconfig` 是否需要新增，按现有插件模式处理。

### 5.4 Plugin factory

`src/plugin.ts` 只负责读取 `HarnessPluginContext`，创建 Adapter，不做会话逻辑：

```ts
import type {
  HarnessPluginContext,
  HarnessPluginModule,
} from "@codexhost/harness-adapter";
import { QoderAdapter } from "./qoder-adapter.js";

export const QODER_COMMAND_ENV = "CODEXHOST_QODER_COMMAND";

export const createHarnessAdapter: HarnessPluginModule["createHarnessAdapter"] =
  (context: HarnessPluginContext) =>
    new QoderAdapter({
      context,
      commandOverride: context.environment[QODER_COMMAND_ENV],
    });
```

上面是结构示意，具体导入路径、返回类型和 Context 字段必须以当前公共导出为准。不要在 factory 里启动 CLI；启动应发生在 `inspect`、`open` 或显式 prewarm 调用中。

## 6. Qoder SDK 的核心使用方式

### 6.1 查询模型

官方 TypeScript API 的核心形状是：

```ts
query({
  prompt: string | AsyncIterable<SDKUserMessage>,
  options?: Options,
}): Query
```

- 字符串 prompt 是一次性调用。
- `AsyncIterable<SDKUserMessage>` 是多轮会话的正确入口。
- `Query` 是异步生成器，必须持续消费到 `type: "result"`，或者直到迭代器抛出异常。
- 不要每个 Host turn 都重新调用一次 `query()`；这样会丢失长连接上下文、控制器和待处理权限。

推荐的长会话结构：

```text
HarnessSession.open()
  -> 创建 pushable AsyncIterable<SDKUserMessage>
  -> 调用一次 query({ prompt: iterable, options })
  -> 后台消费 SDKMessage
  -> 每个 turn.start 向 iterable 推入一条 SDKUserMessage
  -> 收到 result 结束当前 turn，但不关闭 query
  -> session.close() 时关闭输入队列并调用 q.close()
```

`pushable AsyncIterable` 可以使用仓库已经存在的异步队列工具；找不到时再实现一个很小的单消费者队列。不要引入新的队列库。

### 6.2 启动和预热

`startup({ options?, initializeTimeoutMs? })` 可预热本地 `qodercli`，默认初始化超时约为 60 秒。它适合：

- 发现 Qoder 是否可启动；
- 尽早拿到初始化信息；
- 减少第一次用户输入的延迟。

约束：

- `startup` 不是完整用户会话；不要把预热消息写入用户历史。
- WarmQuery 只能查询一次，完成后要关闭。
- 官方文档说明 Cloud Agent 不支持 `startup`；如果检测到该模式，返回明确的 unsupported/unavailable 状态。
- 如果当前 SDK 版本的 `startup` 会创建可持久化 session，Adapter 必须确认不会污染用户会话；无法确认时，inspect 可以只做可执行文件/认证探测，不伪造初始化成功。

`resolveSettings` 只读取设置，不要用它代替 query 或会话初始化。

### 6.3 认证

Qoder SDK 的 query 需要且只能配置一种认证来源：

- Personal Access Token / access token；
- 本机 qodercli 已登录状态；
- Service Account。

官方辅助方法包括 `accessToken`、`accessTokenFromEnv`、`qodercliAuth`、`serviceAccount`。首版推荐优先使用 qodercli 本机认证，并允许通过 `QODER_PERSONAL_ACCESS_TOKEN` 走显式令牌认证；不要自动在多种来源之间静默切换。

实现要求：

- 不在 `HarnessInspection`、日志、错误、SessionStore、Renderer 状态中回显 token。
- PAT 环境变量默认名为 `QODER_PERSONAL_ACCESS_TOKEN`，但 SDK 不负责自动刷新 PAT。
- `onAuthExpired` 一个 session 最多处理一次；刷新失败后结束当前 turn，并将原因映射到 `authenticationRequired`。
- 认证配置错误和运行中 auth expired 要分成两类诊断，便于 UI 决定是否显示登录提示。

### 6.4 CLI 路径、环境和代理

Qoder `Options` 允许配置：

- `cwd`：项目工作目录；必须来自 Host Thread 的工作目录。
- `env`：传给 qodercli 的环境；只传必要变量，不能把 Host 全部 secrets 注入。
- `proxy`：仅控制 qodercli 对外请求；不等同于工具/子进程的代理环境。
- `pathToQoderCLIExecutable`：显式 CLI 路径。
- `spawnQoderCLIProcess`：测试替身或仓库既有进程工厂。
- `executable`、`executableArgs`：仅在当前 SDK 版本确实导出时使用。

命令选择顺序建议：

1. 测试或用户明确设置的 `CODEXHOST_QODER_COMMAND`；
2. Qoder SDK 默认发现；
3. 发现失败时返回 `unavailable`，不要硬编码机器路径。

不要把 `HTTP_PROXY`/`HTTPS_PROXY` 自动写入 Qoder SDK options，除非当前 Host 的既有代理策略明确要求；Qoder 文档区分 qodercli 出站请求和工具/子进程环境。

## 7. SDK 消息消费和 Host 投影

### 7.1 总原则

消息处理必须先按 `message.type` 分派，再按 `subtype` 分派。未来新增 type、subtype 或 capability 时，应该记录诊断并继续，不要因为未知消息让整个 Thread 崩溃。

SDK 可能先后发出多个 `assistant` 消息、partial `stream_event`、队列状态和最终 `result`。一个任务不是“一条 assistant 消息”。

建议的循环：

```ts
for await (const message of query) {
  switch (message.type) {
    case "system":
      handleSystem(message);
      break;
    case "assistant":
      projectAssistant(message);
      break;
    case "stream_event":
      projectPartial(message);
      break;
    case "result":
      finishTurn(message);
      break;
    default:
      projectNonTerminalOrDiagnostic(message);
  }
}
```

如果 `for await` 抛出异常，按 SDK exception 路径处理；不要伪造一个成功 `result`。

### 7.2 `system/init`

初始化消息通常包含：

- `session_id`：Qoder 原生 session 的主键；
- `qodercli_version`、可选 `protocol_version`；
- `cwd`、`model`、`permissionMode`；
- `tools`、`slash_commands`、`output_style`；
- `agents`、`skills`、`plugins`、`mcp_servers`；
- `capabilities`、可选 fast mode 状态；
- `apiKeySource`。

处理要求：

- 用 `system/init.session_id` 作为 `NativeSessionRef`，不要使用 Host turn ID 代替。
- 把能力和工具当作运行时快照；不要把一次启动的模型/工具列表写死成常量。
- `apiKeySource` 只允许进入非敏感诊断，不要由此推导 token 内容。
- `mcp_servers` 的 `status` 是服务状态，不是会话完成状态。

### 7.3 `assistant`

典型内容：

```ts
{
  type: "assistant",
  uuid,
  session_id,
  parent_tool_use_id: string | null,
  request_id?: string,
  message: {
    role: "assistant",
    content: [
      { type: "text", text: string },
      { type: "tool_use", id: string, name: string, input: unknown },
      { type: "thinking", thinking: string }
    ],
    usage?: {
      input_tokens?: number,
      output_tokens?: number,
      cache_read_input_tokens?: number,
      cache_creation_input_tokens?: number,
      credits?: number,
      original_credits?: number,
      billable?: boolean
    }
  }
}
```

投影规则：

- `text` 产生普通 assistant/agent message。
- `thinking` 只有在 Host 当前支持并且用户已选择显示时，才产生 reasoning item；不能把它拼进普通文本。
- `tool_use` 产生工具执行开始事件，使用原生 `id` 做关联键。
- 一次用户 turn 可能有多个 assistant 消息；不要在第一条 assistant 后结束 turn。
- `request_id` 默认可能不存在。只有在设置 `QODER_EXPOSE_REQUEST_ID=true`（中国区域可能是 `QODERCN_EXPOSE_REQUEST_ID=true`）时才暴露；没有它时不要自造 request ID 并声称是原生值。

### 7.4 partial `stream_event`

只有 `includePartialMessages: true` 时才请求 partial 消息。常见 delta：

- `text_delta` -> `delta.text`；
- `thinking_delta` -> `delta.thinking`；
- `input_json_delta` -> `delta.partial_json`。

partial 是增量，不是最终消息。必须继续等待最终 `assistant`/`result`，并防止把增量和最终内容重复展示两次。最简单的策略是：

1. partial 只更新一个按原生 message/tool ID 索引的临时 item；
2. 最终 assistant 到达后用最终内容覆盖该 item；
3. result 到达后关闭该 turn；
4. 如果没有稳定 ID，宁可只发最终消息，也不要重复拼接。

### 7.5 非终止消息

以下消息不是 turn 完成信号：

- `model_queue_status` 的 `queued`/`ready`；
- `status`；
- `mcp_status_change`；
- `hook_started`、`hook_progress`、`hook_response`；
- `task_started`、`task_progress`、`task_notification`；
- `session_state_changed`、`session_title_changed`；
- `files_persisted`；
- `permission_denied`；
- `mirror_error`；
- `prompt_suggestion`、`cloud_agent_event`。

第一版可以把无法精确投影的消息降级为进度或诊断，但必须继续消费到 `result`。`mirror_error` 表示外部镜像失败，不应自动杀掉正在运行的 Qoder 会话。

### 7.6 `result`

成功结果通常包含：


```ts
{
  type: "result",
  subtype: "success",
  uuid,
  session_id,
  duration_ms,
  duration_api_ms,
  is_error,
  num_turns,
  result,
  total_credits?,
  usage?,
  modelUsage?,
  permission_denials?
}
```

当前文档列出的错误 subtype 包括 `error_max_turns` 和 `error_during_execution`，后者可能有 `errors[]`、`usage`、`modelUsage`、`error_code`。未来 subtype 必须走未知错误结果路径，不能因为枚举不全而丢失 turn 结束信号。

完成条件：

- `result` 成功：结束当前 Host turn，保留 query 供下一轮使用。
- `result` 错误：结束当前 Host turn，保留 session 是否继续由错误类型决定；认证、协议和进程崩溃通常需要关闭或重建。
- 只有 query 异常或显式关闭才结束整个 `HarnessSession`。

## 8. Host turn、输入和取消

### 8.1 `SDKUserMessage`

基本结构：

```ts
{
  type: "user",
  uuid?: string,
  session_id?: string,
  priority?: "now" | "next" | "later",
  shouldQuery?: boolean,
  timestamp?: string,
  parent_tool_use_id: string | null,
  custom_context?: Record<string, string>,
  message: {
    role: "user",
    content: Array<
      | { type: "text", text: string }
      | { type: "image", source: { type: "base64", media_type: string, data: string } }
      | { type: "tool_result", tool_use_id: string, content: string | unknown[], is_error?: boolean }
    >
  },
  isSynthetic?: boolean,
  tool_use_result?: unknown
}
```

Host `turn.start` 的普通文本应形成一条唯一的 user UUID。UUID 规则：

- 每个 session 内唯一；
- 恢复历史时不要重新生成已经持久化的原生 UUID；
- 工具结果的 `tool_use_id` 必须引用前一条原生 `tool_use`；
- `parent_tool_use_id` 没有父工具时使用 `null`。

`priority` 的含义：

- `now`：打断当前响应并立即处理；
- `next`：默认值，排队到当前处理完成后；
- `later`：延后处理。

`shouldQuery: false` 只追加上下文，不请求新的模型响应。普通用户发送不要用它。

### 8.2 取消的三个层次

不要把三种取消混用：

| 操作 | 作用 | Host 映射 |
| --- | --- | --- |
| `q.interrupt()` | 停止当前模型生成/工具执行，保留 session | `turn.cancel` 首选 |
| `q.cancelAsyncMessage(uuid)` | 取消还在队列里的异步输入 | 只有尚未处理的 queued input 使用 |
| `AbortController.abort()` 或 `q.close()` | 关闭整个 SDK query/session | `session.close`、进程失败或重建 |

`turn.cancel` 正常情况下不要调用 AbortController，因为那会把还能继续使用的 session 一起关闭。取消后要验证：

1. 当前 turn 发出 canceled/failed 终态；
2. 下一轮仍能在同一个 session 上运行；
3. 未处理的权限请求被取消或拒绝，不会永远悬挂。

## 9. 权限、提问和交互

### 9.1 权限选项的默认策略

Qoder SDK 的 `permissionMode` 包括：

```text
default | acceptEdits | bypassPermissions | yolo | plan | dontAsk | auto
```

`bypassPermissions`/`yolo` 必须同时设置 `allowDangerouslySkipPermissions: true`。首版 Adapter 不应默认选择它们，也不应为了“自动化测试方便”静默绕过权限。

推荐首版：

- 创建 session 时使用 Qoder 默认/Host 传入的安全模式；
- 使用 `canUseTool` 接入 Host 的批准 UI；
- 如果 TypeScript SDK 没有已验证的运行时 `setPermissionMode`，把能力声明为 `permissionModeScope: "atCreate"`；
- 只有确认安装版本支持并且行为稳定后，才把 `permissionMode.select` 声明为 live capability。

不要从 Python SDK 的方法名推断 TypeScript SDK 一定有同名方法。文档中能确认 `q.setModel()`，不能据此假定 `q.setPermissionMode()` 存在。

### 9.2 `canUseTool`

`canUseTool(toolName, input, context)` 只会在普通工具需要审批时调用：

```ts
type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: unknown;
      updatedPermissions?: unknown;
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };
```

它不是完整工具日志：自动允许或自动拒绝的工具可能不会触发回调。因此工具执行记录仍要从 assistant `tool_use`、result、hook 和 Host 事件中建立。

桥接规则：

1. 收到 `canUseTool` 时，用 `toolUseID` 作为 pending interaction 的键；没有 ID 时使用 SDK 输入中的稳定工具 ID，不能使用随机 UI 行号。
2. 把 `toolName`、摘要后的 `input`、当前工作目录和 AbortSignal 传给 Host Approval Interaction。
3. Host 选择允许时返回 `behavior: "allow"`，必要时带 `updatedInput`。
4. Host 选择拒绝时返回 `behavior: "deny"` 和用户可读原因；如果用户要求立即停止，带 `interrupt: true`。
5. `context.signal` 触发时，关闭 UI 并让 callback 返回拒绝/取消，不要留下 pending Promise。
6. 收到 `permission_denied` 后只记录结果；不要第二次弹相同对话框。

### 9.3 `AskUserQuestion`

Qoder 的 AskUserQuestion 也通过权限回调进入。输入通常包括 1 至 4 个问题，每题含完整问题文本和选项。允许时返回：

```ts
{
  behavior: "allow",
  updatedInput: {
    questions: [/* 原问题结构 */],
    answers: {
      "完整的问题文本": "用户选中的回答"
    }
  }
}
```

注意：

- `answers` 的 key 是完整问题文本，不是索引；
- 用户取消时返回 deny；
- 普通新用户 prompt 必须走 SDK streaming input，不能伪装成 AskUserQuestion；
- Host 应区分 Approval Interaction 和 Question Interaction，但二者都要使用同一个 pending 生命周期和取消信号。

### 9.4 工具和文件变更投影

建议的保守映射：

| Qoder 信号 | Host 项目 |
| --- | --- |
| assistant content `text` | agent message |
| assistant content `thinking` | reasoning item（仅在支持时） |
| assistant content `tool_use` | tool execution started |
| 已知命令工具且输入包含命令 | command execution |
| 文件工具有明确路径和结果 | file change/patch（必须有足够证据） |
| `files_persisted` | 文件持久化进度/诊断 |
| 只有工具名称，没有路径/结果 | 不要凭空生成 file change |

不要根据工具名猜“肯定修改了文件”。错误的 file change 会污染 Thread 历史、差异视图和回滚入口。

## 10. 模型、Thinking 和动态能力

### 10.1 模型目录

不要硬编码 Qoder 的完整模型列表。官方 SDK 提供 `q.getAvailableModels()`，这是实时查询且不保证缓存；暂时无法获取时返回 `[]`，不一定抛异常。

模型适配规则：

- `ModelInfo.value` 保存 Qoder 原生 ID，不能把显示名当 ID；
- `displayName` 用于 UI；
- `description`、上下文窗口、能力标签只有在 SDK 返回时才填；
- `auto`、`ultimate`、`performance`、`efficient`、`lite` 是文档示例/策略值，运行时也可能出现完整模型 ID；不要把这五个值当成永久目录；
- 模型暂时消失时，锁定 Thread 的旧 ID 应保留并提示用户重新选择，不能静默换成另一个模型。

`resolveModel` 可以动态解析模型，默认超时约 500 ms。回调超时、抛错或返回空值会使 query 失败，不会自动 fallback；`fallbackModel` 只有在明确配置时才使用。不要用 fallback 掩盖动态目录异常。

推荐实现：

1. `inspect` 或 session 初始化时调用 `getAvailableModels()`；
2. 将结果转成公共 `ModelInfo`；
3. `model.select` 只接受仍然存在或由用户明确输入的原生 ID；
4. 如果当前 Query 支持 `q.setModel()`，在 session 内切换；否则声明 at-create，并在下一次创建/恢复时使用；
5. 不要把模型值写进 UI 的硬编码 union，尽量使用 `string`/公共动态模型类型。

### 10.2 Thinking

Qoder 文档有 `thinking_config`/reasoning 相关能力，但必须用安装版本的 TypeScript 类型和真实运行消息确认：

- 可选值到底是 `off/low/medium/high`、数值预算还是模型特有字符串；
- 是否可以在活动 query 上切换；
- 是否只在创建 session 时配置；
- partial thinking 是否稳定可见。

在未确认前：

- 不把 `thinking.select` 标为已支持；
- 不把任意 Qoder `reasoningEffort` 文本直接传给 SDK；
- 不把不可见的思考内容显示给用户；
- 只保留创建时可验证的选项，或干脆不暴露该控件。

## 11. Session、历史、恢复和分叉

### 11.1 Session 身份

以 Qoder 的 `system/init.session_id` 为 native session ID。Host 的 Thread ID、turn ID 和 Qoder session ID 是三个不同概念。

默认行为：

- 每次新建 query/connection 会得到一个新的持久化 UUID；
- `sessionId` 指定新 ID；
- `resume` 恢复指定 ID；
- `continue: true` 继续最近一次；
- `resume` 和 `continue` 互斥；
- `resume + forkSession: true` 从旧 session 派生独立 session，可配新的 `sessionId`；
- `persistSession` 默认 true；
- `resumeSessionAt` 指定从某个消息边界恢复；
- `resumeDropsTurn` 可丢弃指定恢复点之后的 turn。

`QODER_CONFIG_DIR` 会改变历史、资源和日志根目录。若用户配置了它，`NativeSessionRef` 应能区分配置目录，否则同一个 UUID 可能在不同根目录下指向不同会话。

建议 NativeRef 形状（仅示意，以仓库公共类型为准）：

```ts
{
  harnessId: "qoder",
  sessionId: "<qoder session_id>",
  configDir?: "<非敏感配置目录>",
  formatVersion: 1
}
```

不要把 token、完整 env 或日志路径中的敏感片段写进 locator。

### 11.2 History Snapshot

`readSnapshot` 应优先调用 Qoder SDK 提供的公开历史 API，例如当前版本支持的 `getSessionMessages(sessionId)`；不要直接解析 Qoder 私有 JSON 文件，除非官方 SDK 没有任何公开历史能力且产品明确接受该耦合。

读取历史时要做到：

- 保持原生消息顺序；
- 用原生 user UUID/assistant UUID 作为稳定 ID；
- 识别 user 消息、assistant 消息、tool_use/tool_result 和 result 的边界；
- 对未知消息保留诊断或跳过，不重写成普通文本；
- 读失败时返回明确 `protocolError`/`sessionNotFound`，不要返回一个看起来为空的成功历史。

如果 SDK 版本没有稳定公开的历史读取 API，第一版可以让 `readSnapshot` 明确返回 unsupported；不要用日志或缓存拼出“近似历史”。

### 11.3 Fork 和 rollback 的边界

Qoder 的 `forkSession` 是原生会话分叉能力，可以在 `resume` 基础上创建独立 session。只有满足以下条件时才把它映射成 Host `history.fork`：

- 能稳定定位 fork anchor；
- fork 后的新 session ID 能写回 `NativeSessionRef`；
- 新 session 的历史前缀与 Host 预期一致；
- 文件状态是否共享/复制已经有明确语义；
- 测试覆盖 fork 后继续输入和关闭旧 session。

Qoder `enableFileCheckpointing` 和 `q.rewindFiles(id, { dryRun })` 只负责本地 Qoder 文件快照：

- anchor 是 user message UUID，不是 session UUID 或 result UUID；
- dry run 返回 `canRewind/error/filesChanged/insertions/deletions`；
- 不回滚会话历史、MCP、数据库、远程副作用或 Bash 副作用。

因此 `rewindFiles` 不能直接冒充 Host 的 `rollbackLastTurn`。首版建议：

- `history.fork`：未验证时 false；验证通过后才开启；
- `history.rollbackLastTurn`：false；
- `enableFileCheckpointing`：只有 UI 和文档明确声明“仅文件回退”时才开启；
- 不要把“文件恢复成功”描述成“整轮回滚成功”。

## 12. SessionStore 和持久化镜像

如果 Host 需要把 Qoder 历史镜像到自己的存储，使用 SDK 的 `SessionStore`，不要自行同时监听 qodercli 私有历史文件。

SessionStore 约束：

- 必须支持 append/load；
- 可选 list/delete/listSubkeys；
- 条目是不透明、有序、可幂等处理的数据；
- 可以批量写入或 eager 写入；
- 镜像失败只产生 `mirror_error`，不应自动终止 query；
- 不得与 file checkpoint、custom transport 或 Cloud Agent 组合，除非当前 SDK 文档明确允许；
- 当前 TypeScript 版本对 `persistSession: false` 和自定义 SessionStore 的组合要按类型定义验证，不要猜。

Adapter 应把镜像错误作为诊断暴露给 Host，但不能把它升级成“Qoder 任务失败”。真正的 Native session 结果仍由 Qoder `result` 决定。

## 13. 错误分类和映射

Qoder 有三套错误命名空间，必须分开：

1. `result.error_code`：模型/服务/业务结果中的 Qoder 错误码；
2. SDK 异常：例如 `QoderCliProcessError`、认证配置错误、协议版本不匹配、能力不支持、模型策略超时；
3. CLI 进程退出码：子进程级别的 0、1、41、42、44、52、53、54、130 等。

不要把 `result.error_code = 500` 当成进程退出码，也不要把 CLI exit code 41 写进 `error_code` 字段。

建议映射表：

| Qoder 信号 | Host 错误类别 | 处理 |
| --- | --- | --- |
| auth expired、auth 配置错误、result 105、CLI 41 | `authenticationRequired` | 结束当前 turn，保留可恢复 Thread；提示登录/令牌。 |
| 明确找不到 session | `sessionNotFound` | 不重试同一个坏 locator；允许用户新建。 |
| unsupported capability、result 430 | `unsupported` | 关闭对应 Host 控件或降级，不伪造成功。 |
| CLI 42、参数/输入错误 | `invalidRequest` | 返回可读参数错误。 |
| `q.interrupt()`、CLI 130 | `cancellation` | 当前 turn canceled；session 是否继续取决于 SDK 状态。 |
| result 500、10408、10500 | `nativeFailure`，`retryable: true` | 有界重试或允许用户重试；不要自动无限重启。 |
| protocol mismatch | `protocolError` | 记录双方版本，停止当前 session。 |
| CLI 44/54 | `nativeFailure` | 记录 sandbox/tool 失败；保留原生诊断。 |
| CLI 52 | `nativeFailure` 或配置不可用 | 显示配置路径/原因，不隐藏。 |
| CLI 53、result 47902 | `invalidState`/turn limit | 结束 turn，允许新 turn 或重新创建 session。 |
| 未知错误码 | `nativeFailure` | 保留原始数值和安全摘要，继续遵循结果终态。 |

常见 Qoder result 错误还包括配额、账单、敏感内容拒绝、输入过长、媒体过多、排队和自定义服务错误。Adapter 不需要为每一个错误码建立 UI 分支，但必须保留原始 `error_code`、安全的 `errors[]` 和可判断的 retryable 信息。

`QoderCliProcessError` 的 `stderr` 可能包含路径、用户输入或敏感片段。写入 Host 诊断前要做最小脱敏；不要把整段 stderr 直接送进 Renderer。

## 14. Usage、Credits 和上下文用量

### 14.1 不要混淆三种数值

Qoder 同时提供：

- assistant 单次 LLM request 的 `usage`；
- result 当前 CLI session 的累计 `total_credits`/`modelUsage`；
- `getContextUsage()` 的上下文占用百分比和统计；
- `getUsageInfo()` 的账户配额/当前 session 累计信息。

assistant `usage` 是单个模型请求，不是整个 Host turn 的最终累计值。`result.total_credits` 是累计快照，不能把多个 result 的累计值再次相加。credits 也不是 USD。

### 14.2 推荐映射

| Qoder 字段 | Host `HostUsage` |
| --- | --- |
| `input_tokens` | `inputTokens` |
| `cache_read_input_tokens` | `cachedInputTokens` |
| `cache_creation_input_tokens` | `cacheWriteInputTokens` |
| `output_tokens` | `outputTokens` |
| `modelUsage[model].costUSD` | `totalCostUsd` |
| 最新 `result.total_credits` 或 `getUsageInfo().session.total_credits` | `totalCredits`，只存最新快照 |
| `getContextUsage().contextWindow.usedPercentage` | `contextUsagePercent` |

没有可靠数据时保持 `undefined`/`null`。不要根据百分比反推 token window，不要把账户配额百分比硬塞进 Host 的 `planFiveHour` 或 `planSevenDay`，也不要伪造输入/输出 token 数。

`refreshUsage` 可以调用 `getUsageInfo()`/`getContextUsage()`，但要考虑 Qoder 暂时不可用时返回空值；刷新失败不能让正在运行的 turn 失败。

## 15. HarnessAdapter 公共契约映射

先阅读并遵循当前文件，不要照抄旧适配器的私有字段：

- `packages/harness-adapter/src/text-session.ts`
- `packages/harness-adapter/src/plugin.ts`
- `packages/harness-adapter/src/usage.ts`
- `packages/shared-contracts/src/harness-models.ts`
- `packages/shared-contracts/src/harness-plugins.ts`

当前 session command 至少包括：

```text
turn.start
turn.cancel
interaction.respond
model.select
thinking.select
permissionMode.select
```

推荐首版能力声明：

| 能力 | 首版建议 | 开启条件 |
| --- | --- | --- |
| 创建新 session | true | query + init 能稳定完成。 |
| 流式文本输出 | true | assistant/result 映射测试通过。 |
| turn cancel | true | `q.interrupt()` 后可继续下一轮。 |
| 权限批准 | true | `canUseTool` pending/取消/拒绝链路通过。 |
| model select | 视 SDK 版本 | `q.setModel()` 类型和运行行为已验证；否则 at-create。 |
| thinking select | false | 只有确认真实 SDK 字段和切换语义后开启。 |
| permission mode select | false 或 at-create | 不假定 TypeScript SDK 有 live setter。 |
| resume | true/部分支持 | SDK 公开 resume 和历史 anchor 已验证。 |
| fork | false | `forkSession` 的前缀、文件和新 ID 已测试。 |
| rollback last turn | false | Qoder `rewindFiles` 不等于 Host transcript rollback。 |
| subagents | false | `task_*` 事件不足以证明可观察、可恢复的子 Thread。 |
| autonomous turns | false | 没有 Host 可接受的无交互循环语义时关闭。 |

`initialState`、`initialUsage` 和 `capabilities` 必须来自已知事实。缺少能力时返回 false/unknown，比声明后运行中失败更容易维护。

### 15.1 `inspect`

`inspect` 是发现/诊断，不是用户 session：

- 检查 CLI 是否存在；
- 检查 Node/SDK 可加载；
- 检查认证配置是否存在，但不显示秘密；
- 尽量读取模型目录；
- 返回版本、能力、不可用原因。

不要为了 inspect 自动发送用户 prompt、修改文件或把预热消息写进历史。

### 15.2 `open`

`open` 负责：

- 读取新建/resume/fork 参数；
- 创建 SDK options；
- 建立一次长生命周期 query；
- 等待 init 或首个可判断状态；
- 返回 `HarnessSession`。

如果初始化失败，要清理 query、pending interaction 和子进程，再返回结构化错误。不能留下后台 qodercli。

### 15.3 `execute`

每个 `turn.start`：

1. 验证 prompt 和可选附件；
2. 分配唯一 user UUID；
3. 将消息推入同一个 AsyncIterable；
4. 通过 projector 发出输出；
5. 等到该 turn 的 result/cancel/error；
6. 更新 usage 和 session state。

`interaction.respond` 必须只完成对应的 pending promise。未知 interaction ID 应返回可读错误，不要把回答发送给最近一个对话框。

### 15.4 `close`

关闭顺序建议：

1. 标记 session closing，拒绝新的 turn；
2. 取消/拒绝所有 pending permissions/questions；
3. 关闭输入队列；
4. 调用 `q.close()` 或 AbortController；
5. 等待 query 消费循环结束；
6. 清理临时文件/监听器；
7. 返回 close 完成。

不要等待一个已经失联的权限 UI 永久返回。

## 16. Renderer 中新增 Qoder 选项

当前 Renderer 存在静态 Agent 分支，所以需要逐处完成 Qoder 的最小接线。先用 `rg` 搜索现有 Agent ID，再按语义修改，避免只改 Picker 导致状态无法保存。

至少检查以下文件：

| 文件 | 要做的事 |
| --- | --- |
| `packages/renderer-extension/src/agent-selection-state.ts` | 把 `qoder` 加入 `KNOWN_RENDERER_AGENTS`；新增/处理 `qoderModel`、`qoderThinkingOptionId` 等仅在确实需要的字段；补齐 getter/setter、restore/reset 和序列化分支。 |
| `packages/renderer-extension/src/renderer-agent-picker.ts` | 加入 `Qoder` 显示名、安装/文档链接和选择项。 |
| `packages/renderer-extension/src/renderer-agent-icon.ts` | 加入 Qoder 图标和可读标签。 |
| `packages/renderer-extension/src/renderer-binding-probe.ts` | 将 Qoder 纳入 external agent 探测、inspect、availability 和 prewarm 路径。 |
| `packages/renderer-extension/src/versioned-renderer-adapter.ts` | 使用通用 `encodeHarnessPluginRoute({ harnessId: "qoder" })`；不要先创建 Qoder 专用 codec。 |
| `packages/renderer-extension/src/renderer-sidebar-agent-icons.ts` | 加入 ownership -> Qoder 图标映射。 |
| `packages/renderer-extension/src/settings/connections-page.ts` | 如果设置页显示可安装 Agent，加入 Qoder 行和官方链接。 |
| `packages/renderer-extension/src/agent-group-preference.ts` | 若 Agent 分组偏好有静态 union，加入 Qoder。 |
| `packages/renderer-extension/src/renderer-new-thread-preference.ts` | 若新 Thread 默认 Agent 有静态 union，加入 Qoder。 |
| `packages/renderer-extension/src/renderer-composer-dom.ts` | 若 composer 控件通过静态 Agent 分支渲染，补 Qoder。 |
| 相关测试 | 覆盖选择、恢复、路由、图标、不可用状态。 |

实现原则：

- 使用已有通用插件路由；不要为 Qoder 复制一套 Kiro/Claude 专用协议编码器。
- Qoder 不支持的模型/thinking/permission 控件要隐藏或置灰，不要显示一个点击后必然失败的控件。
- 动态模型 ID 保持字符串，不要把 Qoder 模型列表写进 `KNOWN_RENDERER_AGENTS` 或静态 union。
- 如果某个共享 UI 函数已经接受任意 `ExternalHarnessId = string`，只加数据映射，不要扩大公共类型为另一套重复 union。

## 17. Host Runtime 和预装发行

### 17.1 插件加载

Host Runtime 相关代码包括：

- `packages/host-runtime/src/installed-harness-plugins.ts`
- `packages/host-runtime/src/app-server-host.ts`
- loader/manifest 相关测试

不要在 `app-server-host.ts` 里写 `if (id === "qoder") import(...)`。正确路径是让 Manifest/插件发现机制加载 Qoder，Host 只依赖公共 `HarnessPluginModule`。

### 17.2 只作为外部插件

如果产品暂时允许用户安装/加载外部插件：

- 不改 `scripts/release/harness-plugins.json`；
- 只构建 Qoder 插件包并验证 manifest/entry；
- 不把 Qoder SDK 打进 Host 核心包；
- 在文档中写清安装路径和 SDK 运行时要求。

### 17.3 加入预装发行

如果 Qoder 要随正式发行版预装：

1. 在 `scripts/release/harness-plugins.json` 加入 `packages/adapters/qoder`。
2. 在 `runtimePackages` 加入实际运行时需要的 `@qoder-ai/qoder-agent-sdk`。
3. 更新 lockfile 和 workspace 构建引用。
4. 运行 `packages/harness-adapter/scripts/build-plugin.mjs` 所使用的正式构建流程。
5. 确认 bundler 的允许运行时包列表接受 Qoder SDK；禁止通过绕过边界把 SDK 直接塞进 Host。
6. 检查发布产物中的 `manifest.json`、`plugin.mjs`、icon 和 SDK 依赖。

只有用户/产品明确要求预装时才执行这一节；“能在本地作为插件运行”和“进入正式发行版”是两个交付决定。

## 18. 测试策略

本任务不需要一开始跑全仓测试。先写能击穿真实风险的少量测试。

### 18.1 不需要真实网络的单元测试

使用 fake SDK factory 或可注入的 `query` 工厂，参考 Claude 适配器的 transport 测试方式。至少覆盖：

- `system/init` 能设置 native session ID 和初始能力；
- 多条 assistant 消息不会提前结束 turn；
- partial text/thinking 不会和最终消息重复；
- `model_queue_status` 不会被当作完成；
- success result 能完成当前 turn；
- error result 能保留原始 error code；
- `q.interrupt()` 后可继续下一轮；
- `session.close()` 会清理 pending permission/question；
- 同一 session 的 user UUID 唯一；
- `tool_use_id` 与 permission response 正确关联；
- AskUserQuestion 的 answers 使用完整问题文本作为 key；
- 未知 message type/subtype 不会让消费循环崩溃；
- usage 不会把累计 credits 重复相加；
- resume/fork 的 native ref 不会丢失 session ID 或 configDir；
- 进程异常、认证错误、取消、协议错误分别映射到正确 Host error kind。

### 18.2 插件/路由测试

- Manifest schema 能接受 `id: "qoder"`；
- loader 能通过 factory 创建插件；
- 通用 plugin route 编解码 `qoder` 往返一致；
- Host 不需要静态 import Qoder 包；
- Renderer 选择 Qoder 后能保存、恢复并建立正确 external route；
- Qoder 不支持的控件不会被误显示。

### 18.3 可选本机 smoke test

只有本机确实安装并授权 Qoder 时才执行：

```text
qoder --version
```

然后按顺序验证：

1. inspect/预热；
2. 新建 session，发送只读 prompt；
3. 触发一个需要批准的工具，允许一次；
4. 再触发一个需要拒绝的工具；
5. 取消一轮，确认可以发送第二轮；
6. 关闭并 resume；
7. 检查 usage/历史/错误诊断。

没有 Qoder 安装或凭据时，不能把 fake SDK 测试写成“真实集成已通过”。

## 19. 推荐执行顺序和完成定义

按下面顺序提交最小可运行实现：

### 阶段 A：后端骨架

- [ ] 创建 `packages/adapters/qoder`。
- [ ] Manifest、package、tsconfig 和 factory 能通过类型检查。
- [ ] loader 能发现并创建 Qoder 插件。
- [ ] 没有任何 Host Runtime 对 Qoder 包的静态 import。

### 阶段 B：最小会话

- [ ] `inspect` 能区分未安装、未认证、可启动。
- [ ] `open` 能建立长生命周期 SDK query。
- [ ] `system/init` 能建立 native session ref。
- [ ] 一个普通文本 turn 能收到 assistant 和 result。
- [ ] `close` 能释放 qodercli 和所有监听器。

### 阶段 C：交互和错误

- [ ] 文本、thinking、tool_use、partial、result 正确投影。
- [ ] `turn.cancel` 使用 interrupt，不误杀 session。
- [ ] permission/question callback 与 Host interaction 一一对应。
- [ ] 认证、协议、进程、取消、业务错误分开映射。
- [ ] usage 只使用真实字段，缺少字段保持空值。

### 阶段 D：历史和模型

- [ ] resume 能保持原生 session ID。
- [ ] history snapshot 只使用公开 API 或明确返回 unsupported。
- [ ] 动态模型目录不硬编码。
- [ ] model select/thinking/permission 能力只在真实支持时声明。
- [ ] fork/rollback 没有被错误宣传成文件/整轮回滚。

### 阶段 E：Desktop 选项

- [ ] Picker 显示 Qoder。
- [ ] 图标、设置页、external agent 探测一致。
- [ ] 新建 Thread、恢复 Thread、分组偏好不丢失 Qoder。
- [ ] 通用插件路由能到达 Host。
- [ ] Qoder 不支持的控制项不会产生死按钮。

### 阶段 F：发行决定

- [ ] 明确 Qoder 是外部插件还是预装插件。
- [ ] 若预装，更新 release manifest、runtimePackages 和 lockfile。
- [ ] 构建插件 bundle，确认 SDK 没有越过边界进入 Host 核心。

完成定义不是“文件已经创建”，而是：用户选择 Qoder 后，Host 能创建会话、看到真实流式输出、在需要时得到一次明确交互、取消后能继续或得到准确错误，并且关闭时没有后台 qodercli 残留。

## 20. 常见错误清单

实现模型在提交前逐条自查：

- [ ] 没有把 SDK JSONL、CLI `stream-json`、ACP 混为一谈。
- [ ] 没有直接解析 qodercli stdout。
- [ ] 没有每个 turn 新建一次 query。
- [ ] 没有把 queued/ready 当成 turn 完成。
- [ ] 没有把 `q.interrupt()` 写成 session close。
- [ ] 没有默认 `bypassPermissions`/`yolo`。
- [ ] 没有把 `canUseTool` 当成完整工具日志。
- [ ] 没有用工具名猜造 file change。
- [ ] 没有硬编码 Qoder 模型目录或动态计划列表。
- [ ] 没有把 credits 当成 USD，也没有重复累加累计 credits。
- [ ] 没有把 `rewindFiles` 宣传成 Host transcript rollback。
- [ ] 没有假定 TypeScript SDK 一定有 Python SDK 的方法。
- [ ] 没有把 token、完整环境变量或 stderr 原文写入 Renderer/历史。
- [ ] 没有为了 Qoder 修改 Rust 或引入新的全局协议。
- [ ] 没有只改 Picker 而遗漏 state、route、probe、icon 和恢复分支。
- [ ] 没有在未决定产品范围时擅自加入预装发行清单。

## 21. 官方资料和仓库参考

### Qoder 官方资料

实现前重新阅读以下页面，并以安装版本的类型定义为最终依据：

- SDK References（用户指定页面）：<https://docs.qoder.com/zh/cli/sdk/references>
- TypeScript References：<https://docs.qoder.com/zh/cli/sdk/references-typescript>
- Quick Start：<https://docs.qoder.com/zh/cli/sdk/quick-start>
- How It Works：<https://docs.qoder.com/cli/sdk/how-it-works>
- Input Modes：<https://docs.qoder.com/cli/sdk/input-modes>
- Streaming Output：<https://docs.qoder.com/cli/sdk/streaming-output>
- Session Control：<https://docs.qoder.com/cli/sdk/session-control>
- Session Storage：<https://docs.qoder.com/cli/sdk/session-storage>
- Cost and Usage：<https://docs.qoder.com/cli/sdk/cost-usage>
- Model Policy：<https://docs.qoder.com/cli/sdk/model-policy>
- Checkpoint：<https://docs.qoder.com/cli/sdk/checkpoint>
- Permissions：<https://docs.qoder.com/cli/sdk/permissions>
- User Input：<https://docs.qoder.com/cli/sdk/user-input>
- Hooks：<https://docs.qoder.com/cli/sdk/hooks>
- Agents：<https://docs.qoder.com/cli/sdk/agents>
- Plugins：<https://docs.qoder.com/cli/sdk/plugins>
- Errors：<https://docs.qoder.com/cli/sdk/errors>
- CLI Reference：<https://docs.qoder.com/cli/cli-reference>
- CLI in Scripts：<https://docs.qoder.com/cli/run-in-scripts>
- CLI Permissions：<https://docs.qoder.com/cli/permissions>
- ACP：<https://docs.qoder.com/cli/acp>
- Installation：<https://docs.qoder.com/cli/installation>

### 本仓库参考

- 公共 session 契约：`packages/harness-adapter/src/text-session.ts`
- 插件 factory 契约：`packages/harness-adapter/src/plugin.ts`
- Host usage：`packages/harness-adapter/src/usage.ts`
- Harness 模型和能力：`packages/shared-contracts/src/harness-models.ts`
- Plugin Manifest：`packages/shared-contracts/src/harness-plugins.ts`
- 插件运行时说明：`docs/harness-plugin-runtime.md`
- Claude SDK 适配器：`packages/adapters/claude-code/`
- Pi CLI/RPC 适配器：`packages/adapters/pi/`
- Kiro ACP 适配器：`packages/adapters/kiro-cli/`
- 预装清单：`scripts/release/harness-plugins.json`
- 插件打包器：`packages/harness-adapter/scripts/build-plugin.mjs`
- 通用外部路由：`packages/protocol-core/src/model-routing.ts`
- Renderer Agent 状态：`packages/renderer-extension/src/agent-selection-state.ts`

## 22. 最后给执行模型的简短指令

先实现后端插件和 fake SDK 测试，再接 Renderer。所有 Qoder 原生细节留在 `packages/adapters/qoder`；所有模型/历史/权限能力都以运行时事实为准；不支持的能力声明为 false；不要为了看起来完整而伪造 fork、rollback、thinking 或 file change。只有在本地测试通过并明确产品需要时，才加入预装发行清单。
