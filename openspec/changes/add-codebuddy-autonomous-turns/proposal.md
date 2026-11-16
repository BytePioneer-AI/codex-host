# Proposal

## Why

CodeBuddy CLI、WorkBuddy（国际版）和 WorkBuddy 国内版的原生 ACP 都会在没有 Host `turn.start` 时自己跑一轮：后台任务完成、cron 或协调者结果会触发一次 drain，原生先发 `session_info_update` 声明 unsolicited Turn，再发内容帧，最后用 `session_end` 收尾。共用 Session 当前只把内容交给活动 Turn，空闲时到达的后台结果没有公共 Turn 承接，在 Desktop 与 Web 里不可见。B12 是 P1“原生有则必做”。

## What Changes

- 共用 CodeBuddy Session 声明 `autonomousTurns.observe`，把空闲时的原生 drain 投影为一个带 `input: []` 的公共自主 Turn，并按普通 Item/Turn 规则给出唯一终态。
- 自主 Turn 占用 Session 期间，Host `turn.start` 继续按 `sessionBusy` 拒绝；上一个 Host Turn 收尾期间到达的 drain 帧按原生顺序暂存，等 Host 终态后再建立自主 Turn，两类 Turn 不混写。
- 取消、关闭和 fault 沿用现有生命周期：取消调用原生 `session/cancel` 并等待 `session_end`，超时按现有 fault 规则报告，不伪造终态。
- 只读历史把原生注入的 meta 输入行投影为同一自主 Turn 的空输入，实时与重放看到相同的 Turn 身份、Item 和终态。
- 同步 CodeBuddy 与 WorkBuddy 集成文档；不修改 `workbuddy-cn` 的独立能力清单。

## Decisions

- 落盘 Turn 按原生顺序和已消费边界关联，不使用 Host 墙钟；Host 轮优先用 prompt response 的 `userMessageId`。自主 Turn 的成功与否只认该 Turn 的落盘 outcome；`session_end` 的 `stopReason` 恒为 `end_turn`，不能作为成功证据。落盘为 unknown 时记 failed。
- 三个 Harness 共用同一 Session 与同一份静态证据（三个发行 bundle 都含 announce/drain 实现），因此共用一份能力声明，不引入按 Harness 的开关。
- 取消后与普通 Turn 一样重建原生连接，避免 CodeBuddy 保留的取消状态污染下一轮。

## Capabilities

### New Capabilities

- `codebuddy-autonomous-turn-session`：CodeBuddy 与 WorkBuddy 共用 Session 的自主 Turn 投影、Turn 互斥、终态与历史一致性。

### Modified Capabilities

无。沿用现有 Harness 会话、Turn 与历史契约。

## Impact

只改 `packages/adapters/codebuddy`（`autonomous.ts`、`session.ts`、`configuration.ts`、`history.ts`）、其聚焦测试、`packages/adapters/workbuddy` 的能力断言与两份 Harness 文档。公共契约、Host、Renderer 与 `workbuddy-cn` 插件不变。
