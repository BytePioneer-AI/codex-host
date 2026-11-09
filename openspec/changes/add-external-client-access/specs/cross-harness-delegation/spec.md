## ADDED Requirements

### Requirement: Thread 可以携带引用并沿委派继承
`codexhost delegate start` SHALL 接受可重复的 `--ref <uri>`，为新 Thread 记录引用，例如 issue 或需求链接。引用 SHALL 是绝对 URI，每个 Thread 最多 16 个，单个不超过 2048 字符。从携带引用的 Thread 发起的委派，子 Thread SHALL 继承父 Thread 的全部引用并追加自身引用，去重后保持顺序。引用 SHALL 随来源记录持久保存，MUST NOT 包含凭据。

#### Scenario: 发起时附带引用
- **WHEN** 调用方执行 `delegate start ... --ref https://github.com/o/r/issues/12`
- **THEN** 响应、`thread read` 与 `thread list` 的结果 SHALL 包含该引用

#### Scenario: 子委派继承引用
- **WHEN** 携带引用 A 的 Thread 以 `--ref B` 再发起委派
- **THEN** 子 Thread 的引用 SHALL 为 A、B

#### Scenario: 引用含凭据
- **WHEN** 引用 URI 中包含用户名口令或令牌形式的用户信息
- **THEN** Host SHALL 去除其中的凭据后保存，或以 `INVALID_ARGUMENT` 拒绝，MUST NOT 原样保存

#### Scenario: 非委派产生的 Thread
- **WHEN** 读取一个不由委派产生的 Thread
- **THEN** 结果 SHALL 不含引用字段，既有输出保持不变

## MODIFIED Requirements

### Requirement: 委派 CLI 的运行时连接与调用方身份由 Host 解析
Host SHALL 向它拉起的 Harness 进程提供配套 CLI 的绝对路径、Runtime 端点与令牌，并 SHALL 通过显式白名单把这些连接参数放行给官方 App Server 进程，此外 MUST NOT 泄漏其他内部环境变量。有 Host 连接参数时，CLI SHALL 只使用它们；没有时，仅在提供了客户端令牌的情况下才连接外部客户端监听。CLI MUST NOT 从 PATH 猜测替代 CLI。调用方身份依次取显式父 Thread、Host Thread 标识、当前活跃 Turn 推断；经外部监听调用时为客户端。

#### Scenario: 外部 Harness 进程中调用
- **WHEN** CLI 在 Host 拉起的外部 Harness 进程中被调用且未提供显式父 Thread 参数
- **THEN** 调用方身份 SHALL 取自被提供的 Host Thread 标识

#### Scenario: 原生 Codex 的工具调用中使用
- **WHEN** CLI 在允许本地 Runtime 连接的原生 Codex 工具调用中被启动且未提供显式父 Thread 参数
- **THEN** Host SHALL 将调用方解析为当前唯一存在活跃 Turn 的原生 Thread
- **AND** 它 SHALL 通过白名单放行的连接参数连接同一 Runtime

#### Scenario: 原生 Codex 默认沙箱阻止本地连接
- **WHEN** 原生 Codex 的当前沙箱阻止工具调用连接 Host 提供的 Runtime 端点
- **THEN** CLI SHALL 以 `RUNTIME_UNREACHABLE` 明确失败
- **AND** 错误 SHALL 指示调用方改用允许本地连接的会话沙箱或由用户显式执行命令
- **AND** MUST NOT 回退到 PATH、另一个 Runtime 或隐式 Host 请求注入

#### Scenario: 调用方身份无法唯一确定
- **WHEN** 多个原生 Thread 同时存在活跃 Turn 且未提供显式父 Thread 参数
- **THEN** 命令 SHALL 以可辨识的歧义错误失败
- **AND** 错误信息 SHALL 指示调用方补充显式父 Thread 参数

#### Scenario: 官方进程环境被检查
- **WHEN** 传递给官方 App Server 的环境被构造
- **THEN** 它 SHALL 仅包含白名单内的 Runtime 连接参数
- **AND** 其余 codexhost 内部环境变量 SHALL 保持被剥离

#### Scenario: 连接参数缺失或不可用
- **WHEN** Host 连接参数与客户端令牌都缺失，或端点无法连接
- **THEN** CLI SHALL 以可辨识的错误失败
- **AND** MUST NOT 回退到 PATH 上的其他 codexhost CLI

#### Scenario: 外部客户端调用
- **WHEN** CLI 不在 Host 拉起的进程中，并提供了客户端令牌
- **THEN** CLI SHALL 连接外部客户端监听，调用方身份 SHALL 为该客户端
- **AND** Host 连接参数同时存在时 SHALL 优先使用 Host 连接参数，保持既有行为

#### Scenario: 帮助文档被请求
- **WHEN** 调用方执行 `codexhost delegate --help`
- **THEN** CLI SHALL 输出随二进制提供的权威文档，列出 `codexhost delegate start` 与 `codexhost thread read|wait|list|send|cancel|watch|watches` 的完整语法
- **AND** SHALL 说明各参数、Thread 标识形式、读取视图、等待、分页、排序、幂等语义、输出字段、错误代码及其处置
- **AND** 该文档 SHALL 与当前 Runtime 版本一致

#### Scenario: 目标 Harness 标识非法
- **WHEN** 调用方提供了未注册的 Harness 标识
- **THEN** CLI SHALL 失败并在错误信息中列出当前合法的 Harness 标识

#### Scenario: 命令输出被模型消费
- **WHEN** 任一委派或 Thread 命令成功或失败返回
- **THEN** 输出 SHALL 默认为结构化机器可读格式
- **AND** 失败输出 SHALL 携带可辨识的错误代码

### Requirement: 委派关系独立持久化且重复请求幂等
Host SHALL 独立于 Thread 记录持久化委派来源：记录 Delegation 关系：Delegation 标识、父来源、子 Thread、父与目标 Harness、状态、可选 Request ID。父来源是父 Thread，或客户端发起时的 `client:<name>`。引用按 Thread 另存。调用方 SHALL 可以省略 Request ID；省略时 Host SHALL 在一个有界时间窗内依据来源（父 Thread 或客户端）与任务文本判定重复。Host MUST NOT 依据委派层级拒绝委派。

#### Scenario: 调用方提供重复的 Request ID
- **WHEN** 调用方以一个已经成功使用过的 Request ID 再次发起委派
- **THEN** Host SHALL 返回原有的子 Thread 标识
- **AND** MUST NOT 创建第二个子 Thread 或第二个会话

#### Scenario: 调用方省略 Request ID 且重复发起
- **WHEN** 同一父 Thread 或同一客户端在有界时间窗内以相同任务文本再次发起同一目标 Harness 的委派
- **THEN** Host SHALL 返回原有的子 Thread 标识
- **AND** MUST NOT 创建第二个子 Thread

#### Scenario: 任务文本不同的连续委派
- **WHEN** 同一父 Thread 以不同任务文本发起多次委派
- **THEN** 每次 SHALL 创建各自独立的子 Thread
- **AND** 去重 MUST NOT 阻止正当的并行委派

#### Scenario: 子 Thread 自身成为委派发起方
- **WHEN** 一个委派产生的子 Thread 发起新的委派
- **THEN** Host SHALL 正常受理并记录一条新的 Delegation 关系
- **AND** 已有关系 MUST NOT 被改写

#### Scenario: Host 重启后恢复关系
- **WHEN** Host 重启后查询某个委派关系或客户端来源
- **THEN** 父子 Thread 标识或客户端名称、Harness、状态与引用 SHALL 被恢复
- **AND** 记录 MUST NOT 包含会话内容

#### Scenario: 回滚到不认识客户端来源的版本
- **WHEN** 用户把 codexhost 回滚到本变更之前的版本
- **THEN** 既有 Delegation 关系 SHALL 仍可被旧版本读取
- **AND** 以 `client:<name>` 为父来源的关系与引用记录 MUST NOT 导致旧版本丢弃或改写 Delegation 关系

### Requirement: Thread 观察与列举命令接受用户提供的标识并覆盖两类 Thread
Thread 观察命令 SHALL 接受裸 Thread 标识与 Codex 深度链接，并可作用于外部 Harness Thread 与原生 Codex Thread，不限于调用方自己委派的 Thread。读取原生 Codex Thread SHALL 经官方 App Server 带外请求，MUST NOT 改变其状态。`thread list [--cwd] [--parent <thread>] [--client <name>] [--ref <uri>] [--limit] [--cursor] [--sort]` SHALL 返回结构化会话页；`--parent` 只列该父 Thread 的子 Thread，`--client` 只列该客户端发起的 Thread，`--ref` 只列携带该引用的 Thread。

#### Scenario: 用户提供深度链接
- **WHEN** 调用方传入 Codex 深度链接形式的 Thread 标识
- **THEN** 命令 SHALL 将其规范化为 Thread 标识后执行
- **AND** 裸标识 SHALL 得到相同结果

#### Scenario: 观察非自身委派的 Thread
- **WHEN** 调用方以用户提供的标识读取或等待一个并非由它委派产生的 Thread
- **THEN** 命令 SHALL 正常执行
- **AND** Host SHALL 视用户显式提供标识为授权

#### Scenario: 观察原生 Codex Thread
- **WHEN** 被观察的 Thread 由原生 Codex Harness 拥有
- **THEN** Host SHALL 通过带外官方请求获取其可见消息与当前结果
- **AND** 结果 SHALL 以与外部 Thread 相同的结构化形状返回
- **AND** 该 Thread 的状态 MUST NOT 被改变

#### Scenario: 列举会话
- **WHEN** 调用方未指定 `--cwd`、`--limit` 或 `--sort`
- **THEN** 列举 SHALL 默认限定在调用方自身的工作目录、默认返回最多 25 条并按 `created-desc` 排序
- **AND** `--limit` SHALL 被限制为最多 100 条
- **AND** 响应 SHALL 包含 `threads` 与可选 `nextCursor`
- **AND** 经外部监听调用且未指定 `--cwd` 时，列举 SHALL 不限定工作目录

#### Scenario: 列举委派血缘
- **WHEN** 调用方执行 `codexhost thread list --parent <thread>`
- **THEN** 结果 SHALL 由 Delegation 关系记录解析
- **AND** MAY 与 `--limit`、`--cursor` 及 `--sort` 组合
- **AND** MUST NOT 依赖会话列表的父子过滤，也 MUST NOT 将委派血缘表述为 Codex Subagent 关系

#### Scenario: 按客户端或引用列举
- **WHEN** 调用方执行 `thread list --client grok-bot` 或 `thread list --ref <uri>`
- **THEN** 结果 SHALL 由来源与引用记录解析，只包含匹配的 Thread
- **AND** MAY 与 `--limit`、`--cursor` 及 `--sort` 组合

#### Scenario: 只读观察
- **WHEN** 调用方执行 `thread read` 或 `thread wait`
- **THEN** 命令 MUST NOT 启动新 Turn、向目标或父 Session 发送输入、唤醒 Agent、中断活跃 Turn、抢占用户输入、消费事件或标记消息已读
- **AND** 相同请求在 Thread 未变化时 SHALL 返回语义相同的结果

### Requirement: 调用方可显式注册一次性 Thread 停下通知
系统 SHALL 提供 `codexhost thread watch <thread> [--notify <thread>] [--timeout-ms <n>]` 与 `codexhost thread watches`。watch 在被观察 Thread 停下或到期时，SHALL 通过与 `thread send` 相同的路径在被通知 Thread 中启动一个新 Turn，作为一次性通知。被观察 Thread 与被通知方可以是任意两个不同的 Thread，不要求委派血缘；被通知方也可以是外部客户端，此时通知写入其事件日志而不启动 Turn。通知 SHALL 只报告执行状态与 Thread 链接，MUST NOT 携带或摘要会话内容，也 MUST NOT 被表述为工作已验收。watch SHALL 持久保存并在 Host Runtime 重启后恢复，不提供取消操作。

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
- **THEN** 被通知方 SHALL 依次取显式 `--notify`、Host 提供的 `CODEXHOST_THREAD_ID`；经外部监听调用时，缺省为调用客户端
- **AND** 都没有时 SHALL 以 `INVALID_ARGUMENT` 失败并要求 `--notify`
- **AND** `--notify client:<name>` SHALL 只允许指向调用客户端自身
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
