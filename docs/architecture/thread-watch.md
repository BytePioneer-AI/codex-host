# Thread watch：停下通知与可选卡住提醒

`codexhost thread watch` 让一个 Thread 在另一个 Thread **停下（不再运行）时收到一次通知**。调用方注册后立即返回，可以继续工作或结束自己的 Turn，不需要等待或轮询。

它是显式选择的能力：不调用时，Host 不会因为子任务终态而主动向任何 Thread 提交输入。同一变更中的忙碌判断修正（见“实现与边界”）不依赖 watch，也作用于普通的 `thread read`、`wait`、`send`。

## 模型

- 只有两个 Thread：被观察的 Thread 和被通知的 Thread。与委派的父子关系无关，任意两个不同的 Thread 都可以。
- 停下通知一次性。被观察 Thread 停下，或 watch 到期，哪个先到就通知一次，随后 watch 消失。可选卡住提醒不结束观察。换了一个仍在运行的 Turn 不会通知。没有取消或退订；想继续等就再注册一次。
- 每次注册各自兑现。同一对 Thread 仍在观察中时重复注册，返回已有的 watch，并保留原有期限和卡住阈值；该 watch 已停下、通知仍在待送达时再次注册（例如 Thread 又开始了新一轮），会新建一个 watch 观察下一次停下，旧通知照常送达，不会被替换或丢弃。
- 通知只报告执行状态：Thread 链接和结果；终态结果注明来自哪个 Turn，以便区分同一 Thread 不同轮次的通知。通知不包含会话正文或摘要，也不代表工作被验收。接收方应自行 `thread read`。

入口：

| 命令 | 用途 |
| --- | --- |
| `thread watch <thread> [--notify <thread>] [--timeout-ms <n>] [--stall-after-ms <n>]` | 观察一个已有 Thread |
| `delegate start ... --watch true [--stall-after-ms <n>]` | 创建委派后顺手观察，通知 Host 解析出的发起方 |
| `thread watches` | 列出尚未送达的 watch |

watch 首次持久化失败时不保留内存注册，`thread watch` 返回错误，调用方可稍后重试。`delegate start` 先完成委派；watch 注册失败不会让命令失败，而是在返回的 `watch` 字段里报告 `notRegistered` 和原因。`thread send` 不提供 `--watch`，发送后需要通知时单独执行 `thread watch`。

## 结果

| 结果 | 含义 |
| --- | --- |
| `completed` / `failed` / `interrupted` | Thread 停下时的终态 |
| `timedOut` | 到期时 Thread 仍未停下；也覆盖 Harness 停止但没有报告的情况 |
| `unreadable` | 连续 60 秒读取失败，状态未知 |
| `notFound` | Thread 已不存在 |
| `stalled` | Thread 仍在运行，但在配置时长内没有观察到 Harness 事件；只是静默提醒，不代表失败 |

默认观察 29 分钟，`--timeout-ms` 可调整；到期报告 `timedOut`，需要继续等待时再注册一次。

卡住提醒默认关闭。传入正整数 `--stall-after-ms` 后，从注册时刻开始记录静默时间；`delegate start` 只有同时提供 `--watch true` 才接受该参数。Host 收到的任何 Harness 事件都刷新活动时间，包括消息、工具调用和输出、推理、文件变化、交互，以及 Harness 子代理事件；子代理活动也刷新其祖先 Thread。轮询读取和 Host 自己的投影通知不算活动。

运行中的 Thread 静默达到阈值时，以 `stalled` 提醒一次并继续观察；持续静默不会重复提醒。提醒写明 Thread 仍在运行、至少多长时间没有观察到 Harness 事件，时长照阈值原值表述（例如 90 秒写作 `90 s`），不取整；与其他通知一样不附带进度或会话内容，接收方用 `thread read` 查看。新的 Harness 活动重新计时，之后再次静默才会再次提醒。提醒是触发时刻的事实，即使被通知 Thread 正忙、期间活动恢复，也保留该待投递提醒；它会与同一接收方的其他提醒或停下通知合并。观察期限仍独立生效，到期后结束观察。

注册时 Thread 已是终态则返回 `alreadyTerminal`：不注册、不通知，调用方直接读取即可。

被观察 Thread 还在[委派队列](delegation-capacity.md)中时照常注册：排队与创建都不算停下，也不计入卡住提醒的静默；Thread 开始后真正停下才通知，开始前被移出队列则通知 `interrupted`。排队时间计入观察期限。

## 送达

- 通知通过普通的 `send` 在被通知 Thread 中启动一个新 Turn，外部 Harness 与原生 Codex 使用同一路径；不做同轮注入。
- 被通知 Thread 正忙时通知保持待送达并重试，最长 6 小时。`THREAD_BUSY` 从不被当作已送达；`thread send` 自身“不排队”的语义不变。
- 投递失败只有在调用链能证明没有启动 Turn 时才重试：
  - `THREAD_BUSY`（启动前判定），或错误带 `notStarted`（例如原生 Codex 的 resume 校验失败，或 `turn/start` 明确返回错误）：保持待送达并重试；
  - 被通知 Thread 不存在或只读：立即标记 `undeliverable`；
  - 其他失败都视为结果未知，包括 Harness 启动确认超时后包装成的 `DELEGATION_FAILED`：原生可能已经启动了 Turn，为避免重复唤醒不再重试，标记 `undeliverable` 并在原因中说明。
- 每次投递将同一个被通知 Thread 当前所有待送达通知合并为一条消息，包括此前轮询积累的通知，只启动一个 Turn。
- 接收方为外部客户端时，同批通知写入该客户端的事件日志，不启动 Turn。卡住事件使用 `outcome: "stalled"`，`note` 与发给 Thread 的提醒文字相同，说明 Thread 仍在运行、至少多长时间没有观察到事件以及观察会继续；事件通过同一游标、SSE 和轮询接口读取。
- 被通知 Thread 不存在、只读，或超过 6 小时仍无法送达时，watch 标记为 `undeliverable` 并保留原因，可由 `thread watches` 查看；最多保留最近 50 条无法送达记录。

## 与 Stop 的关系

- 用户 Stop 被观察的 Thread，Thread 停下，watch 以 `interrupted` 通知一次。“调整方向”的停止后重发不算停下，不会通知。
- 用户 Stop 被通知 Thread 的当前 Turn，不会取消已注册的 watch：该 Thread 空闲后，到期的通知仍会启动一个新 Turn。watch 不能取消，这是注册 watch 时就选择的行为。
- 与 `thread send` 的“不排队”约定和 [调整方向](external-thread-steering.md) 的“失败不自动重试或偷偷排队”并不冲突：待送达的通知只存在于显式注册的 watch 中，普通消息的语义不变。

## 被通知 Thread 的确定

身份只确定一次，watch 不做自己的推断：

1. `delegate start --watch`：使用委派已经解析出的父 Thread；没有父 Thread 时报告 `notRegistered`。
2. `thread watch`：显式 `--notify`，否则使用 Host 提供给外部 Harness 的 `CODEXHOST_THREAD_ID`，再取原生 Codex 的 `CODEX_THREAD_ID`。
3. 经外部客户端监听调用且没有调用方 Thread 标识时，未给 `--notify` 即通知调用客户端自身（`client:<name>`）。此时“投递”是向该客户端的事件日志追加一条事件，不启动 Turn；追加失败在投递期限内重试。见 [外部客户端](external-clients.md)。MCP 的 `thread_watch` 和 `delegate_start`（`watch: true`）以 `stallAfterMs` 提供相同的可选阈值。
4. 均没有时返回 `INVALID_ARGUMENT`，要求显式 `--notify`。

## 实现与边界

- `packages/host-runtime/src/delegation-watch.ts` 通过公开的 `read` 与 `send` 观察状态和投递，活动从 Host 已有事件流订阅，每轮完成后间隔 2 秒继续轮询（现有 `thread wait` 同样基于轮询）。它不依赖具体 Harness、Desktop、Renderer 或委派血缘。
- 活动时间只放在 Host 内存中，不增加定时器、后台进程或 rollout 扫描。原生 Codex 使用已有 app-server 通知和请求中的 Thread 标识、`thread/started` 的子代理来源与 `spawnAgent` 接收方建立祖先关系；外部 Harness 在输出消费入口记录全部事件与交互，并使用已知子代理身份传播活动。原生祖先关系只在 Thread 启动时获知，因此原生 Thread 收到 `thread/closed` 后，只要还有未关闭的后代，通往祖先的整条链就保留，整棵子树都关闭后才清除；外部 Harness 的关系随每个事件重新记录，会话输出结束（包括空闲释放）即清除；官方 app-server 停止时全部清除，不随 Host 运行时间增长。未接入当前 Host 事件流的 Thread、没有上报活动的 Adapter，或未公布身份关系的子代理无法提供完整活动证据；静默提醒只表示“Host 没有观察到事件”，长工具执行也可能触发。
- 服务由 `DelegationControlRegistry` 持有，位于各 Host 会话之上，因此两端可以属于不同的 Host 会话。
- watch 持久保存在 `<数据目录>/delegation-watches/`（默认 `~/.codexhost`），每个 watch 一个仅当前用户可读写的记录，只含 Thread 标识、状态、期限与原因。Runtime 重启后恢复观察与投递，调用方无需重新注册；观察与投递期限按绝对时间计算，停机时间计入。卡住阈值随 watch 保存；卡住提醒、活动时间与“本段静默已提醒”状态只在内存中，恢复观察后从 Runtime 恢复时刻重新计时，停机时长不计入静默，重启前未送达的卡住提醒不再投递，静默持续时恢复后会再次提醒。卡住提醒是独立于主 watch 的待投递项，送达或投递失败不会结束主 watch。
- 多个 Runtime 进程可共用数据目录（例如 Desktop 与远程监听同时运行）。每个进程只写自己的记录；启动时接管已退出进程（或上次开机遗留）的记录，每个记录的接管通过跨进程文件锁串行处理，并以原子重命名认领，同一记录只被一个进程接管。
- 恢复后的 watch 最多等待 5 分钟让持有 Thread 的会话重新注册：这期间读取失败不计入 60 秒 `unreadable` 宽限，也不报告 `notFound` 或 `timedOut`；待投递通知要等被通知 Thread 可读后再发送。
- Host Runtime 重启会结束它持有的 Harness 进程，正在运行的 Turn 随之中断。之后读取时它可能显示为已完成（有的 Harness 恢复后还会换一个 Turn 标识），也可能根本无法重新打开。因此，重启前处于观察中的 watch，恢复后第一次成功读取若已是终态，或宽限结束后仍报告 Thread 不存在，都按 `interrupted` 通知并说明原因；原因随记录保存，再次重启也不丢失。代价是：由长期运行的远程监听持有、在停机期间真正完成的 Thread 也会被报告为 `interrupted`；被通知方本来就要先读取 Thread 再行动。
- 发送前先把通知记为“投递中”。Runtime 在发送途中退出时，恢复后再投一次，因此重启可能重复通知，但不会丢失。运行期间“投递结果未知”仍标记为 `undeliverable`，不重试。
- 原生 Codex 的 `thread/read` 只有返回“Thread 不存在”类错误时才报告 `notFound`；其他读取错误按读取失败处理，持续 60 秒才报告 `unreadable`。
- 忙碌判断统一为 `running || 存在待处理的调整方向`。它同时作用于普通 `thread read`/`wait`/`send` 和委派状态，避免停止后重发的空档被读成 `interrupted`。
- 异常退出依赖 Adapter 契约：进程或协议故障时 Adapter 先以失败终结活跃 Turn。`thread read` 在 Harness 已死、无法刷新原生历史时，返回 Host 已投影的终态 Turn，因此这类失败会以 `failed` 被及时通知，而不是等到超时。
