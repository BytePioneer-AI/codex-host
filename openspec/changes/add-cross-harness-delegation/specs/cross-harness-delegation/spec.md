## ADDED Requirements

### Requirement: 委派能力通过两处内容一致的薄 Agent Skill 发现
codexhost SHALL 从同一权威模板向 `~/.agents/skills/codexhost-delegation/SKILL.md` 与 `~/.claude/skills/codexhost-delegation/SKILL.md` 安装内容完全一致的用户级 Skill。Skill SHALL 仅服务发起方发现委派能力，并 SHALL 指示 Agent 在执行前运行 `codexhost delegate --help` 获取当前版本的权威用法。Host MUST NOT 为委派发现而扫描或改写用户 Turn、追加提示文本，或重写原生 Codex 请求。

#### Scenario: 首次安装 Skill
- **WHEN** codexhost 首次执行 Skill 安装且两个目标均不存在
- **THEN** 安装器 SHALL 向 `~/.agents/skills/codexhost-delegation/SKILL.md` 与 `~/.claude/skills/codexhost-delegation/SKILL.md` 写入同一内置模板
- **AND** 两份文件 SHALL 声明相同版本并具有相同内容摘要
- **AND** 每个目标 SHALL 通过同目录 staging 文件与原子替换完成写入

#### Scenario: 受管 Skill 缺失或版本落后
- **WHEN** codexhost 安装或更新后检查两处 Skill，且任一受管副本缺失、版本低于当前内置版本或摘要对应旧的受管内容
- **THEN** 安装器 SHALL 将该副本原子更新为当前内置模板
- **AND** 更新后两处受管副本 SHALL 内容一致

#### Scenario: Skill 已是当前版本
- **WHEN** 两处 Skill 的受管版本与内容摘要均匹配当前内置模板
- **THEN** 安装器 SHALL 保持文件不变
- **AND** MUST NOT 产生无意义的重写

#### Scenario: 目标 Skill 被用户修改或不是受管文件
- **WHEN** 目标路径已存在，但其摘要不匹配当前或上一受管版本的记录
- **THEN** 安装器 SHALL 保留该文件并报告可辨识的冲突
- **AND** MUST NOT 静默覆盖用户修改或非受管内容
- **AND** 另一处无冲突的受管副本 MAY 独立完成安装或更新

#### Scenario: Skill 内容边界
- **WHEN** Agent 读取任一目录中的 `codexhost-delegation` Skill
- **THEN** Skill SHALL 说明明确委派请求或有效 `@<harnessId>` 可通过 codexhost 创建目标 Harness 的独立会话
- **AND** SHALL 要求执行前先运行 `codexhost delegate --help`
- **AND** SHALL 指示 Agent 不要凭记忆猜测命令、参数、标识、等待或结果回流行为
- **AND** SHALL 指示 Agent 在用户只是在讨论 Harness 时忽略该能力
- **AND** MUST NOT 复制完整 CLI 命令文档、动态 Thread 标识或结果回流规则

#### Scenario: 任意 Harness 的用户 Turn 被提交
- **WHEN** 用户向外部 Harness 或原生 Codex Thread 提交 Turn
- **THEN** Host SHALL 将用户输入按该 Harness 的既有语义处理
- **AND** MUST NOT 为委派发现追加隐藏或可见提示
- **AND** 原生 Codex 请求的字段与转发语义 SHALL 保持不变

#### Scenario: Host 向被委派方投递任务
- **WHEN** Host 为目标 Harness 创建 Session/Thread 并投递任务 Turn
- **THEN** 目标执行 MUST NOT 依赖目标 Harness 已安装、加载或理解 `codexhost-delegation` Skill
- **AND** 即使任务文本含有 `@<harnessId>`，Host 也 MUST NOT 自动触发再次委派

#### Scenario: 用户在子 Thread 中明确发起新的委派
- **WHEN** 用户在一个委派产生的子 Thread 中明确请求新的委派，且当前 Agent 通过 Skill 调用 CLI
- **THEN** Host SHALL 按普通委派处理该请求
- **AND** MUST NOT 因为该 Thread 自身由委派产生而拒绝

### Requirement: 委派创建归属目标 Harness 的独立可写子 Thread
委派 SHALL 创建一个归属目标 Harness、可继续交互的子 Thread，并使其出现在 Codex Desktop 会话列表中。父子双方的会话身份 MUST NOT 被共享或迁移，每个 Thread SHALL 只归属一个 Harness。

#### Scenario: 委派给外部 Harness
- **WHEN** 调用方发起一次委派且目标为可用的外部 Harness
- **THEN** Host SHALL 为目标 Harness 建立独立的 Native Session 与一个普通可写 Host Thread
- **AND** SHALL 在无 Desktop 请求上下文的情况下主动发布该子 Host Thread 为已开始
- **AND** 调用方 SHALL 收到该子 Thread 的标识与其深度链接

#### Scenario: 委派给原生 Codex
- **WHEN** 调用方发起一次委派且目标为原生 Codex Harness
- **THEN** Host SHALL 通过对官方 App Server 的带外请求创建一个原生 Codex Thread 并投递任务
- **AND** 带外请求与其响应 MUST NOT 作为 Desktop 发起的请求被回送给 Desktop
- **AND** Host SHALL 跟踪该 Thread 的官方通知以便后续提取结果
- **AND** 该 Thread SHALL 按官方既有语义出现在聚合会话列表中

#### Scenario: 用户在子 Thread 中继续交互
- **WHEN** 用户打开投影出来的子 Thread 并提交输入
- **THEN** 该 Thread SHALL 接受输入并按其所属 Harness 的普通 Thread 语义执行
- **AND** 它 MUST NOT 被当作只读的 Subagent 子 Thread

#### Scenario: 子 Thread 参与列表过滤
- **WHEN** 会话列表按当前受支持的过滤条件枚举记录
- **THEN** 委派子 Thread SHALL 作为普通行参与匹配
- **AND** 它 MUST NOT 因为存在父子关系而被排除出列表

#### Scenario: 目标启动失败
- **WHEN** 目标 Harness 的会话无法建立
- **THEN** 委派 SHALL 失败并返回可辨识的错误原因
- **AND** Host MUST NOT 留下已发布或半持久化的子 Thread

### Requirement: 委派关系独立持久化且重复请求幂等
Host SHALL 独立于 Thread 记录持久化 Delegation 关系，包含 Delegation 标识、父子 Thread 标识、父与目标 Harness、状态与可选 Request ID。调用方 SHALL 可以省略 Request ID；省略时 Host SHALL 在一个有界时间窗内依据父 Thread 与任务文本判定重复。Host MUST NOT 依据委派层级拒绝委派。

#### Scenario: 调用方提供重复的 Request ID
- **WHEN** 调用方以一个已经成功使用过的 Request ID 再次发起委派
- **THEN** Host SHALL 返回原有的子 Thread 标识
- **AND** MUST NOT 创建第二个子 Thread 或第二个会话

#### Scenario: 调用方省略 Request ID 且重复发起
- **WHEN** 同一父 Thread 在有界时间窗内以相同任务文本再次发起同一目标 Harness 的委派
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
- **WHEN** Host 重启后查询某个委派关系
- **THEN** 父子 Thread 标识、Harness 与状态 SHALL 被恢复
- **AND** 关系记录 MUST NOT 包含会话内容

### Requirement: 委派 CLI 的运行时连接与调用方身份由 Host 解析
Host SHALL 向它拉起的 Harness 进程提供配套 CLI 的绝对路径、Runtime 端点与令牌，并 SHALL 通过显式白名单将这些连接参数放行给官方 App Server 进程。除该白名单外，Host MUST NOT 向官方 App Server 泄漏其他内部环境变量。CLI SHALL 仅使用被提供的连接参数，MUST NOT 自行发现 Runtime、在多个 Runtime 之间选择，或从 PATH 猜测替代 CLI。调用方身份 SHALL 优先取自显式父 Thread 参数，其次取自被提供的 Host Thread 标识，再次由 Host 依据当前活跃 Turn 推断。

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
- **WHEN** Runtime 端点缺失或无法连接
- **THEN** CLI SHALL 以可辨识的错误失败
- **AND** MUST NOT 回退到 PATH 上的其他 codexhost CLI

#### Scenario: 帮助文档被请求
- **WHEN** 调用方执行 `codexhost delegate --help`
- **THEN** CLI SHALL 输出随二进制提供的权威文档，列出 `codexhost delegate start` 与 `codexhost thread read|wait|list` 的完整语法
- **AND** SHALL 说明各参数、Thread 标识形式、读取视图、等待、分页、排序、幂等语义、输出字段、错误代码及其处置
- **AND** 该文档 SHALL 与当前 Runtime 版本一致

#### Scenario: 目标 Harness 标识非法
- **WHEN** 调用方提供了未注册的 Harness 标识
- **THEN** CLI SHALL 失败并在错误信息中列出当前合法的 Harness 标识

#### Scenario: 命令输出被模型消费
- **WHEN** 任一委派或 Thread 命令成功或失败返回
- **THEN** 输出 SHALL 默认为结构化机器可读格式
- **AND** 失败输出 SHALL 携带可辨识的错误代码

### Requirement: 委派创建与结果观察解耦且不主动注入父 Session
`codexhost delegate start --harness <harnessId> --task <text> [--parent-thread <thread>] [--request-id <id>]` SHALL 在创建目标 Session/Thread 并投递任务后立即返回。`--harness` 与 `--task` SHALL 为必填参数；`--parent-thread` SHALL 显式覆盖 Host 推断的调用方 Thread；`--request-id` SHALL 承载调用方提供的幂等标识。发起方 Agent SHALL 可以自主选择通过 `thread read` 读取、通过有界 `thread wait` 等待、稍后再次观察，或不再跟踪。Host MUST NOT 在子任务完成后向父 Session 注入结果、唤醒父 Agent 或为此创建自主 Turn。

#### Scenario: 委派创建成功返回
- **WHEN** 调用方执行有效的 `codexhost delegate start --harness <harnessId> --task <text>`
- **THEN** CLI SHALL 返回包含 `delegationId`、`threadId`、`harnessId`、`deepLink` 与当前 `status` 的 JSON 对象
- **AND** MUST NOT 等待被委派工作完成
- **AND** SHALL 在响应中给出可用于 `thread read` 与 `thread wait` 的下一步命令提示

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
- **WHEN** 发起方在创建后不调用 `thread wait`，或结束当前 Turn
- **THEN** 被委派工作 SHALL 独立继续执行
- **AND** Host MUST NOT 为发起方建立完成通知、输入注入或续写义务
- **AND** 子 Thread SHALL 继续可由用户或后续 Agent 调用通过标识读取

#### Scenario: 子任务完成
- **WHEN** 被委派的子 Thread 达到完成、失败或取消终态
- **THEN** Host SHALL 更新该子 Thread 与 Delegation 关系的状态，并保留可读取的结构化结果
- **AND** MUST NOT 因该终态向父 Session 提交新的输入

#### Scenario: 结果被结构化描述
- **WHEN** 委派结果通过 `thread read` 或 `thread wait` 返回
- **THEN** 它 SHALL 包含子 Thread 标识、当前状态，以及由 `availability` 和可选 `text` 构成的结果判定
- **AND** `availability` SHALL 为 `pending`、`available` 或 `unavailable`
- **AND** 它 MUST NOT 仅以自由文本表述成败

### Requirement: `thread read` 返回精简的可见对话结果而非执行轨迹
`codexhost thread read <thread> [--view result|messages] [--cursor <cursor>] [--limit <n>]` SHALL 立即读取指定 Thread 当前已由 Host 投影的可见对话结果。`<thread>` SHALL 接受裸 Thread 标识或 `codex://threads/<id>` 深度链接。`--view` 默认 SHALL 为 `result`；`--view messages` SHALL 附带有界的用户与 Agent 可见消息。首版 `thread read` MUST NOT 返回工具调用、工具参数、工具输出、文件变更、reasoning summary、隐藏推理或 Harness 私有 Transcript。

#### Scenario: 默认读取已完成 Thread
- **WHEN** 调用方执行 `codexhost thread read <thread>` 且最近 Turn 已完成并存在最终 Agent 消息
- **THEN** CLI SHALL 返回 `threadId`、`harnessId`、`status`、最近 Turn 的 `turnId` 与 `status`、`result` 和 `nextCursor`
- **AND** `result.availability` SHALL 为 `available`
- **AND** `result.text` SHALL 为最近已完成 Turn 的最终 Agent 消息
- **AND** 响应 MUST NOT 重复返回该 Turn 的用户输入或中间执行轨迹

#### Scenario: 默认读取正在运行的 Thread
- **WHEN** 调用方执行 `codexhost thread read <thread>` 且存在活跃 Turn
- **THEN** CLI SHALL 立即返回 `status: "running"`、活跃 Turn 的标识与状态、截至读取时最新的 Agent 可见进度消息、`result.availability: "pending"` 和 `nextCursor`
- **AND** 没有 Agent 可见进度消息时 SHALL 返回空的 `progress` 数组
- **AND** 读取 MUST NOT 等待 Turn 完成

#### Scenario: 消息视图读取多轮对话
- **WHEN** 调用方执行 `codexhost thread read <thread> --view messages`
- **THEN** CLI SHALL 在默认结果字段之外返回按发生顺序排列的 `messages`
- **AND** 每条消息 SHALL 包含稳定消息标识、所属 `turnId`、`role` 与文本
- **AND** Agent 消息在 Harness 已投影阶段信息时 MAY 包含 `phase: "commentary"` 或 `phase: "final"`
- **AND** `messages` SHALL 只包含用户可见输入、Agent 可见中间消息和 Agent 最终消息

#### Scenario: 读取增量消息
- **WHEN** 调用方使用前一次响应的 `nextCursor` 再次执行 `thread read --view messages --cursor <cursor>`
- **THEN** CLI SHALL 只返回该游标之后新增的可见消息
- **AND** 读取 SHALL 是非消费性的，相同游标重试 MUST NOT 标记消息已读或删除消息
- **AND** 新响应 SHALL 返回新的 `nextCursor`

#### Scenario: 消息分页受限
- **WHEN** `--view messages` 的可见消息数量超过 `--limit <n>` 或默认条数上限
- **THEN** CLI SHALL 只返回该页消息并返回继续读取所需的 `nextCursor`
- **AND** `--limit` SHALL 只限制 `messages` 数量，不得改变 Thread、Turn 或 `result` 字段

#### Scenario: 已终止但没有可用结果
- **WHEN** Thread 已失败、取消或完成但没有最终 Agent 消息
- **THEN** `result.availability` SHALL 为 `unavailable`
- **AND** 响应 MAY 包含已投影的失败或取消说明
- **AND** MUST NOT 从工具输出或私有 Transcript 推导一个伪造的最终结果

#### Scenario: 读取不支持的视图
- **WHEN** 调用方传入 `--view result|messages` 以外的值
- **THEN** 命令 SHALL 以可辨识的参数错误失败
- **AND** MUST NOT 将 `activity`、`raw` 或 `full-transcript` 作为首版读取视图

### Requirement: `thread wait` 有界等待并复用 `thread read` 的结果形状
`codexhost thread wait <thread> [--timeout-ms <n>] [--view result|messages] [--cursor <cursor>] [--limit <n>]` SHALL 有界等待指定 Thread 达到终态或等待期限到期。等待结束后 SHALL 返回与相同读取参数下 `thread read` 一致的快照字段，并额外返回 `timedOut`。`--view` 默认 SHALL 为 `result`；`--cursor` 与 `--limit` SHALL 仅在 `--view messages` 时控制消息增量与页大小。

#### Scenario: 等待已终止 Thread
- **WHEN** 调用方等待一个已处于终态的 Thread
- **THEN** CLI SHALL 不作额外等待并返回 `timedOut: false`
- **AND** SHALL 返回当前 `result` 与可选 `messages`

#### Scenario: 等待期间 Thread 完成
- **WHEN** Thread 在 `--timeout-ms` 指定的期限内达到终态
- **THEN** CLI SHALL 返回 `timedOut: false` 与终态快照
- **AND** 若最终 Agent 消息可用，`result.availability` SHALL 为 `available`

#### Scenario: 等待到期但 Thread 仍在运行
- **WHEN** Thread 在等待期限到期时仍有活跃 Turn
- **THEN** CLI SHALL 以成功退出返回 `timedOut: true`、`status: "running"` 和 `result.availability: "pending"`
- **AND** 被观察的 Thread SHALL 继续执行

#### Scenario: 等待参数非法
- **WHEN** `--timeout-ms` 不是正整数，或 `--cursor`、`--limit` 与所选读取视图不兼容
- **THEN** 命令 SHALL 以可辨识的参数错误失败
- **AND** MUST NOT 启动无界等待

### Requirement: Thread 观察与列举命令接受用户提供的标识并覆盖两类 Thread
Thread 观察命令 SHALL 接受裸 Thread 标识与 Codex 深度链接两种形式，并可作用于外部 Harness Thread 与原生 Codex Thread，不限于调用方自己委派产生的 Thread。对原生 Codex Thread 的读取与等待 SHALL 通过对官方 App Server 的带外请求实现，且 MUST NOT 改变该 Thread 的状态。`codexhost thread list [--cwd <path>] [--parent <thread>] [--limit <n>] [--cursor <cursor>] [--sort created-asc|created-desc|updated-asc|updated-desc|recency-asc|recency-desc]` SHALL 返回结构化会话页；`--parent` SHALL 只列举该父 Thread 的 Delegation 子 Thread。

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

#### Scenario: 列举委派血缘
- **WHEN** 调用方执行 `codexhost thread list --parent <thread>`
- **THEN** 结果 SHALL 由 Delegation 关系记录解析
- **AND** MAY 与 `--limit`、`--cursor` 及 `--sort` 组合
- **AND** MUST NOT 依赖会话列表的父子过滤，也 MUST NOT 将委派血缘表述为 Codex Subagent 关系

#### Scenario: 只读观察
- **WHEN** 调用方执行 `thread read` 或 `thread wait`
- **THEN** 命令 MUST NOT 启动新 Turn、向目标或父 Session 发送输入、唤醒 Agent、中断活跃 Turn、抢占用户输入、消费事件或标记消息已读
- **AND** 相同请求在 Thread 未变化时 SHALL 返回语义相同的结果
