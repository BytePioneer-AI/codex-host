# Pi 的 subagent 映射

Pi 核心没有统一的 subagent 协议。当前 Adapter 接入 **@gotgenes/pi-subagents** 的公开服务、生命周期事件及父会话记录，同时保留 **nicobailon 的 `pi-subagents`** 异步 Host 协议和同步 workflow 摘要。不是对所有同名工具的通用支持。gotgenes 对照 `25.0.1` / Pi `1.4.0` 的源码与真实父子历史；nicobailon 协议依据为 `pi-subagents@0.70.0`。

## gotgenes 身份、状态和子会话

- Host 仅在自己启动的 Pi RPC 进程中通过 `--extension` 加载只读观察扩展。扩展读取插件公开的 `SubagentsService`（公开的 `Symbol.for("@gotgenes/pi-subagents:service")` 注册点），订阅 `subagents:created/started/completed/failed/resuming/resumed` 等事件；不注册替代子代理工具，不修改 Pi 全局配置，也不发模型请求。
- 服务注册晚于观察扩展时仍可发现。首次发现后绑定该父 extension 实例的服务，避免同进程子 SDK 覆盖全局注册点；父 session switch 仅更新上下文，reload 的新实例重新绑定。生命周期事件触发快照，每次最多 128 个公开记录，1 秒周期补齐异步 session 创建后的 `outputFile` 和公开 `toolUses` / 用量进展；相同快照不重复发送，Pi shutdown 清除定时器。仅使用结构化 `setWidget` 桥接，不解析插件的 TUI 文本或 callback widget。
- 真实 `agentId` 映射为 `pi-gotgenes-v1:` 身份；父 Session 仍由公共 Host 关系隔离。任务 description 用作子任务标题，type 用作角色，工具结果明确给出的 provider/model 原样保留。queued、running、completed、error、stopped、aborted 分别映射为原生卡片可表达的待运行、运行、完成、失败、中断。只有 background 回执而尚无服务状态时保留 pending，不猜是否已经获得运行槽。
- 前台阻塞工具尚未返回时即可通过服务发现并展示卡片；工具结果到达后沿同一子身份补齐 Model，不再生成第二张卡片。父 Turn 完成后，后台进展只发布子状态和 transcript 变化，不向已终结 Turn 追加 Item。缺失快照不代表结束；resume 沿用同一实际 Agent 身份。
- 活跃父 Session 中通过服务快照的 `outputFile` 读取子会话；重新打开时从父活动分支的 `subagents:record` 和结构化工具结果恢复路径、状态和身份。UI 只传子身份，不能指定文件。读取要求 Pi v3 header 的 `parentSession` 与父 Native Session ID 一致，最多 8 MiB，不跟随文件本身的符号链接。
- 子会话展示真实消息、工具及结果，移除可写 checkpoint；入口为只读 transcript，不承诺直接续写、停止或恢复子 Agent。原插件仍负责这些操作。文件未产生、清理、超限或归属不匹配时明确返回不可用，不伪造空成功。
- 进度来自公开服务的工具次数及实际终态；插件 TUI 的动画、当前工具名、细粒度 token 流不在公开快照合同中，未虚构这些数据。未安装 gotgenes 时观察扩展保持无输出，不影响其他插件协议。

## nicobailon 接入链路


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

## 自主执行与历史边界

前一条 Assistant 已终结后，原生 custom 消息触发的独立执行单独成轮，输入为空；实时完成和历史读取均使用该 custom Entry ID，不使用 Provider 的 response ID 或随机身份。process 插件的 custom 通知后若紧接完全空文本 user 唤醒，仍归属该 custom 边界；非空 user 或图片输入保持真实用户轮。执行中的 custom 注入、没有后续执行的状态消息不单独成轮。RPC 在稳定完成后读取原生 Entry，并核对该轮首条 Assistant 的响应身份或原生时间戳；后续原生轮已追加时按实际身份定位，不只取最后一轮。无法匹配时报告故障，不把旧历史认作本轮。

自主回合的忙状态从原生 `agent_start` 起公布，工具和正文按到达顺序实时转发，不等稳定完成才显示。活动 run 使用临时关联 ID 隔离事件；它不替代完成时确认的 Native Turn 身份。用户输入在异步预检之后重新检查原生占用，未接纳的输入返回可重试 busy，不会先显示接纳后因内部 active Turn 冲突失败。详见 [可见进度与流式内容](pi-progress.md)。

Pi 1.4 可以在 `agent_settled` 后立即执行 deferred action，再次开始模型运行。Adapter 用 `agent_start` 代际隔离确认期间的新轮帧（最多 8 MiB），旧轮确认和取消应答完成后顺序处理。gotgenes 状态帧也经过同一代际边界，并携带原生请求轮／自主轮归属；自主快照不能因同步回放早于旧 Host 收尾而在旧轮创建子卡，子卡由对应自主轮的工具事件建立。若 `get_state` 已是 Streaming，则在 RPC 命令时限内等待实际新 run 的事件证据，没有证据仍报错。新轮的 `agent_settled` 不被旧确认吞掉，关闭和故障回收缓冲与等待器。已进入收尾的父请求读取身份时，自主轮完成回执可以排队，但不会混入用户正文；真实同时运行的 Host 操作仍被拒绝。

用户轮后立即跟随 custom 自主轮时，用户轮保留自己的 Native Turn 身份，不伪造可回滚 checkpoint。Pi 1.4 的 Codex provider 有时将 AbortSignal 记录为 `stopReason: error` 与确切 `errorMessage: This operation was aborted`；该原生形状与 `stopReason: aborted` 一样映射为中断，其他模型错误仍是失败。

Pi 的 Fork 只使用精确可表达的位置：下一轮是用户消息时切在该消息之前，末轮使用当前位置的原生副本。某轮之后紧跟 custom 续写时，该轮不提供 Checkpoint，也不把续写静默带入分支。末轮为 custom 自主执行时，单独撤销该轮返回 `unsupported`；末轮为用户执行时，撤销保留其前面的自主执行。

## 历史和限制

- 父历史中的成功异步启动结果指向插件公开的 `status.json`。恢复时仅接受 lifecycle artifact v3，要求 run ID 和父 Session ID 精确匹配；每次最多读取最近 128 个 run，每文件最多 1 MiB，不跟随状态文件本身的符号链接。
- 状态快照可能截断。缺失的 run/child 不等于结束、停止或删除；已观察到的状态保留。磁盘历史恢复目前投影直接 steps；嵌套单任务依赖实时状态快照。嵌套 workflow 的内部 steps 暂不生成链接，避免将其 ID 错配到外层 run。
- 任务工件被清理、格式不支持或归属不匹配时，不伪造历史卡片。已持久化子 Thread 的读取仍交给原生检查协议，可能返回 `stale` / `not_found`。
- 实时发现依赖插件发出异步状态 widget。关闭该 widget 时，不承诺实时卡片；公开状态工件仍可用于父历史恢复。
- 父 Turn 结束后才出现的新 workflow 子任务，在下次父历史读取时补入；当前不会为 widget 更新凭空创建一个新的父模型 Turn。
- 缺少 `workflowChildren` 身份摘要的同步单 Agent 调用、除上述 gotgenes 外的其他 Pi subagent 插件、Host 侧直接停止/恢复子任务不在当前范围内。实际操作仍由 Pi 插件处理。

## 验证

gotgenes 新增回归覆盖服务晚注册、同进程 child 覆盖全局注册点、父 session switch / shutdown、前台工具返回前显示、后台终态、缺失快照、历史不覆盖运行中状态、查询结果不覆盖真实角色、子文件父归属与只读边界。2026-10-27 已通过独立打包 Loader 的真实 Pi 1.4.0 测试：冷读 2 个真实子任务并读取双方 transcript；新建父子均 Astra/high 的单子任务，收到 running → completed，运行中和终态 transcript 可读，父子结果标记一致。公共 Codex 投影产生 collab 卡片事件；实际 Desktop 视觉验收由集成阶段完成。真实组合测试还验证 process 自动通知后的空 user 唤醒、子代理完成通知与用户取消的交错、独立 deferred 自主轮和立即提交的用户替换输入，5 个原生轮的实时/历史身份与状态分别保留。

聚焦测试覆盖协议版本/尺寸校验、身份隔离、并行子任务、父取消后后台状态、缺失快照不推断完成、历史归属、RPC 相关性、命令缺失、超时和关闭。已执行本机无模型探针验证命令发现及 `not_found` 检查响应。同步 workflow 已使用用户实际四任务会话重放验证：4 个原生子任务映射为 4 个接收 Thread 状态，且四份原生子会话均可读取。未另行启动付费模型任务，Codex Desktop 可视验收尚未执行。

上游参考：[observability](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md)、[tool reference](https://github.com/nicobailon/pi-subagents/blob/main/docs/tool-reference.md)。
