# Thread watch：一次性的 Thread 停下通知

`codexhost thread watch` 让一个 Thread 在另一个 Thread **停下（不再运行）时收到一次通知**。调用方注册后立即返回，可以继续工作或结束自己的 Turn，不需要等待或轮询。

它是显式选择的能力：不调用时，`delegate start`、`thread send` 与 Host 的既有行为完全不变——Host 不会因为子任务终态而主动向任何 Thread 提交输入。

## 模型

- 只有两个 Thread：被观察的 Thread 和被通知的 Thread。与委派的父子关系无关，任意两个不同的 Thread 都可以。
- 一次性。被观察 Thread 停下，或 watch 到期，哪个先到就通知一次，随后 watch 消失。换了一个仍在运行的 Turn 不会通知。没有取消或退订；想继续等就再注册一次。同一对被观察 Thread 与被通知 Thread 只保留一个 watch。
- 通知只报告执行状态：Thread 链接和结果。它不读取会话内容、不生成摘要，也不代表工作被验收。接收方应自行 `thread read`。

入口：

| 命令 | 用途 |
| --- | --- |
| `thread watch <thread> [--notify <thread>] [--timeout-ms <n>]` | 观察一个已有 Thread |
| `delegate start ... --watch true` | 创建委派后顺手观察，通知 Host 解析出的发起方 |
| `thread send ... --watch true [--notify <thread>]` | 发送后续消息后，在该 Thread 停下时通知 |
| `thread watches` | 列出尚未送达的 watch |

`delegate start` 和 `thread send` 先完成自己的动作；watch 注册失败不会让命令失败，而是在返回的 `watch` 字段里报告 `notRegistered` 和原因。

## 结果

| 结果 | 含义 |
| --- | --- |
| `completed` / `failed` / `interrupted` | Thread 停下时的终态 |
| `timedOut` | 到期时 Thread 仍未停下；也覆盖 Harness 停止但没有报告的情况 |
| `unreadable` | 连续 60 秒读取失败，状态未知 |
| `notFound` | Thread 已不存在 |

默认超时 29 分钟，略短于被通知 Agent 的 30 分钟 Prompt Cache 寿命，使唤醒仍能命中缓存；`--timeout-ms` 可调整。

注册时 Thread 已是终态则返回 `alreadyTerminal`：不注册、不通知，调用方直接读取即可。

## 送达

- 通知通过普通的 `send` 在被通知 Thread 中启动一个新 Turn，外部 Harness 与原生 Codex 使用同一路径；不做同轮注入。
- 被通知 Thread 正忙时通知保持待送达并重试，最长 6 小时。`THREAD_BUSY` 从不被当作已送达；`thread send` 自身“不排队”的语义不变。
- 同一个被通知 Thread 同时到期的多条通知合并为一条消息，只启动一个 Turn。
- 被通知 Thread 不存在、只读，或超过 6 小时仍无法送达时，watch 标记为 `undeliverable` 并保留原因，可由 `thread watches` 查看。

## 被通知 Thread 的确定

1. 显式 `--notify`；
2. Host 提供给外部 Harness 的 `CODEXHOST_THREAD_ID`；
3. 两者都没有（原生 Codex）时由 Host 推断：除被观察 Thread 外，恰好只有一个 Thread 有活跃 Turn 时，它就是调用方。否则返回 `PARENT_THREAD_AMBIGUOUS`，需要显式 `--notify`。

## 实现与边界

- `packages/host-runtime/src/delegation-watch.ts` 只依赖公开的 `read` 与 `send`，每 2 秒轮询一次（现有 `thread wait` 同样基于轮询）。它不依赖具体 Harness、Desktop、Renderer 或委派血缘。
- 服务由 `DelegationControlRegistry` 持有，位于各 Host 会话之上，因此两端可以属于不同的 Host 会话。
- watch 只存在于 Host Runtime 内存中，Runtime 重启后丢失；委派关系本身仍然持久化，重启后可重新注册。
- 异常退出依赖 Adapter 契约：进程或协议故障时 Adapter 先以失败终结活跃 Turn。`thread read` 在 Harness 已死、无法刷新原生历史时，返回 Host 已投影的终态 Turn，因此这类失败会以 `failed` 被及时通知，而不是等到超时。
