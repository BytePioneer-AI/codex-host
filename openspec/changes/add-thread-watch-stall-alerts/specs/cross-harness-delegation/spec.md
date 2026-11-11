## ADDED Requirements

### Requirement: 调用方可选择 Thread 静默卡住提醒
`thread watch` 与 `delegate start --watch true` SHALL 接受可选正整数 `--stall-after-ms <n>`（MCP 的 `thread_watch` 与 `delegate_start` 中为 `stallAfterMs`），默认关闭；未启用 watch 的 `delegate start` MUST NOT 接受该参数。启用后，被观察 Thread 仍在运行而 Host 在阈值内没有观察到它的 Harness 活动时，SHALL 以 `stalled` 结果提醒；提醒 MUST NOT 结束观察，也 MUST NOT 被表述为失败。同一对 Thread 的重复注册 SHALL 保留原观察期限与静默阈值。

#### Scenario: 静默达到阈值只提醒一次
- **WHEN** 启用卡住提醒的被观察 Thread 仍在运行，且从注册或最后一次活动起静默达到阈值
- **THEN** Host SHALL 生成一条 `stalled` 通知，含 Thread 链接与可用的 Turn 标识，并说明至少多长时间没有观察到 Harness 事件
- **AND** 该时长 SHALL 按调用方给出的阈值精确表述，MUST NOT 取整（例如 90 秒不得写成 2 分钟）
- **AND** 同一段持续静默 MUST NOT 重复提醒，原 watch SHALL 继续观察停下与到期

#### Scenario: 提醒只报告执行状态
- **WHEN** 接收方收到 `stalled` 通知或事件
- **THEN** 通知 SHALL 说明 Thread 仍在运行、静默不证明失败，并让接收方读取 Thread 查看进度
- **AND** 通知 MUST NOT 携带或摘要会话内容与进度

#### Scenario: 任意 Harness 活动与子代理活动
- **WHEN** Host 收到被观察 Thread 或其 Harness 子代理的任何事件或交互，包括工具输出、推理与文件变化
- **THEN** Host SHALL 刷新该 Thread 及已知子代理祖先 Thread 的活动时间，并重新允许下一次静默提醒
- **AND** 轮询读取与 Host 自己的投影通知 MUST NOT 被当作活动
- **AND** 活动收集 MUST 使用已有原生 Codex app-server 与外部 Harness 事件流；MUST NOT 新建定时器、进程或 rollout 扫描

#### Scenario: 中间 Thread 先关闭
- **WHEN** 原生子代理链中的中间 Thread 或祖先 Thread 已关闭，而其后代仍在运行并产生事件
- **THEN** Host SHALL 继续把后代活动计入整条链上的祖先 Thread，MUST NOT 因中间 Thread 关闭而对祖先误报静默
- **AND** 该子树全部关闭后，Host SHALL 清除其祖先关系

#### Scenario: 合并投递且不结束观察
- **WHEN** 卡住提醒触发时接收方正忙，或同一接收方还有其他待投递通知
- **THEN** 卡住提醒 SHALL 沿已有待投递机制重试并合并；活动恢复后，待投递提醒仍保留触发时刻的事实
- **AND** 卡住提醒送达或投递失败 MUST NOT 结束主 watch 的停下观察

#### Scenario: 外部客户端接收卡住提醒
- **WHEN** 启用卡住提醒的 watch 以外部客户端为接收方，运行中的 Thread 静默达到阈值
- **THEN** Host SHALL 向该客户端事件日志写入 `outcome: "stalled"` 事件，含 Thread 链接、可用的 Turn 标识与说明静默的 `note`，不启动 Turn
- **AND** 事件 MUST NOT 表示 Thread 已失败或已停止；后续 Harness 活动 SHALL 允许下一段静默再次提醒

#### Scenario: 默认关闭
- **WHEN** 调用方未提供 `--stall-after-ms`
- **THEN** watch SHALL 保持原有的一次性停下、到期与读取故障通知行为，MUST NOT 因静默生成通知

#### Scenario: 重启后重新计时
- **WHEN** Host Runtime 重启
- **THEN** 静默阈值 SHALL 随 watch 保存并恢复，主 watch SHALL 继续观察
- **AND** 卡住提醒不是终态，MUST NOT 写入 watch 持久记录；重启前未送达的卡住提醒不再投递
- **AND** 恢复观察 SHALL 从恢复时刻重新计时，MUST NOT 将停机时长算作静默
- **AND** 重启前已经提醒过的静默，恢复后再次达到阈值时 SHALL 重新提醒
