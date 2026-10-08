# Thread watch：一次性的 Thread 停下通知

`codexhost thread watch` 让一个 Thread 在另一个 Thread **停下（不再运行）时收到一次通知**。调用方注册后立即返回，可以继续工作或结束自己的 Turn，不需要等待或轮询。

它是显式选择的能力：不调用时，Host 不会因为子任务终态而主动向任何 Thread 提交输入。同一变更中的忙碌判断修正（见“实现与边界”）不依赖 watch，也作用于普通的 `thread read`、`wait`、`send`。

## 模型

- 只有两个 Thread：被观察的 Thread 和被通知的 Thread。与委派的父子关系无关，任意两个不同的 Thread 都可以。
- 一次性。被观察 Thread 停下，或 watch 到期，哪个先到就通知一次，随后 watch 消失。换了一个仍在运行的 Turn 不会通知。没有取消或退订；想继续等就再注册一次。
- 每次注册各自兑现。同一对 Thread 仍在观察中时重复注册，返回已有的 watch；该 watch 已停下、通知仍在待送达时再次注册（例如 Thread 又开始了新一轮），会新建一个 watch 观察下一次停下，旧通知照常送达，不会被替换或丢弃。
- 通知只报告执行状态：Thread 链接和结果；终态结果注明来自哪个 Turn，以便区分同一 Thread 不同轮次的通知。通知不包含会话正文或摘要，也不代表工作被验收。接收方应自行 `thread read`。

入口：

| 命令 | 用途 |
| --- | --- |
| `thread watch <thread> [--notify <thread>] [--timeout-ms <n>]` | 观察一个已有 Thread |
| `delegate start ... --watch true` | 创建委派后顺手观察，通知 Host 解析出的发起方 |
| `thread watches` | 列出尚未送达的 watch |

`delegate start` 先完成委派；watch 注册失败不会让命令失败，而是在返回的 `watch` 字段里报告 `notRegistered` 和原因。`thread send` 不提供 `--watch`，发送后需要通知时单独执行 `thread watch`。

## 结果

| 结果 | 含义 |
| --- | --- |
| `completed` / `failed` / `interrupted` | Thread 停下时的终态 |
| `timedOut` | 到期时 Thread 仍未停下；也覆盖 Harness 停止但没有报告的情况 |
| `unreadable` | 连续 60 秒读取失败，状态未知 |
| `notFound` | Thread 已不存在 |

默认观察 29 分钟，`--timeout-ms` 可调整；到期报告 `timedOut`，需要继续等待时再注册一次。

注册时 Thread 已是终态则返回 `alreadyTerminal`：不注册、不通知，调用方直接读取即可。

## 送达

- 通知固定通过 `send({ steer: true })` 送达。被通知 Thread 空闲时启动新 Turn；运行中时使用原生 steer，不支持原生插队的外部 Harness 复用 Desktop 的停止后重发操作。
- 正在切换 Turn 等暂时不能接收通知的情况保持待送达并重试，最长 6 小时。`THREAD_BUSY` 从不被当作已送达；普通 `thread send` 自身“不排队”的语义不变。
- 投递失败只有在调用链能证明没有启动 Turn 时才重试：
  - `THREAD_BUSY`（启动前判定），或错误带 `notStarted`（例如原生 Codex 的 resume 校验失败，或 `turn/start` 明确返回错误）：保持待送达并重试；
  - 被通知 Thread 不存在或只读：立即标记 `undeliverable`；
  - 其他失败都视为结果未知，包括 Harness 启动确认超时后包装成的 `DELEGATION_FAILED`：原生可能已经启动了 Turn，为避免重复唤醒不再重试，标记 `undeliverable` 并在原因中说明。
- 每次投递将同一个被通知 Thread 当前所有待送达通知合并为一条消息，包括此前轮询积累的通知，只进行一次送达。
- 被通知 Thread 不存在、只读，或超过 6 小时仍无法送达时，watch 标记为 `undeliverable` 并保留原因，可由 `thread watches` 查看；最多保留最近 50 条无法送达记录。

## 与 Stop 的关系

- 用户 Stop 被观察的 Thread，Thread 停下，watch 以 `interrupted` 通知一次。“调整方向”的停止后重发不算停下，不会通知。
- 用户 Stop 被通知 Thread 的当前 Turn，不会取消已注册的 watch：该 Thread 空闲后，到期的通知仍会启动一个新 Turn。watch 不能取消，这是注册 watch 时就选择的行为。
- 与 `thread send` 的“不排队”约定和 [调整方向](external-thread-steering.md) 的“失败不自动重试或偷偷排队”并不冲突：待送达的通知只存在于显式注册的 watch 中，普通消息的语义不变。

## 被通知 Thread 的确定

身份只确定一次，watch 不做自己的推断：

1. `delegate start --watch`：使用委派已经解析出的父 Thread；没有父 Thread 时报告 `notRegistered`。
2. `thread watch`：显式 `--notify`，否则使用 Host 提供给外部 Harness 的 `CODEXHOST_THREAD_ID`。
3. 两者都没有（原生 Codex）时返回 `INVALID_ARGUMENT`，要求显式 `--notify`。原生 Codex 可使用 `delegate start` 响应中返回的 parent 作为自己的 Thread。

## 实现与边界

- `packages/host-runtime/src/delegation-watch.ts` 只依赖公开的 `read` 与 `send`，每轮完成后间隔 2 秒继续轮询（现有 `thread wait` 同样基于轮询）。它不依赖具体 Harness、Desktop、Renderer 或委派血缘。
- 服务由 `DelegationControlRegistry` 持有，位于各 Host 会话之上，因此两端可以属于不同的 Host 会话。
- watch 只存在于 Host Runtime 内存中，Runtime 重启后丢失；委派关系本身仍然持久化，重启后可重新注册。
- 原生 Codex 的 `thread/read` 只有返回“Thread 不存在”类错误时才报告 `notFound`；其他读取错误按读取失败处理，持续 60 秒才报告 `unreadable`。
- 忙碌判断统一为 `running || 存在待处理的调整方向`。它同时作用于普通 `thread read`/`wait`/`send` 和委派状态，避免停止后重发的空档被读成 `interrupted`。
- 异常退出依赖 Adapter 契约：进程或协议故障时 Adapter 先以失败终结活跃 Turn。`thread read` 在 Harness 已死、无法刷新原生历史时，返回 Host 已投影的终态 Turn，因此这类失败会以 `failed` 被及时通知，而不是等到超时。
