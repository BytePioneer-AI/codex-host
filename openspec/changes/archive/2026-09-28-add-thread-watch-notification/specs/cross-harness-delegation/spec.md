## MODIFIED Requirements

### Requirement: 委派创建与结果观察解耦且不主动注入父 Session
`codexhost delegate start --harness <harnessId> --task <text> [--parent-thread <thread>] [--request-id <id>] [--watch true|false] [--watch-timeout-ms <n>]` SHALL 在创建目标 Session/Thread 并投递任务后立即返回。`--harness` 与 `--task` SHALL 为必填参数；`--parent-thread` SHALL 显式覆盖 Host 推断的调用方 Thread；`--request-id` SHALL 承载调用方提供的幂等标识。发起方 Agent SHALL 可以自主选择通过 `thread read` 读取、通过有界 `thread wait` 等待、通过 `thread watch` 或 `--watch true` 注册一次性停下通知、稍后再次观察，或不再跟踪。除调用方显式注册的 watch 外，Host MUST NOT 在子任务完成后向父 Session 注入结果、唤醒父 Agent 或为此创建自主 Turn。

#### Scenario: 委派创建成功返回
- **WHEN** 调用方执行有效的 `codexhost delegate start --harness <harnessId> --task <text>`
- **THEN** CLI SHALL 返回包含 `delegationId`、`threadId`、`harnessId`、`deepLink` 与当前 `status` 的 JSON 对象
- **AND** MUST NOT 等待被委派工作完成
- **AND** SHALL 在响应中给出可用于 `thread read` 与 `thread wait` 的下一步命令提示

#### Scenario: 运行期间打开外部 Harness 委派 Thread
- **WHEN** 外部 Harness 的委派 Turn 仍在运行且用户打开其子 Thread
- **THEN** Host 的实时 Turn 投影 SHALL 包含本次委派任务对应的 `userMessage`
- **AND** SHALL 在同一 Turn 中继续投影 Agent 的可见进度与最终消息
- **AND** 完成后的实时 Turn 与原生历史恢复结果 MUST NOT 重复该 `userMessage`

#### Scenario: 显式指定父 Thread 与 Request ID
- **WHEN** 调用方同时提供 `--parent-thread <thread>` 与 `--request-id <id>`
- **THEN** Host SHALL 使用规范化后的父 Thread 标识记录 Delegation 关系
- **AND** SHALL 使用该 Request ID 执行幂等创建
- **AND** MUST NOT 以环境中的 Host Thread 标识或活跃 Turn 推断覆盖显式参数

#### Scenario: 发起方选择等待
- **WHEN** 发起方对一个运行中的子 Thread 调用有界 `thread wait`
- **THEN** Host SHALL 等待到子任务达到终态或期限到期
- **AND** 目标在期限内完成时 SHALL 返回结构化结果

#### Scenario: 等待超时
- **WHEN** 一次有界等待在被委派工作结束前到期
- **THEN** 命令 SHALL 以成功退出并报告状态为运行中
- **AND** 被委派的工作 SHALL 继续执行
- **AND** 该结果 MUST NOT 被表述为失败

#### Scenario: 发起方选择后台运行或不再跟踪
- **WHEN** 发起方未注册 watch，并在创建后不调用 `thread wait` 或结束当前 Turn
- **THEN** 被委派工作 SHALL 独立继续执行
- **AND** Host MUST NOT 为发起方建立完成通知、输入注入或续写义务
- **AND** 子 Thread SHALL 继续可由用户或后续 Agent 调用通过标识读取

#### Scenario: 发起方在创建时注册 watch
- **WHEN** 调用方执行 `delegate start ... --watch true`
- **THEN** Host SHALL 先完成委派，再以委派已解析的父 Thread 作为被通知方为子 Thread 注册 watch
- **AND** 响应 SHALL 在 `watch` 字段中报告注册结果
- **AND** watch 注册失败或无父 Thread 时 SHALL 报告 `notRegistered` 与原因，MUST NOT 使委派本身失败

#### Scenario: 子任务完成
- **WHEN** 被委派的子 Thread 达到完成、失败或取消终态
- **THEN** Host SHALL 更新该子 Thread 与 Delegation 关系的状态，并保留可读取的结构化结果
- **AND** 没有针对该子 Thread 的已注册 watch 时，MUST NOT 因该终态向父 Session 提交新的输入

#### Scenario: 结果被结构化描述
- **WHEN** 委派结果通过 `thread read` 或 `thread wait` 返回
- **THEN** 它 SHALL 包含子 Thread 标识、当前状态，以及由 `availability` 和可选 `text` 构成的结果判定
- **AND** `availability` SHALL 为 `pending`、`available` 或 `unavailable`
- **AND** 它 MUST NOT 仅以自由文本表述成败

## ADDED Requirements

### Requirement: 调用方可显式注册一次性 Thread 停下通知
系统 SHALL 提供 `codexhost thread watch <thread> [--notify <thread>] [--timeout-ms <n>]` 与 `codexhost thread watches`。watch 在被观察 Thread 停下或到期时，SHALL 通过与 `thread send` 相同的路径在被通知 Thread 中启动一个新 Turn，且只通知一次。被观察 Thread 与被通知 Thread 可以是任意两个不同的 Thread，不要求委派血缘。通知 SHALL 只报告执行状态与 Thread 链接，MUST NOT 携带或摘要会话内容，也 MUST NOT 被表述为工作已验收。watch SHALL 只保存在 Host Runtime 内存中，不提供取消操作。

#### Scenario: 注册后立即返回
- **WHEN** 调用方对一个运行中的 Thread 执行 `thread watch`
- **THEN** 命令 SHALL 立即返回 `state: "watching"`
- **AND** 调用方 SHALL 可以结束自己的 Turn，无需等待或轮询

#### Scenario: 注册时已是终态
- **WHEN** 被观察 Thread 在注册时没有运行
- **THEN** 命令 SHALL 返回 `state: "alreadyTerminal"` 与当前状态
- **AND** MUST NOT 注册 watch 或发送通知

#### Scenario: 被通知 Thread 的确定
- **WHEN** 调用方执行 `thread watch`
- **THEN** 被通知 Thread SHALL 依次取显式 `--notify`、Host 提供的 `CODEXHOST_THREAD_ID`
- **AND** 两者都没有时 SHALL 以 `INVALID_ARGUMENT` 失败并要求 `--notify`
- **AND** MUST NOT 根据活跃 Turn 推断被通知方

#### Scenario: 通知结果
- **WHEN** 被观察 Thread 停下、到期、持续无法读取或不再存在
- **THEN** 通知结果 SHALL 分别为 `completed`、`failed`、`interrupted`、`timedOut`、`unreadable` 或 `notFound`
- **AND** 终态结果 SHALL 注明其来源 Turn
- **AND** 读取失败 SHALL 在持续 60 秒后才报告 `unreadable`，仅在确认 Thread 不存在时报告 `notFound`

#### Scenario: 调整方向不视为停下
- **WHEN** 被观察 Thread 的旧 Turn 因“调整方向”被停止并由新 Turn 接续
- **THEN** watch MUST NOT 通知
- **AND** SHALL 在 Thread 真正停下时通知一次

#### Scenario: 被通知 Thread 正忙
- **WHEN** 通知到期时被通知 Thread 有活跃 Turn
- **THEN** 通知 SHALL 保持待送达并在最长 6 小时内重试
- **AND** `THREAD_BUSY` MUST NOT 被视为已送达
- **AND** `thread send` 自身 MUST NOT 因此改为排队

#### Scenario: 投递结果未知
- **WHEN** 投递失败且调用链不能证明未启动 Turn，例如 Harness 启动确认超时
- **THEN** Host MUST NOT 重试该投递
- **AND** SHALL 将 watch 标记为 `undeliverable` 并保留原因

#### Scenario: 无法投递
- **WHEN** 被通知 Thread 不存在、只读，或超过 6 小时仍无法送达
- **THEN** watch SHALL 标记为 `undeliverable` 并保留原因
- **AND** `thread watches` SHALL 列出观察中、待投递及保留中的无法投递记录；无法投递记录最多保留最近 50 条

#### Scenario: 用户 Stop 被通知 Thread
- **WHEN** 用户停止被通知 Thread 的当前 Turn
- **THEN** 已注册的 watch SHALL 保持有效
- **AND** 该 Thread 空闲后，到期的通知 SHALL 仍启动一个新 Turn

#### Scenario: Host Runtime 重启
- **WHEN** Host Runtime 在 watch 送达前重启
- **THEN** 未送达的 watch SHALL 丢失且不再通知
- **AND** Delegation 关系 SHALL 保持持久化，调用方可重新注册
