# 委派并发上限：超出时排队

Host 可以限制本机同时运行的顶层 Thread 数量。开启后，`delegate start` 遇到上限时不立即创建 Thread，而是排队：命令照常立即返回 Thread 标识，状态为 `queued`，并给出排队位置；有空位时按先后自动开始。默认关闭，关闭时 `delegate start` 的行为与以前相同。

## 设置

- 位置：Codex Desktop 设置 → codexhost“通用”页，“资源管理”分组下方的“委派”分组。开关“限制同时运行的委派”默认关闭；开启后才显示“同时运行上限”，取值为 1～32 的整数，默认 4。
- 存储与下发沿用空闲释放：Renderer 写入 localStorage（`codexhost.delegation-capacity.v1`），连接本机 Host 后以及每次修改时，通过 `codexhost/settings/delegation-capacity/set` 下发。请求只发给本机 Host，不随当前远程会话切换。Host 只把设置保存在内存中，不写配置文件。设置的校验规则由 `shared-contracts` 提供，Renderer 与 Host 共用。
- 旧 Host 不认识该请求，或 Host 没有挂接委派控制时，返回“方法不支持”，设置页显示“当前 Host 不支持”，不会当作已生效。

## 计数

占用名额的是本 Host Runtime 中正在运行（有活跃 Turn）的顶层 Thread：

- 用户手动打开的顶层 Thread、以及外部客户端（`client:*`）通过委派创建的顶层 Thread 都算，外部 Harness 与原生 Codex 都算；
- 全部三类子会话均不计入顶层运行数：
  1. 原生与外部 Harness 的 Subagent（外部 `record.subagent`，原生 `thread/started` 中的子代理来源或 `spawnAgent` 的接收方）；
  2. Fork 派生的子会话（外部 `record.forkSource`，原生 `forkedFromId` / `history_base.thread_id`）；
  3. 由已有会话通过 `delegate start` 派生的子会话（存在 `DelegationRecord` 且 `parentHostThreadId` 不是 `client:*`）；
- 已放行、正在创建、尚未报告为运行的顶层启动先占一个名额，避免多个并发启动一起越过上限。

原生 Codex Thread 依据 Host 观察到的 Turn 开始与结束事件计数。Host Runtime 重启前已经在运行的原生 Turn，要等到新的事件才会重新计入；Host 没有观察到子代理或 Fork 身份的原生 Thread，按顶层 Thread 计入。

## 哪些请求会排队

- 只有外部客户端（`client:*`）发起的顶层 `delegate start` 会受顶层并发上限约束并排队（外部 Harness 与 `--harness codex` 都一样，CLI、MCP `delegate_start` 以及带 `--watch true` 的启动也都一样）；由已有会话派生的子会话属于该父会话的内部子任务，直接放行，不进入顶层队列。
- `thread send`、用户在 Desktop 中发送的消息，以及对已有 Thread 的后续消息，从不排队，也不会因上限失败，即使运行数已经超过上限。
- 参数、父 Thread、工作区与 Model 配置的校验，以及幂等去重，都在排队前完成：无效请求直接报错，不进入队列。相同 Request ID，或 30 秒内同一父 Thread、目标与任务的重复请求，返回同一个排队中的 Thread；Request ID 相同而配置不同时返回 `INVALID_ARGUMENT`。
- 已经有启动在排队时，新的启动排在后面，即使此刻有空位；空位总是先给队首。

## 排队中的 Thread

排队时 Thread 的标识就已分配，开始运行后沿用同一个标识。排队期间拿到的链接、注册的 watch 与后续命令，在开始后继续有效。

| 命令 | 行为 |
| --- | --- |
| `delegate start` | 立即返回 Thread 链接、`status: "queued"` 与 `queue.position`（compact 输出为 `queuePosition`），以及工作区、标题和父 Thread |
| `thread read` | 返回 `status: "queued"` 与 `queue.position`，没有 Turn；开始创建后为 `creating`，之后与普通 Thread 相同 |
| `thread wait` | 排队时间计入超时；到期时 Thread 仍在排队，则返回排队快照与 `timedOut: true` |
| `thread watch` | 照常注册。排队与创建期间既不算停下，也不算卡住提醒的静默；Thread 开始后真正停下才通知。被移出队列时通知 `interrupted` |
| `thread list` | 排队中的 Thread 按队列顺序排在第一页最前面，不占 `--limit`，续页不再出现；同样按 `--parent` 或工作区过滤 |
| `thread cancel` | 把 Thread 移出队列并返回 `cancelled: true`。之后读取为 `interrupted`，并说明它在开始前已被移出队列，不会再启动；原生 Thread 已有 Turn 时按已开始的委派取消 |
| `thread send` | 返回 `THREAD_BUSY`，`details.status` 为 `queued` 或 `creating`，排队时附 `queuePosition`；移出队列或启动失败后返回 `THREAD_NOT_FOUND` |

移出队列、启动失败或被重启中断的外部 Harness 启动不会生成 Thread；原生 Codex 的排队 Thread 见下文。远程 Host 上排队中的 Thread 同样可以用 `thread read --host` 读取。Host 在内存中保留最近 50 条这类记录，使 `read`、`wait`、`cancel` 与 watch 能给出终态；Host Runtime 重启后不再保留。

## 自动开始

队列每 2 秒检查一次正在运行的 Thread（与 `thread wait`、watch 一样基于轮询），有空位就按先后启动队首，直到名额用完。上限调高或关闭后，等待中的启动随之开始。启动沿用排队时记录的参数（任务、任务名、工作区、父 Thread、Model 与 Thinking 选择）和已分配的 Thread 标识。启动失败时，该 Thread 读取为 `failed` 并附失败原因，同时写入 Host Runtime 日志。

## 原生 Codex 的排队

官方后端不接受调用方指定的 Thread 标识，所以 `--harness codex` 需要排队时，Host 先用官方 `thread/start` 与 `thread/name/set` 建好 Thread，只把第一条 Turn 排队。返回的标识就是真实的原生 Thread，深链接、父子关系和子进程环境不需要别名。没有排队、直接放行的启动仍按原流程创建。

- 没有 Turn 的原生 Thread 会写入 rollout，官方后端重启后仍能 `thread/resume` 并开始 Turn。官方 `thread/list` 不列出没有 Turn 的 Thread，因此 Desktop 重启后，排队中的原生 Thread 可能不在线程列表中出现，直到第一条 Turn 开始；`codexhost thread list` 仍由队列给出。空闲释放只作用于外部 Harness，不会卸载它。
- 开始时，Host 先 `thread/resume`，再读取最新 Turn；已经有 Turn 时沿用它补建委派记录，不再发送任务。
- 用户在 Desktop 中直接给排队中的原生 Thread 发消息时，Host 把排队的任务放在这条消息之前一起发出。在后端答复之前，这一项留在原位、标为正在认领：队列不会同时开始它，取消要等认领结束。后端开始了 Turn，才移出队列并建立委派记录；后端拒绝时取消标记，仍在原位排队。任务只执行一次，这条 Turn 不受上限限制，Model 与 Thinking 以 Desktop 的请求为准。
- 排队相关的代码从不删除 Thread：后端对有进行中 Turn 的 Thread 也会执行 `thread/delete` 并删掉 rollout。`thread cancel` 先读取 Thread 的 Turn：没有 Turn 时移出队列，之后读取为 `interrupted`，空 Thread 留在后端（官方 `thread/list` 不列出它）；已有 Turn 时按已开始的委派补建记录并中断这条 Turn。取消与用户消息交错时，最坏结果是用户的消息照常进入这个 Thread、委派记为取消，内容不丢。
- 重启前正在开始或正在认领的原生记录，恢复后标为“可能已开始”。之后无论是自动开始、取消、用户发消息还是 `thread read`，都先 `thread/resume` 并读取 Turn：已有 Turn 时按已开始的委派收编，补建委派记录，watch 随之观察这个 Thread，不再发送任务，也不再把任务拼进用户消息；没有 Turn 才按排队处理。Host Runtime 关闭时仍把启动结果写盘；强杀时写不了，靠这项检查保障。

## 重启

- 队列保存在 `<数据目录>/delegation-queue/`（默认 `~/.codexhost`），每个 Runtime 进程一个仅当前用户可读写的文件。与 watch 记录不同，排队记录必须包含任务文本，因为 Thread 在开始前并不存在；启动后记录随即删除。
- 多个 Runtime 进程可以共用数据目录。每个进程只写自己的文件；启动时接管已退出进程（或上次开机遗留）的队列，每个文件的接管通过跨进程文件锁串行处理，并以原子重命名认领，同一记录只被一个进程接管，接管后按原排队时间合并。无法解析的记录改名为 `.invalid` 留存并写诊断，不阻止 Runtime 启动。
- 上限设置只在内存中，重启后要等 Renderer 重新下发。在此之前，恢复的启动保持排队，新的启动排在它们后面；最多等待 5 分钟，仍未收到设置就按关闭处理，依次启动。
- 重启时正在启动的外部 Harness 记录无法确认 Thread 是否已经创建，按 `interrupted` 结束并说明原因，不自动重试；如果 Thread 实际已经创建，读取时以持有它的会话为准。

## 实现与边界

- `packages/host-runtime/src/delegation-capacity-queue.ts` 实现计数、排队、恢复与自动开始，由 `DelegationControlRegistry` 持有，位于各 Host 会话之上；`delegation-capacity-store.ts` 负责队列文件。各会话通过注册提供正在运行的顶层 Thread，并把收到的设置转交给队列。
- 外部 Harness 的名额检查位于创建 Thread 之前；原生 Codex 的在 `AppServerHost` 中，需要排队时才通过 `prepare` 建好 Thread，去重先于建 Thread，重试不会留下多余的 Thread。排队的启动开始时，以已分配的标识重新进入同一启动流程，跳过名额检查与去重。
- 只有收到设置的 Host Runtime 计数并限制。同一台机器上的其他 Runtime（例如远程监听）既不计入，也不受限制；它们只会接管已退出 Runtime 留下的队列文件。
