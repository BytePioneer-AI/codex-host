## MODIFIED Requirements

### Requirement: 调用方可显式注册一次性 Thread 停下通知
系统 SHALL 提供 `codexhost thread watch <thread> [--notify <thread>] [--timeout-ms <n>]` 与 `codexhost thread watches`。watch 在被观察 Thread 停下或到期时，SHALL 通过与 `thread send` 相同的路径在被通知 Thread 中启动一个新 Turn，作为一次性通知。被观察 Thread 与被通知 Thread 可以是任意两个不同的 Thread，不要求委派血缘。通知 SHALL 只报告执行状态与 Thread 链接，MUST NOT 携带或摘要会话内容，也 MUST NOT 被表述为工作已验收。watch SHALL 持久保存并在 Host Runtime 重启后恢复，不提供取消操作。

#### Scenario: 注册后立即返回
- **WHEN** 调用方对一个运行中的 Thread 执行 `thread watch`
- **THEN** 命令 SHALL 返回 `state: "watching"`，不等待 Thread 停下
- **AND** 调用方 SHALL 可以结束自己的 Turn，无需等待或轮询

#### Scenario: 注册时已是终态
- **WHEN** 被观察 Thread 在注册时已完成、失败或中断
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
- **AND** 终态结果 SHALL 在快照提供 Turn 身份时注明其来源 Turn
- **AND** 读取失败 SHALL 在持续 60 秒后才报告 `unreadable`，仅在确认 Thread 不存在时报告 `notFound`

#### Scenario: 调整方向不视为停下
- **WHEN** 被观察 Thread 的旧 Turn 因“调整方向”被停止并由新 Turn 接续
- **THEN** watch MUST NOT 因旧 Turn 的终态通知
- **AND** SHALL 继续观察 Thread，直到真正停下或达到观察期限

#### Scenario: 重复注册与下一次停止
- **WHEN** 同一对 Thread 再次注册 watch
- **THEN** 仍处于观察中的注册 SHALL 去重并保留原观察期限
- **AND** 旧通知已待投递且被观察 Thread 重新运行时，SHALL 为下一次停止建立新观察
- **AND** 旧通知 MUST NOT 被新注册替换或丢弃

#### Scenario: 被通知 Thread 正忙
- **WHEN** 通知到期时被通知 Thread 有活跃 Turn
- **THEN** 通知 SHALL 保持待送达并在最长 6 小时内重试
- **AND** `THREAD_BUSY` MUST NOT 被视为已送达
- **AND** `thread send` 自身 MUST NOT 因此改为排队
- **AND** 每次投递 SHALL 合并该接收方当前所有待投递通知，包括此前轮询积累的通知

#### Scenario: 已确认未启动的投递失败
- **WHEN** 投递失败且调用链确认未启动 Turn，例如 resume 校验失败或原生明确拒绝启动
- **THEN** Host SHALL 在投递期限内保留通知并重试
- **AND** 接收方已不存在或只读时 SHALL 直接标记 `undeliverable`

#### Scenario: 投递结果未知
- **WHEN** Host Runtime 运行期间投递失败，且调用链不能证明未启动 Turn，例如 Harness 启动确认超时
- **THEN** Host MUST NOT 重试该投递
- **AND** SHALL 将 watch 标记为 `undeliverable` 并保留结果未知的原因

#### Scenario: 无法投递
- **WHEN** 被通知 Thread 不存在、只读，或超过 6 小时仍无法送达
- **THEN** watch SHALL 标记为 `undeliverable` 并保留原因
- **AND** `thread watches` SHALL 列出观察中、待投递及保留中的无法投递记录；无法投递记录最多保留最近 50 条

#### Scenario: 用户 Stop 被通知 Thread
- **WHEN** 用户停止被通知 Thread 的当前 Turn
- **THEN** 已注册的 watch SHALL 保持有效
- **AND** 该 Thread 空闲后，到期的通知 SHALL 仍启动一个新 Turn

#### Scenario: Host Runtime 重启
- **WHEN** Host Runtime 在被观察 Thread 停下前重启
- **THEN** 重启后 watch SHALL 恢复为观察中，并保留原注册时间、观察期限和被通知 Thread
- **AND** `thread watches` SHALL 在重启前后列出相同的记录
- **AND** 调用方 MUST NOT 需要重新注册

#### Scenario: 停机期间被观察 Thread 已停下
- **WHEN** 被观察 Thread 在 Host Runtime 停机期间达到终态
- **THEN** 恢复后 Host SHALL 按其实际终态通知被通知 Thread
- **AND** 观察期限已过但 Thread 已是终态时，结果 SHALL 为该终态而非 `timedOut`

#### Scenario: 期限按绝对时间计算
- **WHEN** Host Runtime 停机一段时间后恢复
- **THEN** 观察期限与 6 小时投递期限 SHALL 按注册或到期时的绝对时间计算，停机时间计入期限
- **AND** 恢复时已超过观察期限且 Thread 仍未停下的 watch SHALL 以 `timedOut` 通知

#### Scenario: 恢复后会话尚未就绪
- **WHEN** Host Runtime 刚恢复 watch，持有被观察 Thread 的会话尚未重新注册
- **THEN** 这期间的读取失败 MUST NOT 计入 60 秒 `unreadable` 宽限，也 MUST NOT 报告 `notFound` 或 `timedOut`
- **AND** 宽限 SHALL 从 Runtime 重新具备读取该 Thread 的会话后开始计算；会话 5 分钟内仍未注册时，从 5 分钟期满起计算
- **AND** 恢复的待投递通知 SHALL 等被通知 Thread 可读后再投递

#### Scenario: 重启中断了正在运行的 Turn
- **WHEN** 被观察 Thread 在 Host Runtime 重启前正在运行，恢复后第一次成功读取时已是终态
- **THEN** 通知结果 SHALL 为 `interrupted`，并说明 Host Runtime 重启时它正在运行、之后读到的状态
- **AND** MUST NOT 报告为 `completed`，即使恢复出的 Turn 换了标识
- **AND** 恢复宽限结束后 Thread 仍无法打开时，SHALL 同样报告 `interrupted` 并说明无法重新打开，而不是 `notFound`
- **AND** 恢复后第一次读取时仍在运行的 Thread，之后停下时 SHALL 按实际终态报告

#### Scenario: 多个 Runtime 共用数据目录
- **WHEN** 同一 OS 用户同时运行多个 Host Runtime 进程，例如 Desktop 与远程监听
- **THEN** 每个 watch SHALL 只由一个 Runtime 观察和投递
- **AND** 某个 Runtime 退出后，它的 watch SHALL 由之后启动的 Runtime 接管，且只被接管一次

#### Scenario: 停机时投递正在进行
- **WHEN** Host Runtime 在一次投递已开始、结果尚未记录时退出
- **THEN** 恢复后 Host SHALL 将该通知视为待投递并再投递一次
- **AND** 被通知 Thread MAY 因此收到重复通知
- **AND** 通知文本 SHALL 保持只报告执行状态与 Thread 链接，使接收方可以先读取状态再行动

#### Scenario: 持久记录不含会话内容
- **WHEN** watch 记录被写入持久存储
- **THEN** 记录 SHALL 只包含 Thread 标识、状态、结果、来源 Turn、期限、时间戳与原因
- **AND** MUST NOT 包含会话内容、任务文本或凭据
- **AND** 存储 SHALL 仅当前 OS 用户可读写
