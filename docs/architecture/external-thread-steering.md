# 外部 Thread 的「调整方向」

codexhost 对外部 Harness Thread 保留一个「调整方向」操作，按当前 Session 的能力选择送达方式：

- **原生同轮插入**：Session 此刻声明 `capabilities.steer` 时，Host 发送公共命令 `turn.steer`，由 Adapter 调用 Harness 自己的插入原语，在原生安全边界把输入送入**当前 Turn**，不取消、不另起 Turn。
- **停止后重发（退路）**：其余情况下，Host **取消当前 Turn，等待它终结，再自动执行本次新输入**。写入前不能并入当前 Turn 或 Harness 明确未接纳时走这条路径；写入后交付结果不确定则报错，不自动重发。

用户继续使用 Codex Desktop 原有按钮、跟进处理方式设置和单条消息反向操作，不需要手动停止后重发。官方 Codex Thread 仍透传原生 `turn/steer`，不改变同轮追加输入的语义。Claude Code、Pi 和 OMP 按各自原生执行窗口动态声明 `capabilities.steer`；具体条件见 [Claude](../harnesses/claude-code/claude-code-steer.md)、[Pi](../harnesses/pi/pi-steer.md)、[OMP](../harnesses/omp/omp-steer.md)。其余 Adapter 对 `turn.steer` 返回 `unsupported`，保持停止后重发。

## 原生同轮插入

- `HarnessSessionCapabilities.steer` 表示 Session 当前是否允许原生同轮插入；缺省表示不支持。直连 Adapter 可用普通属性或实时 getter。跨进程 Session 可提供 `readCapabilities()`，Host 在预判和未指定送达方式的执行请求中优先读取它；读取失败不使用旧快照发送输入。
- Harness Broker 通过 `session.readCapabilities` 按需读取原生 Session 的能力，不轮询、不要求 Adapter 发布能力变更事件。打开响应声明是否支持这项查询；连接旧 Broker 时保持停止后重发，不向其发送未知方法。普通 Adapter 不必实现 `readCapabilities()`，Broker 可以直接读取它的 `capabilities`。
- 能力查询不是对执行时机的预留。Adapter 在 `turn.steer` 最终写入之前必须再次检查目标 Turn 和原生插入条件；不满足时不写入并拒绝。GUI 已选择同轮展示时，拒绝只报错，不偷偷改走新轮。
- `TurnSteerCommand { turnId, input }` 定义在 `packages/harness-adapter/src/text-session.ts`。Adapter 在 Harness 确认接受或入队后返回 `{ accepted: true }`，不等待插入实际执行完毕。返回失败即表示 Harness **没有收下**这条输入。已经写入但丢失回执不能作为未收下处理；Broker 对无法确认结果的请求抛错，不转换成触发停止后重发的拒绝结果。没有原生插入的 Adapter 用 `unsupportedSteer()` 拒绝。
- `ExternalTurnSteering`（`packages/host-runtime/src/external-turn-steering.ts`）对两种送达方式统一校验非空文本、`expectedTurnId` 和 `threadId + clientUserMessageId` 去重，并按以下顺序决定送达方式：
  1. `turn/steer` 带有 `codexhostSteerDelivery`（Renderer 已经按该方式展示）时照它执行：`newTurn` 停止后重发；`activeTurn` 原生插入，Harness 没收下时报错、不改走退路，避免和 Desktop 已有的展示不一致。
  2. 输入是 Harness 命令（Session 提供命令、文本以 `/命令` 开头）时停止后重发，命令照常解析和执行。
  3. 其余情况读取实时的 `capabilities.steer`：为 `true` 时原生插入，Harness 没收下就改走停止后重发；如果当前 Turn 在此期间已经结束，直接把输入作为下一个 Turn 启动。
- 原生调用抛错表示交付结果不确定，不触发停止后重发。Host 保留有界的失败回执，防止同一消息身份被自动重试；若输入来自队列，恢复原位置并禁止 Host 自动推进它，包括后续其他 Turn 完成之后。输入钩子的副作用不能假定已撤销；用户应检查影响后再决定手动发送或删除，见[队列执行语义](external-thread-queue.md#执行语义)。
- `turn/steer` 回执包含 `turnId` 和 `delivery`：`activeTurn` 表示送入当前 Turn，`newTurn` 表示停止旧 Turn 后开始了新 Turn。
- `codexhost/thread/steering/inspect { threadId, text? }` 按同样的规则（第 2、3 步）预先给出送达方式；读取失败返回 `-32081`。

原生同轮插入成功后，Host 在当前 Turn 发布 `userMessage` Item。Desktop 提交带 `clientUserMessageId` 时，投影把它写入 Item 的 `clientId`，用于结算 Desktop 的乐观 steer 消息；Adapter 不发布这条 Host Item。Host 会让并发的 Turn 终态投影等待这条已接受输入完成实时投影，避免 Harness 接受输入后立刻结束时遗漏乐观消息结算。刷新后的历史仍完全按 Adapter 的原生历史解析，不把不同的原生 Turn 强行合并。

### 后续 Adapter 接入

已有原生同轮插入能力的 Harness，只需在自己的 Adapter 中声明能力、处理 `turn.steer`、保证写入前校验与失败语义，并适配本 Harness 的原生历史读取。Host、Broker 和 Renderer 不按 Harness ID 增加分支。公共输入目前仅支持文本；只有原生控制流能证明输入会进入尚未结束的当前 Turn 时，才可声明此能力；单纯 queued／入队回执不足。真实原生执行、取消和历史行为仍需由各 Adapter 验证。

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
- 同一连接内以 `threadId + clientUserMessageId` 合并相同请求，并保留有界的成功回执与结果不确定的失败回执；同一消息 ID 不得携带不同的旧轮 ID 或输入。不承诺跨 Host 重启或回执淘汰后的 exactly-once。

普通停止仍调用 Adapter 原来的取消实现。原生进程、工具和子任务的退出速度及恢复策略属于 Adapter；本功能没有增加统一的强杀策略，也不会回滚旧轮已经完成的文件修改。

## Renderer 接入

只在 Host 实现 cancel/start 不足以接入官方界面：官方 steer 会把乐观消息放在旧 Turn，旧轮 interrupted 时又可能将它恢复到暂停队列。

### 主进程 Manager 的原生 RPC 路径

Desktop **26.1029.61003 / build 24614** 的提交和队列协调器由主进程拥有。Renderer 的 `main-process-rpc` 路由不是完整 Manager，不能在它上面调用 `startTurn` 或修改内部队列。

- `desktop-control/renderer-rpc-steering.ts` 通过 CDP 查找 `collectAppStateSnapshot` 的真实 Closure，核对 Controller 方法组合、函数身份和当前 React root 的 Scope 身份；只有唯一匹配才安装。发现过程不导入模块、执行模块工厂或打开主进程 Inspector，临时句柄统一释放。
- `renderer-rpc-steering.ts` 包装该 Controller 的 `forHost`，保留原生 RPC 的 await、dup 和 lease 行为，只拦截 Coordinator 的 `sendMessage` / `sendQueuedMessageNow` preparation callback。实际提交、乐观消息、附件和排队执行仍由原生 Coordinator 拥有；主进程 Manager 本身不变。
- `official` 保留原生 preparation；不支持 Host 扩展的 stock app-server 先验证原生 Thread 所有权。`activeTurn` 保留 steer preparation；`newTurn` 使用同一原生 callback 的 start preparation，并设置 `afterInactiveTurnId`，使 Desktop 为替换 Turn 创建正常 start 展示。
- 两种外部送达方式均在 `additionalContext.codexhost_external_steering` 中携带 `{ kind: "application", value: JSON.stringify({ expectedTurnId, clientUserMessageId, delivery }) }`。该字段经过原生请求白名单保留。Host 校验消息身份后，把标记的外部 `turn/start` 交给现有停止后重发流程，返回正常 `{ turn }` envelope；`activeTurn` 的 `turn/steer` 不得因能力变化偷偷变成新轮。
- 新轮接受后，只移除本次队列消息。确认替换 Turn 仍在执行或正常完成后，才恢复中断暂停队列；显式停止或失败保留暂停。若提交前已有另一条因中断暂停的消息，则拒绝本次替换并要求先处理它，避免原生 resume-all 接口恢复先前暂停项。读取队列有超时，subscription lease 必须释放。
- 原生 Coordinator 对每次提交都先以 `steer` 模式调用 preparation，线程空闲时也一样。因此先读 `getThreadExecutionState`：Thread 未加载或没有进行中的 Turn 时，不查询 Host、不加标记，原样交回原生流程，由它走普通 start。只有 Thread 确实在运行时才进入上述分流。
- Composer 在 Thread 运行中直接提交且送达方式为 `newTurn` 时，包装把 `acceptLocally` 改为 `false`。否则消息先进入本地队列：替换需要先停旧轮，超过原生 250ms 的队列行显示延迟，旧轮 interrupted 又会给它打上暂停标记，界面闪出“队列已暂停”。这是原生支持的直接提交路径，消息由 start 的乐观展示接管；失败时保留在 Composer 并显示错误。官方 Thread、`activeTurn`、空闲 Thread 和判断失败时保留原生请求。
- 目标 Turn 不可确认、连接更换、绑定卸载或 preparation 失败时，发送前拒绝；已经接受的消息不因清理失败重发。旧 Turn 恰好在提交途中结束时，带标记的 `turn/start` 会以 `-32074` 被拒绝，队列条目恢复原位或文字留在 Composer，不自动重发。
- 绑定未就绪时，只有外部 Composer 的提交保持禁用；Adapter 总体状态仍为 `ready`，原因字段报告 `native-steering-policy-unavailable`，官方 Codex 提交不受影响。发现失败不抛出，也不重建 Renderer Session；Controller 的监控循环按 5 秒起、最长 5 分钟的退避重试，避免反复遍历堆。

### Renderer 内 Manager 的路径

`renderer-external-steering.ts` 在已确认的 RequestManager 上包装 `steerTurn`。Desktop Manager 同时是 `RpcTarget`，跨组件 RPC 禁止访问实例自身属性（即使该属性是函数）。因此对原型方法的包装放在该实例专属的原型层上，不用 `manager.sendRequest = ...` 创建实例属性，也不修改共享类原型。卸载时移除覆盖并恢复原型查找，不能仅赋回原函数；否则模型和权限列表仍会被 RPC 拒绝。

接入流程：

1. 带上本次要插入的文本调用 `codexhost/thread/steering/inspect`，读取送达方式（`official`、`activeTurn` 或 `newTurn`）。Host 不支持该方法（`-32601`，较旧或远程的 Host）时，改用 `codexhost/thread/ownership/list`：外部 Thread 按 `newTurn` 处理；两个方法都不支持时视为官方 app-server，先确认是原生 Codex Thread。`official` 与 `activeTurn` 走原函数，使用 Desktop 自己的 steer 展示，乐观消息属于当前 Turn；`activeTurn` 期间发出的 `turn/steer` 带上 `codexhostSteerDelivery: "activeTurn"`，让 Host 照这个选择执行而不重新判断。follower 窗口继续使用 Desktop 原有 owner 转发。以下步骤只适用于 `newTurn`。
2. 外部输入使用 Desktop 自己的 `startTurn` 展示流程。新输入从一开始就属于新 Turn 占位，保留 `clientUserMessageId`、输入及附件展示上下文；图片单独发送或从队列「调整方向」时同样保留预览条目，不要求额外输入文字。Host 在停止旧轮前校验文件引用；不创建旧轮 `steeringUserMessage`，不修改官方 transcript 内部实体。
3. 仅将本次 `threadId + clientUserMessageId` 对应的出站 `turn/start` 转成 `turn/steer`，携带原先捕获的 `expectedTurnId` 和 `codexhostSteerDelivery: "newTurn"`。把 Host 的 `{turnId}` 回执转换成正常 start 展示流程需要的 Turn envelope。其他 start、请求选项及官方 steer 不变。
4. 成功后解除本次旧轮 interrupted 引入的队列暂停，保留此前已暂停的消息。失败不自动重试或偷偷排队；Desktop 原有失败提交展示负责保留输入。
5. 绑定卸载时停止新的替换，恢复包装过的方法；尚未发出的替换不能因卸载而意外成为普通 start。

Host 和 Renderer 接入必须配套发布；仅升级 Host、让旧 Renderer 仍创建旧轮乐观 steer 消息，不属于经过接入的产品路径。

### 当前兼容边界

Renderer 内 Manager 的接入点依据 Codex Desktop **26.901.51231 / build 8109** 的 `app-initial-cadb12d4a15e.js`：`steerTurn`、`startTurn`、`sendRequest`、`getTurnCoordinator()` 的 submissionHost，以及队列的 `loadMessages` / `readMessages` / `mutate`。这些是版本相关的 Desktop JavaScript 绑定，不是 Harness SDK 契约。更新 Desktop 后需重新核实。

- 公共 Harness 输入保持文本。`turn/start` 与 `turn/steer` 共用附件规范化：保留 Desktop 的原生图片清单；`localImage` 缺少清单时，按明确的绝对路径补入，不读取或上传文件。内嵌 `image` 必须已有足量的原生文件路径引用；混合输入先逐项扣除 `localImage` 引用，剩余引用数至少覆盖内嵌图片数。远程补存保留的额外旧引用不会导致拒绝。Host 不推测缺失图片的对应关系，也不把 base64 当作提示词；数量覆盖不等于校验文件内容与内嵌图片一致。
- 空输入、无有效路径的图片、未知输入类型，以及直接附图的 Harness 命令，在能力查询或停止旧轮前拒绝。命令与图片应分别提交；命令识别也检查原生附件清单 `## My request:` 后的用户请求，不因清单前缀而把 `/compact` 等命令当作普通提示词。原始输入仍参与重试去重，不能将不同图片视为同一条消息。
- 停止后重发复用普通输入启动路径；Harness 命令在该路径中解析执行，不作为原生 steer 文本插入。
- 当前轮尚无确认的 Turn ID 时不猜测目标，也不把过期目标改为另一轮重试。
- 停止后重发时，旧轮和新轮在 Native Session 历史中是两个真实 Turn，不复用旧 ID、不伪造同轮注入，不合并 Fork/Rollback 身份。
- 原生同轮插入的乐观消息结算依据 Codex Desktop **26.915.31945 / build 9922** 的只读 Bundle 核查：`clientId` 等于 `clientUserMessageId` 的 `userMessage` 会结算待定 `steeringUserMessage`。

## 跟进消息队列

Shared Host 是外部 Thread 队列的唯一所有者，并实现 Codex Desktop 原生 `thread/queue/list|add|update|delete|reorder|start` 协议。`renderer-external-queue.ts` 只验证当前 Desktop 存在 server queue 绑定，不再把外部 Thread 排除在该绑定之外；Desktop 与 Web 因而读写同一组稳定 queued-submission ID。

- Web 的 `turn/start { delivery: "queue" }` 与 Desktop 的 `thread/queue/add` 都写入 Host 队列。Client Channel snapshot 投影绝对队列快照，Web 再映射为 DSH `inbox`；浏览器不累计通知，也不保存第二份执行队列。
- 正常成功终态只取队首并启动一次。取消／中断、失败和 `unknown` 终态分别以 `interrupted`、`failed`、`outcome-unknown` 暂停；unknown outcome 不自动重发。
- 编辑、删除、重排及 `thread/queue/start` 均在 Host 上按稳定 ID 操作。Web 的单条“继续队列”调用 Host 的 send-now；运行中由 `ExternalTurnSteering` 按 Session 能力选择原生同轮插入或 cancel → terminal → replacement，空闲时直接启动所选消息。
- 队列变更同时发送原生 `thread/queue/changed` 和 Client Channel 失效通知。两个入口都重新读取绝对状态；通知本身不是队列事实。
- 队列是 Shared Host 进程状态，不伪装成 Harness 原生历史。删除 Thread 会清理队列；Shared Host 意外退出后不承诺恢复尚未执行的消息。

当前接入覆盖 Codex Desktop **26.1007.30912 / build 20156** 及 Manager 位于主进程的 **26.1027** 的 server queue 协议，见[外部 Thread 跟进消息队列](external-thread-queue.md)。旧版 Desktop 缺少该绑定时不安装 Renderer 接入；Web 仍通过 Client Channel 使用同一个 Host 队列。

### 压缩后的自动执行

队列推进现在由 Shared Host 的确认终态决定，不再依赖某个 Desktop 窗口能否从本地 Turn 内容识别 `agentMessage` 或手动压缩来源。压缩 Turn 只有在 Adapter 报告 `succeeded` 后才会推进队列；`cancelled`、`failed` 或 `unknown` 都会暂停。已有手动压缩通知仍用于 Desktop 的原生呈现兼容，但不再承担共享队列执行所有权。

## 验证

针对性测试：

- `packages/renderer-extension/test/renderer-rpc-steering.test.ts`：空闲或未加载 Thread 的普通发送不受影响、原生 preparation 的送达选择、await 后保留拦截、请求标记、已暂停消息保护、失败保留、接受后停止、连接更换与卸载。
- `packages/desktop-control/test/renderer-rpc-steering.test.ts`：Controller 与已提交 React Scope 的身份核对、歧义及其他 root 拒绝、句柄释放、失败退避。
- `packages/host-runtime/test/app-server-host.external-queue.test.ts`：带标记的原生 start 进入替换流程、快速完成不重复执行、删除确认及失败恢复。

- `tests/integration/external-image-steering.test.ts`：将 Renderer steer／停止后重发、远程补存器和真实 AppServerHost RPC 串联，覆盖纯图片送达、附件展示上下文、部分清单补存后的额外引用、清单中的命令及缺少路径时停止前拒绝。Desktop 展示与原生文件存储使用合成对象，Harness 使用 Fake Session，不代表实机验收。

- `packages/host-runtime/test/app-server-host.broker-steering.test.ts`：非 Claude 的合成 Adapter 经真实 Broker socket 与 Host RPC，验证打开后能力变化、同轮消息投影，以及不支持时停止后重发；不代表该 Harness 的原生 steer 已接入。

- `packages/host-runtime/test/app-server-host.native-steering.test.ts`：原生插入的 `clientId` 投影、送达方式查询、Fork/撤销窗口和重新读取后放行；Harness 没收下时改走停止后重发、`codexhostSteerDelivery` 两种取值都照办、Harness 命令停止后重发、撤销只限制包含 steered Turn 的范围。
- `packages/renderer-extension/test/renderer-external-steering.test.ts`（`steer delivery handshake`）：inspect 带文本、两种展示方式分别标记 `codexhostSteerDelivery`、Host 不支持 inspect 时改用 Thread 所有权。
- `packages/protocol-core/test/codex-ui-projector.test.ts`：插入的 `userMessage` 在实时与历史投影中留在所属 Turn。
- `packages/adapters/claude-code/test/*.test.ts`：Claude Code 的 `priority: "next"` 推入、接受条件、错过 Turn 与历史分轮。
- `packages/host-runtime/test/external-turn-steering.test.ts`：原生插入不取消、明确拒绝释放回执、结果不确定保留失败回执与禁止自动重试、没收下时退回（当前 Turn 已结束则直接启动下一个、正在结束则等待其终态），以及延迟/同步终态、去重、冲突、过期目标、输入预检、超时迟到、fault、关闭、显式停止、自主 Turn 及启动失败。
- `packages/host-runtime/test/app-server-host*.test.ts`：真实 Host 路由、外部不泄漏官方流、取消与启动顺序、响应 gate、同 Thread start 竞争、官方透传。
- `packages/renderer-extension/test/renderer-external-steering.test.ts`：正常 start 占位、唯一输入、无旧轮 steer Item、去重、队列暂停恢复、owner/follower、失败和卸载。
- `packages/renderer-extension/test/renderer-external-steering-rpc.test.ts`：类方法的 RPC 可访问性、模型／权限列表读取、官方与外部 steer、实例隔离、卸载和重复安装，以及卸载期间待定请求的清理。
- `packages/renderer-extension/test/versioned-renderer-adapter.test.ts`：现有版本化绑定与清理回归。
- `packages/host-runtime/test/app-server-host.manual-compaction.test.ts`：命令菜单与输入 `/compact` 两条路径在压缩 `item/started` 前恰好发送一次通知，普通 Turn 与非 `/compact` 命令 Turn 的自动压缩均不发送。
- `packages/renderer-extension/test/renderer-manual-compaction.test.ts`：经窗口 `mcp-notification` 消息的外部 Thread 登记，follower、未加载／官方 Thread、其他 Host、其他 frame 与非法消息跳过，缺少 Desktop 绑定、卸载，以及按 Host 连接（含 SSH）安装。

实现时还在 Node VM 中回放了上述 Desktop Bundle 的真实 `lun`（普通 start）、`GS`（占位写入）和 `Irn`（旧轮消息恢复）helper：legacy / canonical 历史各验证启动成功与启动失败，检查单条新输入、无旧轮 steer 恢复、失败输入保留。该回放仍模拟了准备器与传输，不是实际窗口或原生 Session 测试。

针对 RpcTarget 实例属性回归，还在运行中的上述版本 Desktop 内通过其真实 `RpcStub` 调用了 `model/list` 和 `permissionProfile/list`，验证原型挂接修复后两者成功返回，并重试了此前失败的只读查询。该检查没有发送新消息、修改权限选择或验证原生 Harness 执行。

以上合成测试和只读 RPC 检查不替代真实 Desktop 与各原生 Harness 验收。发布验收应覆盖流式文本、工具运行、Question/Approval、连续提交、已有队列、取消失败、刷新历史，以及多窗口和远端连接。不得把类型检查或合成测试通过称为所有 Harness 的实机兼容性证明。

### Pi / OMP Adapter 实机 Gate

`tools/gate-steer/adapter.real.test.mjs` 默认跳过。先运行 `npm run typecheck`，再用 `CODEXHOST_STEER_REAL_HARNESSES=pi,omp npx vitest run --config tests/vitest.config.js tools/gate-steer/adapter.real.test.mjs` 选择实际安装的 Harness；`CODEXHOST_STEER_REAL_MODEL` 可指定原生目录中的完整模型显示名。Gate 不修改模型配置，但会使用现有登录和模型额度，留下原生 Session。

Pi 的异步 input hook 跨越原执行终态时，恢复与队列隔离由 `packages/adapters/pi/test/pi-steer-delayed-input.real.test.ts` 验证；同样用 `CODEXHOST_STEER_REAL_HARNESSES=pi` 显式运行。该测试还恢复同一个 Native Session 并发送下一轮，确认晚到输入没有被重放；它清理自建 Session，不操作已有历史。

默认执行 `single`、`double`、`near-terminal` 三种场景，也可用 `CODEXHOST_STEER_REAL_SCENARIOS` 选择。测试只要求在临时目录执行前台 sleep 命令，并检查单次/连续插入、原工具完成、错误目标/空文本/终态后的拒绝及原生历史身份。工具结束附近的场景继续观察 30 秒：接纳的输入必须在目标 Host Turn 回复一次；明确拒绝的输入不能执行。原生 Session 和记录保留在 `.codexhost/native-steer-real/<harness>/`，临时工作目录清理。未安装、缺凭据或超时都不能算作通过，且该 Gate 不验证 Desktop GUI。

macOS / Desktop 26.1103.31037 的独立 GUI 验收通过真实 Composer 的「排队」「引导」与删除按钮执行。Pi 覆盖工具中正常插话、异步 hook 跨越终态、原轮成功、同一 Native Session 恢复、未确认队列不自动重放，以及删除后普通发送。OMP 在 `openai-codex / gpt-5.6-sol`、High 配置下验证实际 shell 工具完成、一个 Host Turn 内接纳与回复；其他 Model / Provider 组合不能由此推定通过。以上不覆盖多窗口、远端和其他 OS。
