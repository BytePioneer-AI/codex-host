# Claude Code 同轮插入

Claude Code 的运行中插入走 Agent SDK 流式输入：向当前 Query 的输入流推入 `SDKUserMessage`，`priority: "next"`，`origin: { kind: "human" }`。这不会取消当前 Turn，也不会另开一轮。`now` 会把正在运行的 shell 命令、子 Agent 和 MCP 调用转入后台后立即送达，`later` 会等到空闲，Adapter 都不用。

Host 在原生接受后自己发当前 Turn 的 `userMessage` Item。Adapter 不发这条 Item，也不改历史解析。

## 何时同轮插入

`priority: "next"` 在**当前工具调用结束后**、下一次模型请求之前并入；工具结果之后一定还有一次模型请求，所以插入写入时只要有根级工具调用正在执行，它就一定并入当前 Turn。反过来，如果 Claude 正在输出最终文本、没有工具在执行，它可能直接结束本轮，把插入留到下一轮执行：2026-10-22 在 Claude Code 2.1.305 上实测，Host 把插入显示在原来那一轮，而 Claude 在随后的另一轮里回复。

因此 `capabilities.steer` 实时取以下三项的交集，任何一项不满足都为 `false`，Host 改用停止后重发：

- CLI 在 `system/init` 的 `capabilities` 中报告 `msg_lifecycle_v1`，会发出确认插入所需的 `command_lifecycle` 回执；
- 当前是用户发起的 Turn，不是后台通知等触发的自主 Turn（transport 没有对应的活跃 Turn）；
- 有根级工具调用已经开始、还没返回结果（子 Agent 内部的工具调用不计入）。

`turn.steer` 在写入输入流前同步复查上述三项，不依赖 Renderer 之前的查询结果；工具已经结束时拒绝且不写入。Renderer 已按同轮展示时，Host 报错而不停止后重发。Harness Broker 经公共 `readCapabilities()` 按需读取当前能力；旧 Broker 未声明支持查询时保持停止后重发。

## 接受

CLI 先发 `command_lifecycle` `queued`，表示 Claude 已接受这条输入；工具调用结束后发 `started`，这时插入进入正在运行的 Turn。Adapter 在 `queued` 时返回 `{ accepted: true }`：此后由 Claude 负责送达，不等 `started`，否则调用方要被整段工具调用挂住（Desktop 提交约 30 秒超时）。输入一旦写入就无法撤回，所以本轮的 `result` 先于 `queued` 到达时不拒绝，仍按接受处理；`queued` 回执迟迟不到时，等待 5 秒后同样按接受处理，避免串行处理请求的调用方（如 Harness Broker）被无限期占住。只有目标不是当前 Turn、CLI 不支持、当前是自主 Turn、没有根级工具执行，或输入写入失败时，才返回失败。写入后会话关闭或出错时抛出回执丢失异常，不返回表示未收下的拒绝结果，Host 不自动重发；Session 故障仍经原有故障路径报告。空文本返回 `invalidRequest`。忙时 `turn.start` 仍是 `sessionBusy`。

插入被接受后、还没并入之前，如果用户停止了这一轮，按 SDK 的中断语义，仍在排队的插入会在下一轮执行。公开的 SDK 接口目前没有撤回单条排队消息的方法，Adapter 不处理这种情况；由于只在工具执行期间插入，这个窗口只剩当前那次工具调用的剩余时间。

## 版本

2026-09-24 在 Claude Code 2.1.280 上实机确认；2026-10-21 在 Claude Code 2.1.305（Agent SDK 0.3.273 与 0.3.305）上复核了相同的 `queued` → `started` → `completed` 顺序和单个 `result`，这两个版本都会报告 `msg_lifecycle_v1`。其他版本只依据这项运行时能力判断，没有逐个实机验证。

## 历史

原生把插入记成同一条 transcript 里的 `queued_command` attachment（`commandMode: "prompt"`，`source_uuid` 是插入消息 id），不是新的 user 消息。现有历史解析忽略 attachment，所以刷新后仍是原来那一轮，插入文本不会变成单独的 Turn 或 Item。

## 验证

实机：模型 `haiku`，权限 `bypassPermissions`，一轮里调用 Bash 执行 `sleep 4; echo tool-done`，工具开始后以 `priority: "next"` 插入一句。流里只有一次 `result`（`subtype: "success"`，`terminal_reason: "completed"`）。`started` 出现在工具结果之后、下一次模型请求之前，模型回复提到了插入的句子。因此实时结果处理不改：纯文本 user 回显本来就被忽略，第一个 `result` 仍是本轮结束。

2026-10-21 复核：Linux aarch64，Claude Code 2.1.305，Adapter 自身的 `ClaudeSdkTransport` 驱动真实 CLI。一轮要求依次执行三次 `sleep 6`，第一个工具开始约 1.5 秒后调用 `steer()`。`steer()` 在 `queued` 时立即 resolve；本轮只执行了一次 `sleep`，`runTurn` 以 `succeeded` 结束，transcript 中模型回复的是插入要求的文本。
