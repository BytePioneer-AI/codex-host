# 外部 Thread 跟进消息队列

Desktop 在 Turn 运行中提交的跟进消息，经官方 app-server 的 `thread/queue/*` 协议排队。Desktop 26.1027 起该队列由主进程管理，对所有非 ephemeral Thread 启用，Renderer 无法再把外部 Thread 切回本地队列。外部 Thread 的队列因此由 Host 原生实现（`packages/host-runtime/src/external-thread-queue.ts`），请求不转发官方 app-server。

## 协议

| 方法 | Host 行为 |
| --- | --- |
| `thread/queue/add` | 追加 `{ id, input, clientUserMessageId }`；`input` 必须含文本 |
| `thread/queue/list` | 按顺序分页返回；`cursor` 为不透明偏移 |
| `thread/queue/update` | 替换指定提交的 `input` |
| `thread/queue/delete` | 返回 `{ deleted }` |
| `thread/queue/reorder` | 列出的 ID 按给定顺序移到前面，其余保持原顺序 |
| `thread/queue/start` | 取出指定提交（缺省为首项）开始新 Turn，返回 `{ turn }`；Thread 忙时返回 `-32072` |

每次变更都发出 `thread/queue/changed { threadId }`。Desktop 本地不保存队列，收到通知后重新 list。

## 执行语义

- Turn 正常完成（`completed`）后，Host 自动开始队首提交，对应官方服务端队列的自动推进。
- Turn 被中断或失败时不自动推进；Desktop 显示“队列已暂停”，用户点击“继续”时发送 `thread/queue/start`。
- 运行中点击“引导”时，Desktop 先发 `turn/steer`，再 `thread/queue/delete`；投递方式由外部 steering 决定，见 `external-thread-steering.md`。
- 开始失败时，提交放回原位置并再次发出 `thread/queue/changed`。
- Desktop 只为自己 `turn/start` 的输入做本地乐观展示。由队列开始的 Turn 由 Host 投影带 `clientId` 的 userMessage，否则该轮用户消息不显示。

## 边界

- 队列只存在于 Host 进程内存，Host 重启后丢失；Harness Session 不持有排队输入。
- 只接受文本输入，与外部 `turn/start` 一致。
- 删除外部 Thread 时同时清除其队列。
