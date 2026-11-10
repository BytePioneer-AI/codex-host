# Proposal

## Why

编排类工作常一次派出多个委派，同时运行的 Harness 过多会占满本机资源与 Provider 并发，目前只能由调用方或用户自己控制派发节奏。需要一个默认关闭的本机上限：超出时委派排队，有空位再按先后自动开始，而不是失败或要求调用方重试。

## What Changes

- Codex Desktop 设置页“通用”中新增“委派”分组：开关“限制同时运行的委派”（默认关闭）与“同时运行上限”（1～32，默认 4）。存储与下发沿用空闲释放：Renderer 本地偏好，只下发给本机 Host，Host 保存在内存。
- 开启后，本机正在运行的顶层 Thread（含用户手动打开的，不含子代理）达到上限时，`delegate start`（外部 Harness 与原生 Codex 相同）立即返回 Thread 标识、`status: "queued"` 与排队位置，有空位时按先后自动开始。`thread send` 与用户消息不受限制。
- `thread read`、`thread list` 显示排队状态与位置；`thread wait`、`thread watch` 等到 Thread 开始后真正停下；`thread cancel` 把它移出队列；`thread send` 对排队中的 Thread 返回 `THREAD_BUSY`。
- 队列持久保存在 Host 私有数据目录，Host Runtime 重启后按原顺序恢复。
- CLI 帮助、MCP `delegate_start` 说明与架构文档同步更新。

## Decisions

- **排队而非拒绝。** 拒绝要求每个调用方自己重试并维持顺序；排队保持 `delegate start`“立即返回、之后观察”的语义，调用方用同一套 read、wait、watch 跟进。
- **排队时即分配 Thread 标识。** 排队期间拿到的链接、watch 与后续命令在开始后继续有效。
- **只限制新委派。** 后续消息属于已有工作，拦截会让进行中的协作卡住，用户消息也不应因 Agent 的派发被拒绝。上限因此只是开始新委派的门槛，运行数可能因后续消息超过上限。
- **原生 Codex 委派先建 Thread，只排队第一条 Turn。** 主要的编排场景使用 `--harness codex`，不排队上限就不起作用。官方后端不接受调用方指定的 Thread 标识，由 Host 分配别名则深链接、父子关系与子进程环境都要换算；先用官方 `thread/start` 建好 Thread，排队时返回的就是真实标识。没有 Turn 的 Thread 会持久保存，重启后可恢复并开始 Turn，但官方 `thread/list` 不列出它。用户直接向它发消息时，排队的任务并入这条消息，只执行一次。
- **设置与队列分开保存。** 设置是用户偏好，沿用空闲释放由 Renderer 在连接后下发；队列是待执行的工作，必须跨重启保存。重启后设置到达前，恢复的委派保持排队，最多等待 5 分钟，避免在上限未知时一次全部开始。
- **重启时正在开始的外部 Harness 委派不自动重试。** 无法确认 Thread 是否已经创建，重试可能重复创建；按 `interrupted` 结束并说明原因。原生 Codex 的 Thread 已经存在，恢复为“可能已开始”，之后的开始、取消、用户消息与读取都先检查是否已有 Turn。
- **排队的原生 Thread 从不删除。** 官方后端对有进行中 Turn 的 Thread 也会执行 `thread/delete` 并删掉 rollout，而重启或用户消息都可能让 Turn 在 Host 不知情时开始。取消只移出队列，空 Thread 留在后端（官方 `thread/list` 不列出它）。后端有 `thread/archive`，但确认没有 Turn 之后用户消息仍可能到达，本次不归档。
- **用户消息分两步认领排队的任务。** 后端答复前任务留在原位，答复开始了 Turn 才移出队列；拒绝时任务不丢。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `cross-harness-delegation`：`delegate start` 在本机委派上限已满时排队后立即返回（为使该需求描述不超过 500 字符，描述不再逐一列出观察命令，由已有场景覆盖）；新增“本机同时运行的委派可选上限”和“排队中的 Thread 可观察、可等待、可取消”两条需求。

## Impact

`packages/shared-contracts` 新增设置契约；`packages/host-runtime` 的委派 Registry、协调器、CLI 输出与帮助、MCP 说明，以及 `<数据目录>/delegation-queue/` 下的私有队列文件；`packages/renderer-extension` 的设置页、偏好同步与本机 Host 请求。新增 `docs/architecture/delegation-capacity.md`，`thread-watch.md`、`delegation-thread-list.md`、`external-clients.md` 补充排队行为。
