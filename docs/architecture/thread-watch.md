# Thread watch：一次性的 Thread 停下或等待回答通知

`codexhost thread watch` 让一个 Thread 在另一个 Thread **停下（不再运行）或等待回答问题**时收到一次通知。调用方注册后立即返回，可以继续工作或结束自己的 Turn，不需要等待或轮询。

它是显式选择的能力：不调用时，Host 不会因为子任务终态或提问而主动向任何 Thread 提交输入。同一变更中的忙碌判断修正（见“实现与边界”）不依赖 watch，也作用于普通的 `thread read`、`wait`、`send`。

## 模型

- 只有两个 Thread：被观察的 Thread 和被通知的 Thread。与委派的父子关系无关，任意两个不同的 Thread 都可以。
- 一次性。被观察 Thread 停下、出现待回答的问题，或 watch 到期，哪个先到就通知一次，随后 watch 消失。换了一个仍在运行的 Turn 不会通知。没有独立退订命令；主动 `thread cancel` 成功接受取消请求时，会删除被取消 Thread 上的全部 watch（含内存和存盘记录），不再投递其通知。取消失败或返回 `cancelled=false` 时保留 watch；想继续等就再注册一次。
- 每次注册各自兑现。同一对 Thread 仍在观察中时重复注册，返回已有的 watch；该 watch 已停下、通知仍在待送达时再次注册（例如 Thread 又开始了新一轮），会新建一个 watch 观察下一次停下，旧通知照常送达，不会被替换或丢弃。
- 通知只报告执行状态：Thread 链接和结果，不注明 Turn；同一 Thread 不同轮次的结果以 `thread read` 读到的为准。通知不包含会话正文或摘要，也不代表工作被验收。接收方应自行 `thread read`。

## 通知格式

格式由 `packages/shared-contracts/src/thread-watch-notice.ts` 定义，Host 生成、Web 解析都使用它。首行是固定的英文提示 `[codexhost thread watch] Read each Thread's result, then continue your task:`，随后每个 Thread 一行 Markdown 链接：

通知的作用是唤醒被通知 Thread 的 Agent 继续完成原来的任务。结果已写在每行，首行不再复述状态，只要求先读取实际结果、再继续，以免 Agent 仅凭状态汇报完成，或收到通知后停在原地。

```text
- [<会话标题>](thread://<id>): <结果>. <可选说明>
```

- 链接标签使用观察期间读到的 Thread 标题；从未读到标题时使用 Thread ID。生成通知时，首个 ` · ` 后的整个后缀超过 20 个 Unicode 字符则保留前 20 个并加 `…`，短后缀及无分隔符的标题不变。该规则也适用于恢复后待投递的历史 watch，只改变通知字符串，不回写 Thread 标题或 watch 中持久化的完整标题。新委派的标题只有子任务名，见 [委派命名](delegation-titles.md)。Web 通知卡片仍优先显示目录中的当前标题，未载入目录时显示通知标签。
- 说明只在需要时出现：`timedOut` 提示重新注册，`unreadable` 附读取错误，`notFound` 说明 Thread 已不存在，重启导致的 `interrupted` 附重启说明。
- 链接使用 Desktop 原生的会话引用形式 `[标题](thread://<id>)`，Desktop 将其显示为会话引用标签。链接不能带 title 属性（`[标题](thread://<id> "…")`），也不能用普通的 `codex://threads/<id>`，否则 Desktop 用户消息按原文显示。`codexhost thread read` 同样接受该形式。
- 同一份原文给模型阅读，Web 解析后显示为通知卡片（见 [独立 Web](../product/standalone-web.md)）。不符合格式的文字（包括旧格式的历史通知）按普通用户消息显示。

入口：

| 命令 | 用途 |
| --- | --- |
| `thread watch <thread> [--notify <thread>] [--timeout-ms <n>]` | 观察一个已有 Thread |
| `delegate start ... --watch true` | 创建委派后顺手观察，通知 Host 解析出的发起方 |
| `thread send <thread> ... --watch true` | 成功发送新消息后观察，通知解析出的调用方 |
| `thread watches` | 列出尚未送达的 watch |

`thread watches`、HTTP `/v1/thread/watches` 和 MCP `thread_watches` 共用 Host 查询方法，不做字段裁剪。JSON / compact 条目在原有字段外提供 `taskName`（当前标题；无法读取时使用登记或观察时保存的标题）、`threadStatus`（查询时读取的 Thread 当前状态，读取失败时省略）、`watchedForMs`（自登记以来的毫秒数，包含 Host 停机时间，不因重复登记重置）。Thread 当前状态与 watch 的 `state` / 已观察到的 `outcome` 不同：通知待送达时 Thread 可能已启动新 Turn。查询只读取信息，不推进观察或投递；同一被观察 Thread 在一次查询中只读一次。无法读取某个 Thread 不会让其 watch 从列表消失。`--format text` 每个 watch 一行，保留 compact 信息。

watch 首次持久化失败时不保留内存注册，`thread watch` 返回错误，调用方可稍后重试。`delegate start` 与 `thread send --watch true` 都先提交消息；watch 注册失败不会让已经成功的提交变成失败，而是在返回的 `watch` 字段里报告 `notRegistered` 和原因。两者沿用相同的 JSON / compact watch 字段形态；未请求 watch 时不增加字段。`--watch-timeout-ms` 仅能与 `--watch true` 同用，默认 29 分钟。

外部 HTTP `/v1/delegate/start`、`/v1/thread/send` 与 MCP `delegate_start`、`thread_send` 都接受 `watch: true` 和可选正整数 `watchTimeoutMs`，默认同为 29 分钟，返回相同 `watch` 字段。为兼容 CLI 控制协议，仅提供 `watchTimeoutMs` 也会注册 watch；显式 `watch: false` 不能同时提供超时。外部客户端未指定通知 Thread 时以自身事件日志为通知目标。`thread_send` / `/v1/thread/send` 还接受布尔值 `interrupt` 与 `steer`：`interrupt` 先停再发、保留现有 watch，语义与 CLI 一致；`steer` 与 CLI 的 `--steer true` 相同，`steer: true` 与 `interrupt: true` 互斥，同时请求在发送前以 `INVALID_ARGUMENT` 拒绝。

### CLI 长文本输入

`delegate start` 可用 `--task-file <path>` 代替 `--task`；`thread send` 可用 `--message-file <path>` 代替 `--message`。每组参数互斥，即使显式的文本参数为空也不能同时使用。文件路径相对调用方工作目录解析，`-` 表示标准输入。读取 UTF-8 原文，不转义、不展开变量或模板；仅移除一个结尾 LF 或 CRLF，保留其他换行及空白。每份输入在去除结尾换行前最多 262144 字节（256 KiB），空白内容、读取失败或超限均返回 `INVALID_ARGUMENT`，不提交消息。直接连接终端的 stdin 立即拒绝，不等待键盘输入；使用带引号的 heredoc 可避免 shell 展开：

```sh
codexhost delegate start --harness pi --task-file - --watch true <<'EOF'
保留 "引号"、'单引号'、`反引号`、$变量 和换行。
EOF

codexhost thread send <thread> --message-file - --interrupt --watch true <<'EOF'
请调整方向：保留 ${literal}，不要执行 $(shell)。
EOF
```

原有 `--task` / `--message` 的文本处理及默认行为不变。

## 结果

| 结果 | 含义 |
| --- | --- |
| `completed` / `failed` / `interrupted` | Thread 停下时的终态 |
| `needsInput` | Thread 尚非终态且有待回答的问题；通知给出问题请求 ID 与 Turn |
| `timedOut` | 到期时 Thread 仍未停下；也覆盖 Harness 停止但没有报告的情况 |
| `unreadable` | 连续 60 秒读取失败，状态未知 |
| `notFound` | Thread 已不存在 |

默认观察 29 分钟，`--timeout-ms` 可调整；到期报告 `timedOut`，需要继续等待时再注册一次。

注册和轮询都优先判断终态：已是终态时返回 `alreadyTerminal` 或报告终态结果；只有非终态且有待答题时，才返回 `alreadyNeedsInput` 或报告 `needsInput`。`alreadyNeedsInput` 响应带上 `pendingQuestions`；两种即时返回都不注册、不通知。回答问题后可再次注册，等待下一个问题或终态。

问题请求本身来自结构化原生请求，读取与回答方式见[委派问题交互](delegation-questions.md)；题目不改变 Thread 的实际执行状态。异步题可以在 Thread 空闲时仍待答；此时终态优先，调用方应在收到终态通知或 `alreadyTerminal` 后 read，查看并处理仍未答的题目。

## 送达

- 通知通过 `send({ steer: true })` 复用现有送达操作：原生 Codex 使用 `turn/steer`，外部 Harness 使用与 Desktop 相同的 `ExternalTurnSteering`；空闲时开始新 Turn，运行时按原生能力同轮插入或沿既有停止后重发路径。
- 被通知 Thread 暂不能接纳输入时通知保持待送达并重试，最长 6 小时。`THREAD_BUSY` 从不被当作已送达；`thread send` 自身“不排队”的语义不变。
- 投递失败只有在调用链能证明输入未被接受 时才重试：
  - `THREAD_BUSY`（启动前判定），或错误带 `notStarted`（例如原生 Codex 的 resume 校验失败、`turn/start`、`turn/steer` 明确返回错误，或外部 steer 在送达前发现目标 Turn 已结束）：保持待送达并重试；
  - 被通知 Thread 不存在或只读：立即标记 `undeliverable`；
  - 其他失败都视为结果未知，包括 Harness 启动确认超时后包装成的 `DELEGATION_FAILED`：原生可能已经接受了输入，为避免重复唤醒不再重试，标记 `undeliverable` 并在原因中说明。
- 每次投递将同一个被通知 Thread 当前所有待送达通知合并为一条消息，包括此前轮询积累的通知，只提交一次输入。
- 被通知 Thread 不存在、只读，或超过 6 小时仍无法送达时，watch 标记为 `undeliverable` 并保留原因，可由 `thread watches` 查看；最多保留最近 50 条无法送达记录。

## 与 Stop 的关系

- Desktop / Web 的 Stop 被观察的 Thread，Thread 停下，watch 以 `interrupted` 通知一次。“调整方向”的停止后重发不算停下，不会通知。主动 `thread cancel` 则移除被观察 Thread 的 watch；自然完成、失败或 Host 重启等外部中断仍照常通知。
- `thread send --interrupt` 始终采用先停再发，不做原生同轮插入：目标忙时取消当前 Turn，确认 Thread 已停下后只发送一次；目标空闲时直接发送。读取、取消和等待停下合计最多 30 秒，取消拒绝、失败或超时都不发送新消息。它直接使用所属会话的取消接口，不经过会删除 watch 的主动 cancel 入口；从取消到新消息提交结束，暂停该 Thread 的 watch 观察和通知投递，丢弃跨越这段操作的在途观察结果，保留原有注册及期限。成功重发不产生临时 `interrupted` 通知；失败后恢复观察，实际终态仍可通知。已发起的投递不能撤回。与其他提交竞争时仍可能返回 `THREAD_BUSY`，不自动重试或排队。
- 用户 Stop 被通知 Thread 的当前 Turn，不会取消观察其他 Thread 的 watch：该 Thread 空闲后，到期的通知仍会启动一个新 Turn。
- 与 `thread send` 的“不排队”约定和 [调整方向](external-thread-steering.md) 的“失败不自动重试或偷偷排队”并不冲突：待送达的通知只存在于显式注册的 watch 中，普通消息的语义不变。

## 被通知 Thread 的确定

身份只确定一次，watch 不做自己的推断：

1. `delegate start --watch`：使用委派已经解析出的父 Thread；没有父 Thread 时报告 `notRegistered`。
2. `thread send --watch true`：使用 CLI 解析出的调用方，优先 `CODEXHOST_THREAD_ID`，其次原生 Codex 的 `CODEX_THREAD_ID`。没有调用方且未经过外部客户端监听时，消息照常发送，watch 报告 `notRegistered`，不推测目标 Thread 的委派父级。
3. `thread watch`：显式 `--notify`，否则使用 `CODEXHOST_THREAD_ID`，其次 `CODEX_THREAD_ID`；都没有则返回 `INVALID_ARGUMENT`，要求显式 `--notify`。
4. 经外部客户端监听调用时，`thread watch` 未给 `--notify`，或 `thread send --watch true` 没有解析出的调用方，均通知调用客户端自身（`client:<name>`）。此时“投递”是向该客户端的事件日志追加一条事件，不启动 Turn；追加失败在投递期限内重试。见 [外部客户端](external-clients.md)。

## 实现与边界

- `packages/host-runtime/src/delegation-watch.ts` 只依赖公开的 `read` 与 `send`，每轮完成后间隔 2 秒继续轮询（现有 `thread wait` 同样基于轮询）。它不依赖具体 Harness、Desktop、Renderer 或委派血缘；就绪条件为终态或 `pendingQuestions` 非空。
- 服务由 `DelegationControlRegistry` 持有，位于各 Host 会话之上，因此两端可以属于不同的 Host 会话。CLI 与 Runtime 控制接口的 cancel 都经此入口：取消结果未定时暂停该 Thread 的通知投递，接受后删除所有通知目标的 watch，否则恢复投递。异步观察和投递准备在继续时检查 watch 是否仍有效；已经发起的投递无法撤回，仍按原有规则清理。
- watch 持久保存在 `<数据目录>/delegation-watches/`（默认 `~/.codexhost`），每个 watch 一个仅当前用户可读写的记录，只含 Thread 标识、状态、期限与原因。Runtime 重启后恢复观察与投递，调用方无需重新注册；期限按绝对时间计算，停机时间计入。
- 多个 Runtime 进程可共用数据目录（例如 Desktop 与远程监听同时运行）。每个进程只写自己的记录；启动时接管已退出进程（或上次开机遗留）的记录，以原子重命名认领，同一记录只被一个进程接管。
- 恢复后的 watch 最多等待 5 分钟让持有 Thread 的会话重新注册：这期间读取失败不计入 60 秒 `unreadable` 宽限，也不报告 `notFound` 或 `timedOut`；待投递通知要等被通知 Thread 可读后再发送。
- Host Runtime 重启会结束它持有的 Harness 进程，正在运行的 Turn 随之中断。之后读取时它可能显示为已完成（有的 Harness 恢复后还会换一个 Turn 标识），也可能根本无法重新打开。因此，重启前处于观察中的 watch，恢复后第一次成功读取若已是终态，或宽限结束后仍报告 Thread 不存在，都按 `interrupted` 通知并说明原因；原因随记录保存，再次重启也不丢失。代价是：由长期运行的远程监听持有、在停机期间真正完成的 Thread 也会被报告为 `interrupted`；被通知方本来就要先读取 Thread 再行动。
- 发送前先把通知记为“投递中”。Runtime 在发送途中退出时，恢复后再投一次，因此重启可能重复通知，但不会丢失。运行期间“投递结果未知”仍标记为 `undeliverable`，不重试。
- 原生 Codex 的 `thread/read` 只有返回“Thread 不存在”类错误时才报告 `notFound`；其他读取错误按读取失败处理，持续 60 秒才报告 `unreadable`。
- 忙碌判断统一为 `running || 存在待处理的调整方向`。它同时作用于普通 `thread read`/`wait`/`send` 和委派状态，避免停止后重发的空档被读成 `interrupted`。
- 异常退出依赖 Adapter 契约：进程或协议故障时 Adapter 先以失败终结活跃 Turn。`thread read` 在 Harness 已死、无法刷新原生历史时，返回 Host 已投影的终态 Turn，因此这类失败会以 `failed` 被及时通知，而不是等到超时。
