# Pi 同轮插入

`--mode rpc` 接受 `{type:"steer", message}`。`session.steer` 把文本放进 steering 队列。正在运行的 agent loop 在当前助手消息的工具调用执行完后、下一次模型调用前，用 `message_start` / `message_end`、`role:"user"` 注入同一次运行。回执 `success: true` 只表示已经入队。依据是随包 `docs/rpc.md`。

会话和 inspect 都无条件声明 `capabilities.steer`。不探测 `pi --version`：那会在 Host 进程里 `spawnSync`，最长阻塞 5 秒。版本门槛也没有区分度。`steer` 在 0.32.0 引入，而 Pi Adapter 已经依赖 0.8x 才有的 RPC `agent_settled` 与 `get_entries`（Pi CHANGELOG）。能被 Adapter 驱动的 Pi 都具备 steer。

`turn.steer` 只对当前活跃 Turn 调用这个 RPC，不取消、不另起 Turn。空文本是 `invalidRequest`。目标不是活跃 Turn、会话已关闭，或原生拒绝，是 `invalidState`。原生接受后 Adapter 不发布 `userMessage`。实时里的 user `message_end` 仍被忽略，不会变成 Agent 消息或新 Turn。忙时 `turn.start` 仍是 `sessionBusy`。

## 历史

现有历史解析把每条用户消息当成一轮。本机 Pi 0.85.1 持久化的插入没有 `steering` 标记，刷新后它是单独一轮。Adapter 不把插入并回原提问。本轮结束时，新用户条目数等于 1 加本轮已被原生接受的插队数，才把第一条（原提问）当作本轮身份；数量不符仍失败，以免其他客户端写入同一会话时绑错 Fork 或回退位置。

错过本轮最后一次 steering 轮询的消息留在队列里。Pi 不会为此自动继续。Adapter 不补开 Turn。

## 验证

单元测试覆盖会话与 inspect 的声明、RPC 参数、非活跃目标、身份计数、数量不符、忙时 `turn.start`，以及不发布 `userMessage`。

2026-09-24 用已安装的 Pi 0.85.1，经 `PiAdapter` 实机核对。模型是 `uino/deepseek-flash`，thinking 为 `off`。Turn 只要求调用一次 bash（`echo steer-live`）。工具一开始就发送 `turn.steer`，插入文本里有一个原提问没有的标记。原生接受后，工具结束，同一 Host Turn 的助手回复就是该标记。`turn.completed` 成功，身份绑定原提问，不绑定插入。历史快照把插入分成下一轮。
