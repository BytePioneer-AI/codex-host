# Claude Code 同轮插入

Claude Code 的运行中插入走 Agent SDK 流式输入：向当前 Query 的输入流推入 `SDKUserMessage`，`priority: "next"`，`origin: { kind: "human" }`。这不会取消当前 Turn，也不会另开一轮。`now` 会把正在运行的 shell 命令、子 Agent 和 MCP 调用转入后台后立即送达，`later` 会等到空闲，Adapter 都不用。

实时执行时，Host 在原生接受后自己发当前 Turn 的 `userMessage` Item，Adapter 不重复发布。冷历史读取时，Adapter 从原生已送达的输入记录恢复对应的历史 Item。

## 何时同轮插入

`priority: "next"` 在**当前工具调用结束后**、下一次模型请求之前并入；工具结果之后一定还有一次模型请求，所以插入写入时只要有根级工具调用正在执行，它就一定并入当前 Turn。反过来，如果 Claude 正在输出最终文本、没有工具在执行，它可能直接结束本轮，把插入留到下一轮执行：2026-10-22 在 Claude Code 2.1.305 上实测，Host 把插入显示在原来那一轮，而 Claude 在随后的另一轮里回复；现在这类已写入、尚未被接管的插入由下述保活保证兜住，Turn 保持 held，插入作为该 Turn 的下一段运行，不再落入另一轮。

因此 `capabilities.steer` 实时取以下条件的交集，任何一项不满足都为 `false`，Host 改用停止后重发：

- CLI 在 `system/init` 的 `capabilities` 中报告 `msg_lifecycle_v1`，会发出确认插入所需的 `command_lifecycle` 回执；
- 当前是用户发起的 Turn，不是后台通知等触发的自主 Turn（transport 没有对应的活跃 Turn），且它的取消尚未开始；
- 处于以下两种窗口之一：
  - 有根级工具调用已经开始、还没返回结果（子 Agent 内部的工具调用不计入），插入在当前工具调用结束后并入本轮；
  - held Turn 的续态：主回复已结束、后台 Subagent 仍在运行、idle 流存活，插入作为该 Turn 的下一段运行，后台任务不被停止。

`turn.steer` 在写入输入流前同步复查上述条件，不依赖 Renderer 之前的查询结果；两个窗口都已关闭、或取消已在进行时拒绝且不写入。Renderer 已按同轮展示时，Host 报错而不停止后重发。Harness Broker 经公共 `readCapabilities()` 按需读取当前能力；旧 Broker 未声明支持查询时保持停止后重发。

已写入的插入还有一个额外保证：尚未被 Claude Code 原生接管（CLI 对这条消息的 uuid 发出 `command_lifecycle` `started`，并入当前段或作为下一原生 turn 运行都会发出）之前，它会让该 Turn 保持 held，不会被 continuation 静默计时器或当前段的结束提前收口，两个窗口里同样成立。因此即使插入写入时 Claude 正在输出续态的最终文本（没有根级工具执行，插入要等这段输出结束后作为下一个原生 turn 运行），这个原生 turn 也作为该 Turn 的下一段运行，回复留在同一 Turn，不会落入另一个自主 Turn。保活是有界的：这条消息以 `completed`、`cancelled`、`discarded`、`refused` 等终态结束却没发出 `started`、`queued` 回执 5 秒内未到，或会话关闭、故障时，保活即解除，Turn 按没写过这条插入的状态重新收口；收到 `queued` 后则依赖 CLI 对每条命令恰好报告一次终态，不再另设上限，用户仍可停止该 Turn，停止后的处理见下文“接受”一节。

## 接受

CLI 先发 `command_lifecycle` `queued`，表示 Claude 已接受这条输入；根级工具执行中插入时，工具调用结束后发 `started`，插入进入正在运行的 Turn；续态窗口插入时，`started` 在当前续态输出结束、插入作为下一原生 turn 运行之时发出。Adapter 在 `queued` 时返回 `{ accepted: true }`：此后由 Claude 负责送达，不等 `started`，否则调用方要被整段工具调用挂住（Desktop 提交约 30 秒超时）。输入一旦写入就无法撤回，所以本轮的 `result` 先于 `queued` 到达时不拒绝，仍按接受处理：此时 Turn 不结束，保持 held，插入作为该 Turn 的下一段运行，不再落入另一轮，期间 `turn.start` 返回 `sessionBusy`；`queued` 回执迟迟不到时，等待 5 秒后同样按接受处理，避免串行处理请求的调用方（如 Harness Broker）被无限期占住。只有目标不是当前 Turn、CLI 不支持、当前是自主 Turn、取消已在进行、两个可插入窗口（根级工具执行中与 held Turn 续态）都不成立，或输入写入失败时，才返回失败。写入后会话关闭或出错时抛出回执丢失异常，不返回表示未收下的拒绝结果，Host 不自动重发；Session 故障仍经原有故障路径报告。空文本返回 `invalidRequest`。忙时 `turn.start` 仍是 `sessionBusy`。

用户停止 Turn 时，只要还有已写入、尚未被原生接管的插入，无论 Turn 是否 held，Adapter 都走停止后台工作并等待安静的取消流程。SDK 中断不保证丢弃排队输入，因此当前 Root 的 `result` 不会提前结束这个 Turn：插入随后发出 `started` 时，它运行所在的原生段也会被中断；以终态结束却未被接管时，取消进入安静期；迟迟没有结果时沿用既有的取消升级，超时后关闭原生进程。取消期间 `turn.start` 返回 `sessionBusy`，且不再接受新的插入；所有待接管插入已结算、后台任务已确认停止、Root 段已结束，并经过 continuation 安静期（默认 2 秒）后，Turn 才结束为 cancelled。没有待接管插入、也没有后台或续态工作的普通停止路径不变。

插入的 `command_lifecycle started` 可以是 Root result 后的首个 idle 帧。Transport 在发出中断前确保该段的 accumulator 已创建并记录取消，使后续 `aborted_tools` / `aborted_streaming` 原生终态按取消处理；其他失败或无法证明中断的终态仍按失败处理。

## 版本

2026-09-24 在 Claude Code 2.1.280 上实机确认；2026-10-21 在 Claude Code 2.1.305（Agent SDK 0.3.273 与 0.3.305）上复核了相同的 `queued` → `started` → `completed` 顺序和单个 `result`，这两个版本都会报告 `msg_lifecycle_v1`。2026-10-26 在 Claude Code 2.1.303 上实机确认了 held Turn 续态的同轮插入：主回复结束、后台 Subagent 运行中写入，插入作为该 Turn 下一段得到回复，后台 Subagent 不受影响并最终正常完成。其他版本只依据这项运行时能力判断，没有逐个实机验证。

## 历史

Claude Code 2.1.319 的原生测试记录把同轮插入记成主 Session transcript 中的 `attachment.queued_command`，而非普通 `user` 消息。历史读取保留附件，然后仅将明确属于根级人类输入的记录映射为当前 Turn 内的 `userMessage` Item：要求 `commandMode: "prompt"`、`origin.kind: "human"`、有效的 attachment UUID、`source_uuid` 和文本 prompt；排除明确的非人类来源、`humanTurn: false`、meta / synthetic、sidechain、子工具和其他 Session 记录。文件等其他附件、任务通知、不明来源的 queued_command 均不提升为用户输入。确认属于人类输入但身份或文本无效时，映射报错，不猜测内容。

原生 attachment 的 `renderedRole` 可以是 `system`，`rendered` 包含提醒包装；显示的是 `attachment.prompt`，不显示包装，也不根据文本是否含 `<task-notification>` 猜测其来源。原生追加位置表示送达位置，时间戳可能是更早的排队时间，因此不按时间排序。工具 Item 仍位于其调用位置，用户插入位于原生送达位置；不将工具完成时间当作新的用户输入边界。

身份分别处理：外层 attachment UUID 是持久记录身份和冷历史 Item ID；`source_uuid` 是 SDK 输入 UUID，不是 Web 的 requestId / clientId。重复外层 UUID 沿用原生读取规则：最后一份记录的内容和元数据、第一次出现的位置。同一 `source_uuid` 的重复送达只恢复一次，内容冲突则报错；不同输入 UUID 即使文本完全相同也各自保留。若相同输入另有真实普通 user 记录，则以该 user 的原生 Turn 边界为准，不再恢复重复的附件 Item；原生 Fork 的 `forkedFrom.messageUuid` 同样用于识别该身份。

附件不创建新的 Turn，不作为 checkpoint，也不消耗 assistant / tool 的身份序号。根级 user UUID 继续作为 `nativeTurnRef.nativeTurnKey`；checkpoint 仍只能来自根级 assistant 或原生中断记录，且必须位于最后一条已送达插入之后。只有附件、没有原生 Turn 锚点时拒绝映射。Fork / rollback 沿用完整历史前缀校验，包含恢复出的输入；原生派生丢失这些输入时拒绝并清理派生 Session，不改源 Session。一轮中的多条插入不增加 rollback 的轮数。

公共历史契约能够表达同轮 `userMessage`，无须扩展 Host 契约；它不携带每条输入的发送时间或本地 Web requestId，不能从原生历史重建实时 `source.rpcId`，也不保证冷历史 Item ID 与 Host 实时分配的 Item ID 相同。未送达、没有持久记录的排队输入无法由该路径恢复。其他 CLI 版本若缺少明确人类来源信息，保守忽略，而非把所有附件当作输入。原生 transcript 缺少完整 Result 终态时仍报告 unknown，不根据工具成功或最终文本猜测 Turn 成功。

## 验证

冷历史聚焦回归见 `claude-queued-history.test.ts`、`claude-queued-fork.test.ts` 和 `claude-code-adapter.test.ts` 的只读 resume 用例：覆盖两次连续插入、相同文本不同身份、重复记录与元数据、任务通知及普通附件排除、真实普通 user 的新轮边界、checkpoint、knownTurnRefs、Fork 前缀丢失拒绝和整轮 rollback。这些使用精简合成 transcript / SDK 依赖，不代表真实原生 Fork 已验收。

2026-11-09 用当前源码默认 Adapter 的 `open(resume)` / `readSnapshot()` 只读回放此前三份真实 CLI 2.1.319 测试 Session，模型均为 `claude-haiku-4-5-20251001`：分别恢复 3、2、2 条 queued_command 输入，原有 10、2、2 个 Turn、checkpoint 及非用户 Item 全部不变，重复读取稳定，源 JSONL 的 SHA-256 不变。没有启动模型任务、真实 Fork 或替换运行中的插件；运行服务中的冷历史 UI 验收需要部署新版 Adapter 后另行执行。

自动化回归：`packages/adapters/claude-code/test/claude-code-adapter.test.ts` 的 `preserves cancellation when a native steer starts before its idle accumulator exists` 使用真实 `ClaudeSdkTransport` 与 `FakeQuery`，按 Root 中断结果 → 插入 `started`（首个 idle 帧）→ 插入中断结果的顺序送入 SDK 消息，断言最终为 cancelled、等待期间拒绝新 Turn、结束后可启动新 Turn，且没有自主 Turn。这是合成 SDK 流测试，不代表真实 CLI 或 Desktop 实机验收。

实机：模型 `haiku`，权限 `bypassPermissions`，一轮里调用 Bash 执行 `sleep 4; echo tool-done`，工具开始后以 `priority: "next"` 插入一句。流里只有一次 `result`（`subtype: "success"`，`terminal_reason: "completed"`）。`started` 出现在工具结果之后、下一次模型请求之前，模型回复提到了插入的句子。因此实时结果处理不改：纯文本 user 回显本来就被忽略，第一个 `result` 仍是本轮结束。

2026-10-21 复核：Linux aarch64，Claude Code 2.1.305，Adapter 自身的 `ClaudeSdkTransport` 驱动真实 CLI。一轮要求依次执行三次 `sleep 6`，第一个工具开始约 1.5 秒后调用 `steer()`。`steer()` 在 `queued` 时立即 resolve；本轮只执行了一次 `sleep`，`runTurn` 以 `succeeded` 结束，transcript 中模型回复的是插入要求的文本。
