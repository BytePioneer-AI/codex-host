# Pi 的 subagent 映射

Pi 核心没有统一的 subagent 协议。当前 Adapter 接入 **nicobailon 的 `pi-subagents`** 的异步 Host 协议及同步 workflow 的版本化子任务摘要；不是对所有同名工具的通用支持。协议依据为 `pi-subagents@0.70.0`，本机无模型 RPC 检查使用 Pi `0.85.1`。

## 接入链路

- `pi-subagent-rpc.ts` 消费 `extension_ui_request / setWidget` 的 `widgetLines`。仅识别 `subagent-async` 上的 `PI_SUBAGENT_ASYNC_JSON:`、`pi-subagents.async-status-snapshot` v1；这些帧不生成模型 Turn 或 Question。
- 原生 `subagent` 工具结果的 `details.asyncId` 与已确认的状态对应后，`pi-subagents.ts` 生成公共 `subagentDelegation`，保留原工具结果。管理/查询调用、没有已支持身份协议的同步单 Agent 结果和未知插件仍为普通工具。
- 同步 workflow 不需要异步 widget：从工具增量及最终结果的 `details.workflowChildren` v1 读取实际 child ID、状态和 Model，以 workflow run ID + child ID 建立稳定身份。多个结果的 `index` 可以都是 0，不能拿它当子任务身份。工具报错时仍投影已启动子任务的失败状态；运行期间和历史恢复使用相同身份。
- Workflow 的实际子任务分别映射为接收 Thread；`host-step` 检查不是 Agent，不生成子 Thread。身份包含根 run ID 和原生 child ID，不能仅用 agent 名称或数组序号区分任务。
- 父 Turn 内更新委派卡片，之后通过公共 `subagent.state.changed` / `subagent.transcript.changed` 更新已观察到的子任务。父工具返回或父 Turn 取消均不证明后台子任务结束；不伪造原生停止。
- 子 Thread、父子关系和 Desktop 卡片投影继续使用公共 Host 链路。没有新增 Pi 专用 Host/Renderer 分支，没有依赖或启动第二套 subagent 引擎。

## 子会话读取

Adapter 优先复用正在运行的父 Pi RPC Session；父 Session 不在内存时，以持久化引用恢复临时父连接，校验 Session ID 和 cwd，读取后关闭。

**同步 workflow**：从父会话当前分支的原生工具结果定位对应 workflow/child，读取该结果引用的 Pi v3 子 Session 文件（最多 8 MiB，只读，不启动子模型或子进程）。子记录的 Turn 引用绑定父 Native Session 并带子任务命名空间，且不提供可写 checkpoint。文件已清理、超限或不支持时，若父结果保留 `finalOutput`，则明确标注为原生结果摘要，而非完整会话；没有记录时返回可重试错误。UI 提供的 child ID 不包含文件路径。

**异步任务**：读取先通过 `get_commands` 确认 `subagents-inspect-rpc` 是原生扩展命令，再发送 `/subagents-inspect-rpc <requestId> <runId> [childId] --lines 200`。缺少命令时不发送普通 Prompt，避免误触模型。响应来自 `subagent-inspect` 的 `PI_SUBAGENT_INSPECT_JSON:`，必须是 v1、匹配请求和目标身份。忽略无对应请求、撤回、损坏和未知版本的帧；超时和关闭会结束等待。

此接口提供的是**原生有界转写窗口**，不是完整可续写 Session：最多 200 条消息和 64 KiB；保留原生截断提示。原生未提供任务文本时不猜测（例如 fork 上下文）。工具转写以带角色/工具名的文本展示，不捏造缺失的工具参数。`foreign_session`、`not_found`、`stale` 等原生错误不会降级成空的成功快照。

## 历史和限制

- 父历史中的成功异步启动结果指向插件公开的 `status.json`。恢复时仅接受 lifecycle artifact v3，要求 run ID 和父 Session ID 精确匹配；每次最多读取最近 128 个 run，每文件最多 1 MiB，不跟随状态文件本身的符号链接。
- 状态快照可能截断。缺失的 run/child 不等于结束、停止或删除；已观察到的状态保留。磁盘历史恢复目前投影直接 steps；嵌套单任务依赖实时状态快照。嵌套 workflow 的内部 steps 暂不生成链接，避免将其 ID 错配到外层 run。
- 任务工件被清理、格式不支持或归属不匹配时，不伪造历史卡片。已持久化子 Thread 的读取仍交给原生检查协议，可能返回 `stale` / `not_found`。
- 实时发现依赖插件发出异步状态 widget。关闭该 widget 时，不承诺实时卡片；公开状态工件仍可用于父历史恢复。
- 父 Turn 结束后才出现的新 workflow 子任务，在下次父历史读取时补入；当前不会为 widget 更新凭空创建一个新的父模型 Turn。
- 缺少 `workflowChildren` 身份摘要的同步单 Agent 调用、其他 Pi subagent 插件、Host 侧直接停止/恢复子任务不在当前范围内。实际操作仍由 Pi 插件处理。

## 验证

聚焦测试覆盖协议版本/尺寸校验、身份隔离、并行子任务、父取消后后台状态、缺失快照不推断完成、历史归属、RPC 相关性、命令缺失、超时和关闭。已执行本机无模型探针验证命令发现及 `not_found` 检查响应。同步 workflow 已使用用户实际四任务会话重放验证：4 个原生子任务映射为 4 个接收 Thread 状态，且四份原生子会话均可读取。未另行启动付费模型任务，Codex Desktop 可视验收尚未执行。

上游参考：[observability](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md)、[tool reference](https://github.com/nicobailon/pi-subagents/blob/main/docs/tool-reference.md)。
