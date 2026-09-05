## Context

基于 #158，`turn.steer` 严格表示同一 Host Turn 的追加输入。Desktop 的 steeringUserMessage 乐观状态绑定旧 Turn，旧 Turn 结束时会恢复未消费消息，因此跨 Turn 续发必须协调该状态与新 Turn 的正常 userMessage 投影。

## Goals / Non-Goals

Goals: 按 Session 能力提供可用调整；保留原生历史；原子保留执行入口并处理取消、重试、终态及关闭竞态。

Non-Goals: 修改官方 Codex 的 steering；回滚工作区；把普通 follow-up 排队冒充调整；未经证据宣布所有版本支持原生同 Turn steering。

## Decisions

- 保留 `activeTurns.steer`，增加可选的 `activeTurns.interruptAndContinue`。未声明视为不支持。原生 steer 优先；没有可靠同 Turn 历史分组的 Adapter 使用中断续发。
- 新增外部 `codexhost/turn/adjust` 请求，复用 steering 输入并要求 clientUserMessageId。Host 返回实际 delivery 和 Turn ID；原生 `turn/steer` 仍保持原契约。
- 中断续发由 Host 协调，Adapter 负责原生 cancel 及终态。Host 持有 Session access reservation，先确认旧 Turn 的原生终态并等待已有输出完成投影，再建立新 Turn。不会关闭共享远端 Host 来模拟取消。
- 每个 Session 同时只允许一个中断续发事务。重复 identity 复用结果，冲突输入拒绝。取消失败、超时、Session fault、关闭或显式停止后，不自动启动后续 Turn。
- Desktop 请求桥按 Thread inspection 选择路径。只在可识别的乐观消息状态下接入跨 Turn 调整；移除旧 Turn 待处理消息后发送调整，失败交回原生恢复路径；新 Turn 通过正常 userMessage 事件展示输入。官方请求保持原样。
- #155 的 rollback 路径不能替代取消续发。它要求额外证明 DeepSeek 关闭围栏，且仅针对 exact Modern 版本；本次保留 #158 的 fail-closed rollback 声明，不仅为整合开启布尔值。

## Risks / Trade-offs

- 原生有 steer 并不证明现有 Adapter 历史可恢复分组。Pi/OMP 等可先用已经明确结束边界的 cancel/prompt，避免引入另一份 Transcript；原生模式只有在关联、冷恢复和版本证据齐备时启用。
- Desktop 私有状态升级可能变化 → 检查 turns 与 canonical turnHistory 两种已观察形态，不支持的形态在取消前拒绝。
- 取消收据不等于结束 → 唯一输出消费者完成 terminal 投影后才唤醒事务；异常关闭明确失败。
- 操作超时或重连时不盲目重放消息；已结束事务的请求结果保留在 Session 内，旧 identity 超出缓存后通过 stale Turn 校验拒绝。
