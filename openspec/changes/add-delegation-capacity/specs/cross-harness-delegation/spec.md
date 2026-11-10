## MODIFIED Requirements

### Requirement: 委派创建与结果观察解耦且不主动注入父 Session
`codexhost delegate start --harness <harnessId> --task <text> [--parent-thread <thread>] [--request-id <id>] [--watch true|false] [--watch-timeout-ms <n>]` SHALL 在创建目标 Session/Thread 并投递任务后立即返回；本机委派上限已满时 SHALL 排队后立即返回。`--harness` 与 `--task` SHALL 为必填参数；`--parent-thread` SHALL 显式覆盖 Host 推断的调用方 Thread；`--request-id` SHALL 承载调用方提供的幂等标识。发起方 Agent SHALL 可以自主选择读取、有界等待、注册一次性停下通知、稍后再次观察，或不再跟踪。除调用方显式注册的 watch 外，Host MUST NOT 在子任务完成后向父 Session 注入结果、唤醒父 Agent 或为此创建自主 Turn。

#### Scenario: 委派创建成功返回
- **WHEN** 调用方执行有效的 `codexhost delegate start --harness <harnessId> --task <text>`
- **THEN** CLI SHALL 返回包含 `delegationId`、`threadId`、`harnessId`、`deepLink` 与当前 `status` 的 JSON 对象
- **AND** MUST NOT 等待被委派工作完成
- **AND** SHALL 在响应中给出可用于 `thread read` 与 `thread wait` 的下一步命令提示

#### Scenario: 本机委派上限已满
- **WHEN** 本机委派上限已开启且已满，调用方执行有效的 `delegate start`
- **THEN** CLI SHALL 立即返回 Thread 标识、`status: "queued"` 与排队位置
- **AND** Host MUST NOT 在排到之前投递任务；外部 Harness MUST NOT 在排到之前创建目标 Session/Thread
- **AND** 该委派开始后 SHALL 沿用已返回的 Thread 标识

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
- **THEN** Host SHALL 先完成委派或排队，再以委派已解析的父 Thread 作为被通知方为子 Thread 注册 watch
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

### Requirement: 本机同时运行的委派可选上限
Host SHALL 提供本机同时运行的委派上限设置，默认关闭，上限为 1～32 的整数。设置 SHALL 保存在 Desktop 本地偏好中并只下发给本机 Host，Host 只在内存中保存。开启时，占用名额的 SHALL 是本 Host Runtime 中有活跃 Turn 的顶层 Thread，包括用户手动打开的 Thread，不含子代理。只有 `delegate start` SHALL 受限，外部 Harness 与原生 Codex 相同；后续消息与用户消息 MUST NOT 被拦截、排队或因上限失败。队列 SHALL 持久保存并在 Host Runtime 重启后恢复。

#### Scenario: 默认关闭
- **WHEN** 用户没有开启上限
- **THEN** `delegate start` SHALL 与没有该设置时行为一致，立即创建 Thread，MUST NOT 排队

#### Scenario: 超过上限时排队
- **WHEN** 上限已开启，正在运行的顶层 Thread 数已达到上限，或已有委派在排队
- **THEN** `delegate start` SHALL 排队，并立即返回 Thread 标识、`queued` 状态与从 1 开始的排队位置
- **AND** 参数、父 Thread 与 Model 配置的校验 SHALL 在排队前完成，无效请求 MUST NOT 进入队列
- **AND** 相同 Request ID 或近期相同任务的重复请求 SHALL 返回同一个排队中的 Thread

#### Scenario: 有空位时按先后开始
- **WHEN** 运行中的 Turn 结束、上限调高或上限关闭，使名额空出
- **THEN** Host SHALL 按排队先后开始排队的委派，直到名额用完
- **AND** 新的启动 MUST NOT 越过已在排队的委派
- **AND** 开始时 SHALL 沿用排队时的任务参数与已分配的 Thread 标识
- **AND** 开始失败时该 Thread SHALL 读取为 `failed` 并附原因

#### Scenario: 计数口径
- **WHEN** 用户手动打开的 Thread、原生 Codex 委派或子代理正在运行
- **THEN** 手动打开的 Thread 与原生 Codex 委派 SHALL 占用名额
- **AND** 外部 Harness 与原生 Codex 的子代理 MUST NOT 占用名额

#### Scenario: 原生 Codex 委派排队
- **WHEN** `delegate start --harness codex` 需要排队
- **THEN** Host SHALL 在官方后端先创建没有 Turn 的 Thread，并返回该 Thread 的标识
- **AND** 只有第一条 Turn SHALL 排队，开始时 SHALL 在同一 Thread 中投递任务
- **AND** 排队相关的处理 MUST NOT 删除该 Thread

#### Scenario: 取消排队中的原生 Thread
- **WHEN** 调用方取消一个排队中的原生 Codex Thread
- **THEN** Host SHALL 先读取它的 Turn
- **AND** 没有 Turn 时 SHALL 将它移出队列并记为 `interrupted`，保留该 Thread
- **AND** 已有 Turn 时 SHALL 按已开始的委派建立委派关系并取消该 Turn

#### Scenario: 用户直接向排队中的原生 Thread 发消息
- **WHEN** 用户在 Desktop 中向排队中的原生 Codex Thread 发送消息
- **THEN** Host SHALL 把排队的任务与该消息在同一 Turn 中投递
- **AND** 后端答复前，该委派 SHALL 留在队列原位，MUST NOT 被队列开始，取消 SHALL 等到答复之后
- **AND** 后端开始该 Turn 后 SHALL 将它移出队列并建立委派关系，排队的任务 MUST NOT 之后再次开始
- **AND** 后端拒绝该 Turn 时，该委派 SHALL 留在原位继续排队

#### Scenario: 取消与用户消息交错
- **WHEN** 对排队中原生 Thread 的取消与用户在 Desktop 中发送的消息同时发生
- **THEN** 用户的消息 SHALL 照常进入该 Thread，MUST NOT 丢失
- **AND** 该委派 SHALL 记为取消

#### Scenario: 后续消息不受上限限制
- **WHEN** 运行数已达到或超过上限，调用方执行 `thread send` 或用户在已有 Thread 中发送消息
- **THEN** Host SHALL 照常启动 Turn
- **AND** MUST NOT 排队或因上限失败

#### Scenario: 设置下发
- **WHEN** Desktop 连接本机 Host 或用户修改设置
- **THEN** Desktop SHALL 把设置下发给本机 Host，MUST NOT 发给当前远程 Host
- **AND** Host 不支持该设置时，设置页 SHALL 提示不支持，MUST NOT 显示为已生效

#### Scenario: Host Runtime 重启
- **WHEN** Host Runtime 在排队的委派开始前重启
- **THEN** 重启后队列 SHALL 按原顺序与原 Thread 标识恢复
- **AND** 设置重新下发前，恢复的委派 SHALL 保持排队，新的启动排在其后；5 分钟内仍未收到设置时 SHALL 按关闭处理
- **AND** 重启时正在开始的外部 Harness 委派 SHALL 以 `interrupted` 结束并说明原因，MUST NOT 自动重试
- **AND** 重启时正在开始或正在被用户消息认领的原生 Codex 委派 SHALL 恢复为可能已开始；其后的自动开始、取消、用户消息与读取 SHALL 先读取 Thread 的 Turn
- **AND** 已有 Turn 时 SHALL 按已开始的委派建立委派关系，MUST NOT 再次投递任务或把任务并入用户消息；没有 Turn 时才 SHALL 按排队处理
- **AND** Host Runtime 正常关闭时 SHALL 把已结束的启动结果写入存储

#### Scenario: 队列存储
- **WHEN** 排队记录写入持久存储
- **THEN** 存储 SHALL 仅当前 OS 用户可读写
- **AND** 记录 SHALL 只包含开始委派所需的任务参数、标识与排队时间，并在委派开始后删除
- **AND** 多个 Host Runtime 共用数据目录时，每条记录 SHALL 只由一个 Runtime 开始；已退出 Runtime 的队列 SHALL 只被接管一次

### Requirement: 排队中的 Thread 可观察、可等待、可取消
排队中的 Thread SHALL 使用开始后沿用的同一标识，并接受既有 Thread 命令。`thread read` 与 `thread list` SHALL 显示 `queued` 状态与排队位置；`thread wait` 与 `thread watch` SHALL 等到 Thread 开始后真正停下；`thread cancel` SHALL 将其移出队列且不再开始；`thread send` SHALL 以 `THREAD_BUSY` 拒绝。

#### Scenario: 读取排队中的 Thread
- **WHEN** 调用方 `thread read` 一个排队中的 Thread
- **THEN** 结果 SHALL 为 `status: "queued"`、排队位置与 `pending` 结果，不含 Turn
- **AND** 开始创建后 SHALL 报告 `creating`，之后与普通 Thread 相同

#### Scenario: 列举排队中的 Thread
- **WHEN** 调用方不带 cursor 执行 `thread list`，且有符合 `--parent` 或工作区过滤的排队 Thread
- **THEN** 它们 SHALL 按队列顺序排在第一页最前面，并带排队位置
- **AND** 它们 MUST NOT 占用 `--limit`，也 MUST NOT 出现在续页中

#### Scenario: 等待排队中的 Thread
- **WHEN** 调用方对排队中的 Thread 执行有界 `thread wait`
- **THEN** 排队时间 SHALL 计入期限
- **AND** 期限内开始的 Thread SHALL 在剩余期限内按普通 Thread 等待
- **AND** 到期时仍在排队 SHALL 返回排队快照与 `timedOut: true`

#### Scenario: watch 排队中的 Thread
- **WHEN** 调用方对排队中的 Thread 注册 `thread watch`
- **THEN** watch SHALL 注册为观察中，排队与创建 MUST NOT 被视为停下
- **AND** 排队与创建期间 MUST NOT 计为卡住提醒的静默
- **AND** Thread 开始后停下时 SHALL 按实际终态通知；开始前被移出队列时 SHALL 通知 `interrupted`

#### Scenario: 取消排队中的 Thread
- **WHEN** 调用方对排队中的 Thread 执行 `thread cancel`
- **THEN** Host SHALL 将它移出队列并返回 `cancelled: true`，其后的排队位置依次前移
- **AND** 该 Thread MUST NOT 再开始，之后读取 SHALL 为 `interrupted` 并说明开始前已移出队列
- **AND** 再次取消 SHALL 返回 `cancelled: false`

#### Scenario: 向排队中的 Thread 发送消息
- **WHEN** 调用方对排队中或正在创建的 Thread 执行 `thread send`
- **THEN** 命令 SHALL 以 `THREAD_BUSY` 失败，并在详情中给出状态与排队位置
- **AND** MUST NOT 排队该消息
- **AND** 已移出队列或开始失败的 Thread SHALL 返回 `THREAD_NOT_FOUND`
