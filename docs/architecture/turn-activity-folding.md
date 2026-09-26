# 回合完成后的过程折叠

Codex Desktop 在回合完成后，会把最终回复之前的推理、命令和工具调用折叠到“Worked for …”分隔条后面。本文记录外部 Harness Thread 如何获得这一行为。

## Desktop 的判断条件

Desktop 只在同时满足以下条件时允许折叠（依据 Codex Desktop 26.924.2738.0 前端代码）：

- 回合最后一条 Agent 消息的 `phase` 为 `final_answer`，且有内容；
- 回合没有被取消；
- 最终回复之前存在可折叠的条目。

Desktop 处理 `turn/completed` 时只读取状态、错误和耗时，不读取其中的 `items`；`item/completed` 按条目 id 替换已有条目。分隔条有耗时时显示“Worked for {time}”，没有耗时时显示“{count} previous messages”，两者都可以折叠。

## 最终回复阶段的来源

`HostAgentMessageItem.phase` 由 Adapter 给出时始终优先。Adapter 未给出时，Protocol Core 按以下规则推断（`packages/protocol-core/src/final-answer-phase.ts`）：

- Desktop 把该回合显示为已完成：实时回合成功结束，或历史回合结果为 `succeeded` / `unknown`（即 `historicalStatus` 为 `completed`）；
- Desktop 可见的最后一个条目是 `agentMessage`，其自身结果为成功且文本非空；
- 满足时把该消息投影为 `final_answer`，其余消息保持 `phase: null`。推断只影响消息阶段，不改变回合结果。

历史回合的 `unknown` 表示原生历史没有记录终止证据，而不是失败或取消；有证据时 Adapter 会给出 `failed` 或 `cancelled`。Claude Code 的会话记录不保存 SDK Result，按其规范历史回合一律为 `unknown`；Hermes 与 Cursor CLI 的历史同样不记录回合结果。Grok、CodeBuddy / WorkBuddy、Kiro CLI、Kimi Code、Qoder、Pi、OMP、OpenCode 仅在缺少终止证据时给出 `unknown`；DeepSeek Harness 不产生 `unknown`。

“可见条目”按 Desktop 实际收到的顺序计算：Todo 工具、无法解析的文件写入工具和空 Reasoning 不计入；同一回合的文件变更合并为一个汇总条目，位置在首次文件变更处。

两条投影路径使用同一规则：

- 实时回合：`CodexTurnProjector` 在 `turn/completed` 之前重发该消息的 `item/completed`，使 Desktop 替换已有条目；
- 历史回合：`projectHistoricalTurn` 直接投影出带 `final_answer` 的消息。外部 Thread 的条目不持久化，每次打开都从原生历史重新投影，因此旧会话同样生效。

Adapter 需要让某条结尾消息不作为最终回复时，显式设置 `phase: "commentary"`。

## 已知限制

- 折叠发生在回合结束时，而不是最终回复开始输出时；原生 Codex 在最终回复开始时即可折叠。
- 回合以工具调用或文件变更收尾时不推断，过程保持展开。
- Adapter 把一段最终回复拆成多条连续消息时，只有最后一条被视为最终回复，前面的消息会随过程折叠。
- 取消或失败的回合不折叠，与原生 Codex 一致。
- 对仅在缺少终止证据时才给出 `unknown` 的 Harness，这类回合更可能是异常结束；它们同样按已完成推断，最后一段文字会被当作最终回复，过程仍可展开查看。

## 与 Adapter 显式阶段的关系

Kiro CLI（`turn-output.ts`、`history.ts`、`kiro-adapter.ts`）、Qoder（`qoder-sdk-transport.ts`、`qoder-history.ts`，Qoder CN 复用）和 Kimi Code（`kimi-session.ts`、`history.ts`）在引入本规则前已自行标注 `final_answer`，规则与上述推断基本等价，推断对它们不生效。区别在于：Kimi Code 只在回合含工具调用时标注；Qoder 实时路径会把不含工具调用的单条消息直接标为 `final_answer`；Kiro CLI 与 Qoder 的历史回合结果不是 `succeeded`（包括 `unknown`）时，结尾消息被显式标为 `commentary`，这类回合不折叠。

这些 Adapter 在失败或取消时标注的 `commentary` 仍有作用：委派快照据此不把失败回合的部分输出报告为最终结果。推断规则稳定后，可删除三者标注 `final_answer` 的部分，保留失败与取消时的 `commentary`。
