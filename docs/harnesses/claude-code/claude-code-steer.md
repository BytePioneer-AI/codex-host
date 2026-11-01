# Claude Code 同轮插入

Claude Code 的运行中插入走 Agent SDK 流式输入：向当前 Query 的输入流推入 `SDKUserMessage`，`priority: "next"`，`origin: { kind: "human" }`。这不会取消当前 Turn，也不会另开一轮。`now` 会把正在运行的 shell 命令、子 Agent 和 MCP 调用转入后台后立即送达，`later` 会等到空闲，Adapter 都不用。

Host 在原生接受后自己发当前 Turn 的 `userMessage` Item。Adapter 不发这条 Item，也不改历史解析。

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

原生把插入记成同一条 transcript 里的 `queued_command` attachment（`commandMode: "prompt"`，`source_uuid` 是插入消息 id），不是新的 user 消息。现有历史解析忽略 attachment，所以刷新后仍是原来那一轮，插入文本不会变成单独的 Turn 或 Item。

## 验证

自动化回归：`packages/adapters/claude-code/test/claude-code-adapter.test.ts` 的 `preserves cancellation when a native steer starts before its idle accumulator exists` 使用真实 `ClaudeSdkTransport` 与 `FakeQuery`，按 Root 中断结果 → 插入 `started`（首个 idle 帧）→ 插入中断结果的顺序送入 SDK 消息，断言最终为 cancelled、等待期间拒绝新 Turn、结束后可启动新 Turn，且没有自主 Turn。这是合成 SDK 流测试，不代表真实 CLI 或 Desktop 实机验收。

实机：模型 `haiku`，权限 `bypassPermissions`，一轮里调用 Bash 执行 `sleep 4; echo tool-done`，工具开始后以 `priority: "next"` 插入一句。流里只有一次 `result`（`subtype: "success"`，`terminal_reason: "completed"`）。`started` 出现在工具结果之后、下一次模型请求之前，模型回复提到了插入的句子。因此实时结果处理不改：纯文本 user 回显本来就被忽略，第一个 `result` 仍是本轮结束。

2026-10-21 复核：Linux aarch64，Claude Code 2.1.305，Adapter 自身的 `ClaudeSdkTransport` 驱动真实 CLI。一轮要求依次执行三次 `sleep 6`，第一个工具开始约 1.5 秒后调用 `steer()`。`steer()` 在 `queued` 时立即 resolve；本轮只执行了一次 `sleep`，`runTurn` 以 `succeeded` 结束，transcript 中模型回复的是插入要求的文本。
