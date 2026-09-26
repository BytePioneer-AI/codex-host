# Grok 同轮插入

Grok ACP 扩展方法是 `_x.ai/interject`。SDK 去掉前导下划线后，上游匹配 `x.ai/interject`。参数是 `{sessionId, text}`。成功回执是 `{status:"queued"}`。`rejected` 是 `invalidState`。方法不存在或其他传输失败保持原有传输错误。没有版本门槛：打开的会话声明 `capabilities.steer`。

`turn.steer` 只对当前活跃 Turn 调用这个方法，不取消、不另起 Turn。空文本是 `invalidRequest`。目标不是活跃 Turn，或插入期间 Turn 已经结束，是 `invalidState`。Adapter 不发布 `userMessage`。实时 `user.text` 本来就不投影成用户消息。忙时 `turn.start` 仍是 `sessionBusy`。

## 历史

现有历史解析把连续的 `user.text` 收进同一轮输入。`<system-reminder>` 才会结束当前轮。同轮插入因此通常不增加 Native Turn。若原生后来把插入提升成独立轮，新轮数可以等于 1 加本轮已被原生接受的插队数。这两种数量都把第一条新 Native Turn（原提问）当作本轮身份。其他数量仍失败，以免其他客户端写入同一会话时绑错 Fork 或回退位置。零插队时这仍是原先的“恰好一轮”。

## 验证

未实机验证。本机没有 `grok`。行为依据上游 `extensions/interject.rs` 的 `x.ai/interject`，以及现有历史合并。单元测试覆盖声明、`_x.ai/interject`、调用参数、非活跃目标、同轮与拆轮身份、数量不符、忙时 `turn.start`，以及不发布 `userMessage`。
