# OMP 同轮插入

依据 can1357/oh-my-pi。OMP 的 RPC `{type:"steer", message}` 调用 `session.steer`，agent loop 在当前工具批次结束后、下一次模型调用前注入该消息。插入的用户消息带 `steering: true`。回执没有关联 ID。同批里尚未开始的工具由 OMP 跳过，Adapter 不补执行。

会话和 inspect 都无条件声明 `capabilities.steer`。不探测 `omp --version`：那会在 Host 进程里 `spawnSync`，最长阻塞 5 秒。OMP 是在 Pi 已有 steer 之后分叉的，能被 Adapter 驱动的 OMP 都具备同一原语，版本门槛没有区分度。

`turn.steer` 只对当前活跃 Turn 调用这个 RPC，不取消、不另起 Turn。空文本是 `invalidRequest`。目标不是活跃 Turn、会话已关闭，或原生拒绝，是 `invalidState`。原生接受后 Adapter 不发布 `userMessage`。实时里的 user `message_end` 仍被忽略。忙时 `turn.start` 仍是 `sessionBusy`。

## 历史

现有历史解析把每条用户消息当成一轮，包括带 `steering: true` 的插入。刷新后插入是单独一轮。Adapter 不把插入并回原提问。本轮结束时，新用户条目数等于 1 加本轮已被原生接受的插队数，才把第一条（原提问）当作本轮身份；数量不符仍失败。

若 steer 错过循环的最后一次轮询，OMP 可能在本轮结束后自行 `continue`。那是原生的新一轮，Adapter 不把它改写成当前 Turn。

## 验证

未实机验证。本机没有 `omp`。行为依据上游 `session.steer`、`message.steering` 和 agent loop。单元测试覆盖会话与 inspect 的声明、RPC 参数、非活跃目标、身份计数、数量不符、忙时 `turn.start`，以及不发布 `userMessage`。
