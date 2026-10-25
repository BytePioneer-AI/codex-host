# 外部 Thread 的「调整方向」

codexhost 对外部 Harness Thread 保留一个「调整方向」操作，按当前 Session 的能力选择送达方式：

- **原生同轮插入**：Session 此刻声明 `capabilities.steer` 时，Host 发送公共命令 `turn.steer`，由 Adapter 调用 Harness 自己的插入原语，在原生安全边界把输入送入**当前 Turn**，不取消、不另起 Turn。
- **停止后重发（退路）**：其余情况下，Host **取消当前 Turn，等待它终结，再自动执行本次新输入**。任何不确定能并入当前 Turn 的情况都走这条路径，保证不比没有原生插入时差。

用户继续使用 Codex Desktop 原有按钮、跟进处理方式设置和单条消息反向操作，不需要手动停止后重发。官方 Codex Thread 仍透传原生 `turn/steer`，不改变同轮追加输入的语义。当前只有 Claude Code 会声明 `capabilities.steer`，并且只在确定插入会并入当前 Turn 时声明；其条件与原生依据见 [`../harnesses/claude-code/claude-code-steer.md`](../harnesses/claude-code/claude-code-steer.md)；其他 Adapter 对 `turn.steer` 返回 `unsupported`，保持停止后重发。

## 原生同轮插入

- `HarnessSessionCapabilities.steer` 表示 Session 当前是否允许原生同轮插入；缺省表示不支持。直连 Adapter 可用普通属性或实时 getter。跨进程 Session 可提供 `readCapabilities()`，Host 在预判和未指定送达方式的执行请求中优先读取它；读取失败不使用旧快照发送输入。
- Harness Broker 通过 `session.readCapabilities` 按需读取原生 Session 的能力，不轮询、不要求 Adapter 发布能力变更事件。打开响应声明是否支持这项查询；连接旧 Broker 时保持停止后重发，不向其发送未知方法。普通 Adapter 不必实现 `readCapabilities()`，Broker 可以直接读取它的 `capabilities`。
- 能力查询不是对执行时机的预留。Adapter 在 `turn.steer` 最终写入之前必须再次检查目标 Turn 和原生插入条件；不满足时不写入并拒绝。GUI 已选择同轮展示时，拒绝只报错，不偷偷改走新轮。
- `TurnSteerCommand { turnId, input }` 定义在 `packages/harness-adapter/src/text-session.ts`。Adapter 在 Harness 确认接受或入队后返回 `{ accepted: true }`，不等待插入实际执行完毕。返回失败即表示 Harness **没有收下**这条输入。已经写入但丢失回执不能作为未收下处理；Broker 对无法确认结果的请求抛错，不转换成触发停止后重发的拒绝结果。没有原生插入的 Adapter 用 `unsupportedSteer()` 拒绝。
- `ExternalTurnSteering`（`packages/host-runtime/src/external-turn-steering.ts`）对两种送达方式统一校验非空文本、`expectedTurnId` 和 `threadId + clientUserMessageId` 去重，并按以下顺序决定送达方式：
  1. `turn/steer` 带有 `codexhostSteerDelivery`（Renderer 已经按该方式展示）时照它执行：`newTurn` 停止后重发；`activeTurn` 原生插入，Harness 没收下时报错、不改走退路，避免和 Desktop 已有的展示不一致。
  2. 输入是 Harness 命令（Session 提供命令、文本以 `/命令` 开头）时停止后重发，命令照常解析和执行。
  3. 其余情况读取实时的 `capabilities.steer`：为 `true` 时原生插入，Harness 没收下就改走停止后重发；如果当前 Turn 在此期间已经结束，直接把输入作为下一个 Turn 启动。
- `turn/steer` 回执包含 `turnId` 和 `delivery`：`activeTurn` 表示送入当前 Turn，`newTurn` 表示停止旧 Turn 后开始了新 Turn。
- `codexhost/thread/steering/inspect { threadId, text? }` 按同样的规则（第 2、3 步）预先给出送达方式；读取失败返回 `-32081`。

原生同轮插入成功后，Host 在当前 Turn 发布 `userMessage` Item。Desktop 提交带 `clientUserMessageId` 时，投影把它写入 Item 的 `clientId`，用于结算 Desktop 的乐观 steer 消息；Adapter 不发布这条 Host Item。Host 会让并发的 Turn 终态投影等待这条已接受输入完成实时投影，避免 Harness 接受输入后立刻结束时遗漏乐观消息结算。刷新后的历史仍完全按 Adapter 的原生历史解析，不把不同的原生 Turn 强行合并。

### 后续 Adapter 接入

已有原生同轮插入能力的 Harness，只需在自己的 Adapter 中声明能力、处理 `turn.steer`、保证写入前校验与失败语义，并适配本 Harness 的原生历史读取。Host、Broker 和 Renderer 不按 Harness ID 增加分支。公共输入目前仅支持文本；非同轮的排队原语不能声明为此能力。真实原生执行、取消和历史行为仍需由各 Adapter 验证。

### Fork 与撤销窗口

原生历史可能已经在插入点分轮，而 Desktop 在重新读取前仍把内容显示为一个 Turn。Host Runtime 按 Host Thread ID 在内存中拥有 `steeredTurnIds`，记录插过队的 Host Turn：

- Fork 先解析请求的实际 Checkpoint 边界，再检查该边界的 Host Turn；省略 `lastTurnId` 或使用 `beforeTurnId` 不会绕过保护。
- 对 steered 边界的 Fork，以及撤销范围内包含 steered Turn 的撤销，返回 `-32080` 并要求重新打开 Thread。原生历史只会在 steered Turn 内多分出一轮，它之后的 Turn 仍与原生 Turn 一一对应，所以只撤销之后的 Turn 不受限制。
- 空闲释放只卸载 Native Session，不等于 Desktop 已读取历史；Session 恢复后继续使用同一组未读标记。
- Desktop 重新读取历史并成功收到 Turn 边界后，只清除实际返回的已结束 Turn 的标记。只读取 Items 或未包含该 Turn 的分页不会解除保护。
- 标记不落盘；Host 进程重启后自然消失。

这项保护只覆盖 Desktop 视图与原生历史暂时不一致的窗口，不改变 Fork 或回退的持久化格式。

## 停止后重发：所有权与执行

- `AppServerHost` 显式按 Thread 所有权分流 `turn/steer`，外部 Thread 不再落入官方 Account 查找。
- `ExternalTurnSteering` 在取消前校验非空文本输入及 `expectedTurnId`，注册指定旧 Turn 的终态等待，再调用现有 `turn.cancel`。这条路径不调用 Harness 私有接口。
- 取消 acknowledgement 不等于完成。等待旧 Turn 的 Interaction/Item 关闭、终态身份持久化及 Desktop 终态通知写出后，复用普通 `turn/start` 的底层启动函数，分配真实的新 Host Turn ID，返回 `{turnId}`。
- 同 Thread 的其他 start、Harness command、委派 start 不能抢占这个替换过程。若原生自主 Turn 已先开始，替换失败，不取消这个意外的新 Turn。
- 取消与旧轮终态等待合计最多 20 秒，短于当前 Desktop 的 30 秒提交超时。超时、Session fault、输出流结束、Host 关闭/断连、显式停止替换、旧轮失败或持久化失败均不再自动启动新轮。新轮启动本身仍遵循原有 Adapter admission 语义；客户端超时不意味着它没有被接受。
- 同一连接内以 `threadId + clientUserMessageId` 合并相同请求，并保留有界的成功交付回执供 outcome-unknown 重试使用；同一消息 ID 不得携带不同的旧轮 ID 或输入。不承诺跨 Host 重启或回执淘汰后的 exactly-once。

普通停止仍调用 Adapter 原来的取消实现。原生进程、工具和子任务的退出速度及恢复策略属于 Adapter；本功能没有增加统一的强杀策略，也不会回滚旧轮已经完成的文件修改。

## Renderer 接入

只在 Host 实现 cancel/start 不足以接入官方界面：官方 steer 会把乐观消息放在旧 Turn，旧轮 interrupted 时又可能将它恢复到暂停队列。

`renderer-external-steering.ts` 在已确认的 RequestManager 上包装 `steerTurn`。Desktop Manager 同时是 `RpcTarget`，跨组件 RPC 禁止访问实例自身属性（即使该属性是函数）。因此对原型方法的包装放在该实例专属的原型层上，不用 `manager.sendRequest = ...` 创建实例属性，也不修改共享类原型。卸载时移除覆盖并恢复原型查找，不能仅赋回原函数；否则模型和权限列表仍会被 RPC 拒绝。

接入流程：

1. 带上本次要插入的文本调用 `codexhost/thread/steering/inspect`，读取送达方式（`official`、`activeTurn` 或 `newTurn`）。Host 不支持该方法（`-32601`，较旧或远程的 Host）时，改用 `codexhost/thread/ownership/list`：外部 Thread 按 `newTurn` 处理；两个方法都不支持时视为官方 app-server，先确认是原生 Codex Thread。`official` 与 `activeTurn` 走原函数，使用 Desktop 自己的 steer 展示，乐观消息属于当前 Turn；`activeTurn` 期间发出的 `turn/steer` 带上 `codexhostSteerDelivery: "activeTurn"`，让 Host 照这个选择执行而不重新判断。follower 窗口继续使用 Desktop 原有 owner 转发。以下步骤只适用于 `newTurn`。
2. 外部输入使用 Desktop 自己的 `startTurn` 展示流程。新输入从一开始就属于新 Turn 占位，保留 `clientUserMessageId`、输入及附件展示上下文；不创建旧轮 `steeringUserMessage`，不修改官方 transcript 内部实体。
3. 仅将本次 `threadId + clientUserMessageId` 对应的出站 `turn/start` 转成 `turn/steer`，携带原先捕获的 `expectedTurnId` 和 `codexhostSteerDelivery: "newTurn"`。把 Host 的 `{turnId}` 回执转换成正常 start 展示流程需要的 Turn envelope。其他 start、请求选项及官方 steer 不变。
4. 成功后解除本次旧轮 interrupted 引入的队列暂停，保留此前已暂停的消息。失败不自动重试或偷偷排队；Desktop 原有失败提交展示负责保留输入。
5. 绑定卸载时停止新的替换，恢复包装过的方法；尚未发出的替换不能因卸载而意外成为普通 start。

Host 和 Renderer 接入必须配套发布；仅升级 Host、让旧 Renderer 仍创建旧轮乐观 steer 消息，不属于经过接入的产品路径。

### 当前兼容边界

接入点依据 Codex Desktop **26.901.51231 / build 8109** 的 `app-initial-cadb12d4a15e.js`：`steerTurn`、`startTurn`、`sendRequest`、`getTurnCoordinator()` 的 submissionHost，以及队列的 `loadMessages` / `readMessages` / `mutate`。这些是版本相关的 Desktop JavaScript 绑定，不是 Harness SDK 契约。更新 Desktop 后需重新核实。

- 当前公共 Harness 输入仅支持文本。图片等非文本输入、空输入、tool response 在停止前拒绝，不静默丢弃后再取消旧轮。
- 停止后重发复用普通输入启动路径；Harness 命令在该路径中解析执行，不作为原生 steer 文本插入。
- 当前轮尚无确认的 Turn ID 时不猜测目标，也不把过期目标改为另一轮重试。
- 停止后重发时，旧轮和新轮在 Native Session 历史中是两个真实 Turn，不复用旧 ID、不伪造同轮注入，不合并 Fork/Rollback 身份。
- 原生同轮插入的乐观消息结算依据 Codex Desktop **26.915.31945 / build 9922** 的只读 Bundle 核查：`clientId` 等于 `clientUserMessageId` 的 `userMessage` 会结算待定 `steeringUserMessage`。

## 跟进消息队列

Codex Desktop **26.903.61454 / build 8378** 起，在功能开关及 app-server 版本满足条件时使用服务端队列。运行中追加消息会先调用 `thread/queue/list`，再调用 `thread/queue/add`。Desktop **26.1016** 及之后的 Manager 带有 `getStreamRole` 时，`renderer-external-queue.ts` 不再把外部 Thread 从 `serverQueue.isEnabled` 里排除，因此跟进消息走 Host 的 `thread/queue/*`。Host 按官方列表信封返回 `{ data, nextCursor }`。队列里的文本项写成 Desktop `type: "text"`（`input_text` 入队时也转成该类型），并带有 `text_elements` 数组（缺省 `[]`），供 Desktop **26.1021.31345 / build 21828** 读取 `text_elements.length`。空的 `turn/start` 会消费 Host 队列中匹配或队首的跟进文本；队列为空时仍返回 `-32602`。官方 Codex Thread 仍使用原生 app-server 队列。

Avatar overlay 是独立的 Desktop webcontents，在语音、IAB 或 Computer Use 之后可以成为该 Thread 的 stream owner。主窗口的 Renderer Binding 不会注入 overlay；`cpa-live-voice-hook.js` 在 overlay 里发现 RequestManager 后安装 steer 包装，并把 External Thread 的 stream role 视为 owner，使 follower 窗口可以把跟进消息写入 Host `thread/queue/*`。Overlay 作为 owner 通过 `thread/queue/start` 执行队列。缺少 type:text 的 `turn/start` 会从 Host 队列或本地队列条目恢复文本。

没有 `getStreamRole` 的 Desktop 上，`renderer-external-queue.ts` 仍在当前 Manager 的 `getTurnCoordinator().serverQueue.isEnabled(threadId)` 上排除外部 Thread，让 Desktop 继续使用保留的本地队列：

- 只读取同一个 Manager 的 `getConversation(threadId)`，核对 Thread ID 及 Host 投影的保留标记 `modelProvider: "codexhost"`。不根据当前 Agent 选择或 Model 名称猜测，不跨 Host 缓存身份，也不增加 RPC。
- 普通入队、编辑、重排、删除／恢复、暂停和终态后的自动执行仍由 Desktop 原有队列负责，不新增 Host 队列或 Harness 命令。
- 官方 Thread、尚未加载的 Thread 和无 Thread ID 的开关探测保留原函数。Thread 元数据加载后重新读取，不缓存此前的未知结果。旧版 Desktop 没有此后端时不做修改。
- 包装的是队列后端自身的可写普通方法，不修改 Manager 或 Coordinator 的 RpcTarget 方法。卸载恢复原属性；不覆盖后来安装的其他包装。

该边界来自实际代码和运行中开关观察，不代表能确定功能开关何时启用，或断言此接口首次出现于该 Desktop 版本。

### 手动压缩后的自动执行

Codex Desktop **26.924.22138 / build 11645** 的本地队列在 `turnCompleted` 后自动执行下一条消息前，要求最近一个已完成 Turn 含有 `agentMessage`，或含有 `source: "manual"` 的 `contextCompaction`。这个 `source` 不取自 Item 字段：`item/started` 时，Desktop 用自身 `compactThread`（官方 `thread/compact/start`）之前调用的 `registerPendingManualContextCompaction(threadId)` 登记来判定，未登记即为 `"automatic"`。外部 Harness 的 `/compact` 经 `codexhost/thread/command/execute` 或 `turn/start` 进入 Host 命令 Turn，不经过该登记，而各 Adapter 的压缩 Turn 通常没有 Agent Message，因此压缩期间排队的消息不会自动执行（[#414](https://github.com/BytePioneer-AI/codex-host/issues/414)）。

- Host 按命令目录中的 `invocation: "/compact"` 记录显式手动压缩 Turn，在其 `contextCompaction` 的 `item/started` 之前写出 `codexhost/thread/manual-compaction/started { threadId, turnId }`。其他命令 Turn 与普通 Turn 中的自动压缩均不发送该通知；记录在命令失败或 Turn 完成时清除。
- Desktop Renderer 只把方法在其内置 app-server 通知表中的通知交给 Manager（以及 `addNotificationCallback`），`codexhost/*` 方法在这一步被丢弃；Electron 主进程则会把所有 Host 通知原样以 `{ type: "mcp-notification", hostId, method, params }` 投递到窗口 `message` 事件。因此 `renderer-manual-compaction.ts` 按 Host 连接（本机及 SSH）监听窗口 `message`，只接受本窗口（或无 source）的、`hostId` 与该连接一致的通知。仅对已加载、`modelProvider: "codexhost"` 的外部 Thread，且当前窗口不是 follower 时，调用该 Manager 的 `registerPendingManualContextCompaction(threadId)`。窗口消息按到达顺序逐条分发，该登记在紧接着的 `item/started` 被处理前完成并随即被消费；Item 属于同一个进行中的 Turn，登记产生的占位 Item 会被替换。
- 不调用 `compactThread`，不改变压缩执行或 Harness 语义，也不为压缩 Turn 合成 Agent Message。Desktop 缺少该绑定时不安装，保留原有行为；Desktop 对这条未知通知本身不做处理。
- 仅覆盖投影 `contextCompaction` 的命令 Turn。未投影压缩 Item 的 Harness（如 Kimi），以及只有 `commandExecution` 等无回复的非压缩命令 Turn，仍按 Desktop 规则不自动执行。

## 验证

针对性测试：

- `packages/host-runtime/test/app-server-host.broker-steering.test.ts`：非 Claude 的合成 Adapter 经真实 Broker socket 与 Host RPC，验证打开后能力变化、同轮消息投影，以及不支持时停止后重发；不代表该 Harness 的原生 steer 已接入。

- `packages/host-runtime/test/app-server-host.native-steering.test.ts`：原生插入的 `clientId` 投影、送达方式查询、Fork/撤销窗口和重新读取后放行；Harness 没收下时改走停止后重发、`codexhostSteerDelivery` 两种取值都照办、Harness 命令停止后重发、撤销只限制包含 steered Turn 的范围。
- `packages/renderer-extension/test/renderer-external-steering.test.ts`（`steer delivery handshake`）：inspect 带文本、两种展示方式分别标记 `codexhostSteerDelivery`、Host 不支持 inspect 时改用 Thread 所有权。
- `packages/protocol-core/test/codex-ui-projector.test.ts`：插入的 `userMessage` 在实时与历史投影中留在所属 Turn。
- `packages/adapters/claude-code/test/*.test.ts`：Claude Code 的 `priority: "next"` 推入、接受条件、错过 Turn 与历史分轮。
- `packages/host-runtime/test/external-turn-steering.test.ts`：原生插入不取消、失败释放回执、没收下时退回（当前 Turn 已结束则直接启动下一个、正在结束则等待其终态），以及延迟/同步终态、去重、冲突、过期目标、输入预检、超时迟到、fault、关闭、显式停止、自主 Turn 及启动失败。
- `packages/host-runtime/test/app-server-host*.test.ts`：真实 Host 路由、外部不泄漏官方流、取消与启动顺序、响应 gate、同 Thread start 竞争、官方透传。
- `packages/renderer-extension/test/renderer-external-steering.test.ts`：正常 start 占位、唯一输入、无旧轮 steer Item、去重、队列暂停恢复、owner/follower、失败和卸载。
- `packages/renderer-extension/test/renderer-external-steering-rpc.test.ts`：类方法的 RPC 可访问性、模型／权限列表读取、官方与外部 steer、实例隔离、卸载和重复安装，以及卸载期间待定请求的清理。
- `packages/renderer-extension/test/renderer-external-queue.test.ts`：经生产 Adapter 安装路径验证外部入队、已有暂停消息、队列清空后再次入队、同连接官方队列、Manager 隔离、元数据更新、旧版后端和卸载恢复。
- `packages/renderer-extension/test/renderer-overlay-external-followups.test.ts`：avatar overlay 发现 RequestManager 后把 External Thread 视为 stream owner。
- `packages/renderer-extension/test/renderer-external-steering.test.ts`：缺少 type:text 的 queued `turn/start` 从本地队列恢复文本。
- `packages/host-runtime/test/app-server-host.follow-up-queue.test.ts`：Host `thread/queue/add` 与 `thread/queue/start`，空 `turn/start` 消费队列，以及中断恢复后空队列仍返回 `-32602`。
- `packages/host-runtime/test/external-thread-follow-up-queue.test.ts`：入队项补齐 `text_elements`，并把 `input_text` 规范为 `type: "text"`。
- `packages/renderer-extension/test/versioned-renderer-adapter.test.ts`：现有版本化绑定与清理回归。
- `packages/host-runtime/test/app-server-host.manual-compaction.test.ts`：命令菜单与输入 `/compact` 两条路径在压缩 `item/started` 前恰好发送一次通知，普通 Turn 与非 `/compact` 命令 Turn 的自动压缩均不发送。
- `packages/renderer-extension/test/renderer-manual-compaction.test.ts`：经窗口 `mcp-notification` 消息的外部 Thread 登记，follower、未加载／官方 Thread、其他 Host、其他 frame 与非法消息跳过，缺少 Desktop 绑定、卸载，以及按 Host 连接（含 SSH）安装。

实现时还在 Node VM 中回放了上述 Desktop Bundle 的真实 `lun`（普通 start）、`GS`（占位写入）和 `Irn`（旧轮消息恢复）helper：legacy / canonical 历史各验证启动成功与启动失败，检查单条新输入、无旧轮 steer 恢复、失败输入保留。该回放仍模拟了准备器与传输，不是实际窗口或原生 Session 测试。

针对 RpcTarget 实例属性回归，还在运行中的上述版本 Desktop 内通过其真实 `RpcStub` 调用了 `model/list` 和 `permissionProfile/list`，验证原型挂接修复后两者成功返回，并重试了此前失败的只读查询。该检查没有发送新消息、修改权限选择或验证原生 Harness 执行。

针对服务端队列回归，还在 Node VM 中回放了 26.903.61454 Bundle 的真实 Turn Coordinator：修复前复现 `thread/queue/list` 错误，修复后验证入队、编辑、重排、删除／恢复、每次终态后仅启动下一条消息，以及官方服务端队列保留。回放使用合成存储、传输和执行器，不调用原生 Harness。运行中只读探测另外确认了真实 Thread 元数据及开关；用隔离的后端对象验证外部 Thread 被排除、官方 Thread 保持启用，没有修改用户窗口的队列或发送消息。

以上合成测试和只读 RPC 检查不替代真实 Desktop 与各原生 Harness 验收。发布验收应覆盖流式文本、工具运行、Question/Approval、连续提交、已有队列、取消失败、刷新历史，以及多窗口和远端连接。不得把类型检查或合成测试通过称为所有 Harness 的实机兼容性证明。
