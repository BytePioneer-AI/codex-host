# Spec Delta

## Purpose

定义不由 Host 拉起的本机进程如何以外部客户端身份接入 codexhost：登记与吊销、发现与认证、以客户端为来源的委派、停下事件的持久日志与推送，以及通过 MCP 使用同一组委派与 Thread 操作。

## ADDED Requirements

### Requirement: 外部客户端由用户显式登记并可随时吊销
系统 SHALL 提供 `codexhost client add <name>`、`client list` 与 `client remove <name>`。登记 SHALL 生成随机令牌并只在登记时输出一次；系统 MUST NOT 以可还原的形式保存令牌。名称在本机唯一，只允许小写字母、数字和连字符。删除 SHALL 立即吊销：之后携带该令牌的请求 SHALL 被拒绝，已建立的事件推送连接 SHALL 被关闭。

#### Scenario: 登记客户端
- **WHEN** 用户执行 `codexhost client add grok-bot`
- **THEN** CLI SHALL 输出客户端名称与令牌，并提示令牌不会再次显示
- **AND** `client list` SHALL 列出名称与登记时间，MUST NOT 输出令牌

#### Scenario: 名称冲突
- **WHEN** 用户登记一个已存在的名称
- **THEN** CLI SHALL 以 `INVALID_ARGUMENT` 失败，MUST NOT 覆盖原令牌

#### Scenario: 吊销
- **WHEN** 用户执行 `client remove grok-bot` 后，该客户端用原令牌发起请求或保持事件连接
- **THEN** 请求 SHALL 以 `UNAUTHORIZED` 被拒绝
- **AND** 已建立的事件连接 SHALL 被关闭
- **AND** 由该客户端发起的 Thread 与其记录 SHALL 保留，可由其他调用方读取

### Requirement: Runtime 为外部客户端提供固定的本机监听与发现描述
Host Runtime SHALL 在 `127.0.0.1` 的固定端口上提供外部客户端监听，端口可配置，默认 4398。Runtime SHALL 写出仅当前 OS 用户可读的发现描述，包含端点、Runtime 版本与进程标识，MUST NOT 包含任何令牌，并在退出时移除。外部监听 SHALL 只接受客户端令牌，MUST NOT 接受 Host 内部令牌；Host 内部控制端口的行为不变。

#### Scenario: 外部 CLI 连接
- **WHEN** 不在 Host 拉起的进程中执行 CLI，提供了客户端令牌但没有 Host 连接参数
- **THEN** CLI SHALL 通过发现描述或配置的端口连接外部监听
- **AND** 请求 SHALL 以该客户端身份执行

#### Scenario: Runtime 未运行
- **WHEN** 外部客户端连接时 Runtime 未运行或端口未监听
- **THEN** CLI SHALL 以 `RUNTIME_UNREACHABLE` 失败
- **AND** MUST NOT 回退到 PATH 上的其他 codexhost CLI 或随机端口

#### Scenario: 端口被占用
- **WHEN** Runtime 启动时配置的外部端口已被其他进程占用
- **THEN** Runtime SHALL 继续正常服务 Desktop，只停用外部监听
- **AND** SHALL 在诊断与控制台中报告端口冲突及配置方法

#### Scenario: 令牌错误
- **WHEN** 请求缺少客户端令牌、令牌未知或使用了 Host 内部令牌
- **THEN** 外部监听 SHALL 以 `UNAUTHORIZED` 拒绝
- **AND** 响应 MUST NOT 透露哪些客户端名称存在

### Requirement: 外部客户端可以作为委派来源
外部客户端 SHALL 可以调用现有全部委派与 Thread 操作，语义与输出形状与 CLI 一致。客户端未指定父 Thread 发起 `delegate start` 时，Host SHALL 创建以该客户端为来源的 Thread，并持久记录来源；指定父 Thread 时按现有父子血缘处理。以客户端为来源的 Thread SHALL 像其他 Thread 一样出现在 Desktop 侧栏，可由用户打开接管，标题为“子任务名 · 客户端名”。

#### Scenario: 客户端发起无父 Thread 的委派
- **WHEN** 客户端 `grok-bot` 执行 `delegate start --harness codex --cwd <dir> --task <text>` 且未提供 `--parent-thread`
- **THEN** Host SHALL 创建并启动新 Thread，响应中的来源 SHALL 为 `client:grok-bot`
- **AND** MUST NOT 要求当前存在活跃 Turn 来推断调用方

#### Scenario: 客户端发起的 Thread 在侧栏可见
- **WHEN** 客户端发起的 Thread 已创建
- **THEN** 用户 SHALL 能在 Desktop 侧栏看到并打开它：工作目录属于 Desktop 已有项目时在该项目下，否则在“最近”中
- **AND** 打开后 SHALL 可以像普通 Thread 一样继续对话或接管

#### Scenario: 多个 Host 会话时的路由
- **WHEN** Runtime 同时有多个可受理创建的 Host 会话，且请求未指定目标
- **THEN** Host SHALL 路由到本机 Desktop 会话
- **AND** 无法唯一确定时 SHALL 以可辨识的歧义错误失败，MUST NOT 任意选择

### Requirement: 客户端事件以持久日志按游标交付
当 watch 的被通知方是客户端时，被观察 Thread 停下或到期 SHALL 在该客户端的事件日志中追加一条事件，不再启动 Turn。事件 SHALL 包含单调递增的事件标识、时间、Thread 标识、结果、来源 Turn、Harness、深度链接与引用，MUST NOT 包含会话内容。日志 SHALL 持久保存，默认保留 7 天并可配置；游标由客户端持有。

#### Scenario: 客户端注册 watch
- **WHEN** 客户端执行 `thread watch <thread>` 且未提供 `--notify`，或以 `--watch true` 发起委派
- **THEN** 被通知方 SHALL 为该客户端
- **AND** 显式 `--notify client:<name>` SHALL 只允许指向调用方自身

#### Scenario: 事件写入
- **WHEN** 客户端 watch 的被观察 Thread 达到终态
- **THEN** 事件 SHALL 写入该客户端日志并视为已投递
- **AND** 被观察 Thread 与 watch 的其他语义（调整方向、到期、unreadable）SHALL 与 Thread 被通知方一致

#### Scenario: 重启不丢事件
- **WHEN** Runtime 在事件写入后、客户端读取前重启
- **THEN** 客户端恢复连接后 SHALL 能按原游标读到该事件

#### Scenario: 游标已过期
- **WHEN** 客户端请求的游标早于日志中保留的最早事件
- **THEN** 系统 SHALL 以 `CURSOR_EXPIRED` 失败并返回当前最早的事件标识
- **AND** 客户端 SHALL 可以用 `thread list --client <name>` 对账

### Requirement: 事件以 SSE 推送并以 long-poll 补拉
外部监听 SHALL 提供 SSE 事件流和 long-poll 两种读取方式，二者读取同一份日志。SSE SHALL 从 `Last-Event-ID` 或游标之后补发历史事件再推送新事件，并定期发送心跳。long-poll SHALL 在有新事件时立即返回，否则最多等待调用方指定的时间（上限 60 秒）后返回空结果。CLI SHALL 提供 `codexhost events [--after <id>] [--follow]`。

#### Scenario: SSE 断线重连
- **WHEN** 客户端以 `Last-Event-ID: 41` 重新连接 SSE
- **THEN** 系统 SHALL 先补发 41 之后的全部事件，再推送新事件
- **AND** MUST NOT 重复发送 41 及之前的事件

#### Scenario: long-poll 无新事件
- **WHEN** 客户端以 `after=57, timeoutMs=30000` 调用 long-poll 且 30 秒内没有新事件
- **THEN** 系统 SHALL 返回空事件列表与原游标，MUST NOT 报错

#### Scenario: 只读取自己的事件
- **WHEN** 客户端读取事件
- **THEN** 系统 SHALL 只返回该客户端日志中的事件

### Requirement: 委派与 Thread 操作以 MCP 工具提供
外部监听 SHALL 在 `/mcp` 提供 HTTP MCP 服务，以客户端令牌认证。工具 SHALL 覆盖 Harness 列举与检查、委派创建、Thread 读取、有界等待、列举、发送、取消、注册与列出 watch，以及按游标读取事件。工具的参数与结果 SHALL 与对应 CLI 命令的结构化输出一致，错误 SHALL 携带相同的错误代码。

#### Scenario: MCP 客户端派发
- **WHEN** 已配置客户端令牌的 MCP 客户端调用委派创建工具
- **THEN** 结果 SHALL 与该客户端执行 `codexhost delegate start` 的输出一致

#### Scenario: MCP 等待受上限约束
- **WHEN** MCP 客户端调用有界等待并请求超过 60 秒
- **THEN** 系统 SHALL 按 60 秒上限等待，到期时按现有语义报告运行中

#### Scenario: MCP 读取事件
- **WHEN** MCP 客户端以游标调用事件工具
- **THEN** 结果 SHALL 与 long-poll 的结果一致

### Requirement: MCP 客户端可以读取任务最终报告中的文件
系统 SHALL 提供按 Thread 与文件路径读取二进制成品的只读接口，并在已知时返回 Thread 的执行工作目录。文件 MUST 是最新最终报告通过 Markdown 链接引用的普通文件，且实际路径 MUST 位于该 Thread 工作区内。无最终结果、工作目录未知、未引用或越界的路径 SHALL 被拒绝。传输 SHALL 使用现有认证连接，MUST NOT 创建公开下载链接。

#### Scenario: 读取与续读成品
- **WHEN** 客户端读取被最终报告引用的工作区内文件
- **THEN** 系统 SHALL 返回 Base64 字节块、文件名、媒体类型、总字节数、下一偏移和文件版本
- **AND** 每块 MUST NOT 超过 1 MiB；续读 SHALL 校验首块版本，文件变化时拒绝拼接

#### Scenario: 拒绝符号链接逃逸
- **WHEN** 报告引用的工作区内路径经符号链接指向工作区外
- **THEN** 系统 SHALL 拒绝导出文件
