# 外部 Thread 的侧边聊天

Desktop 打开侧边聊天时，先用 `thread/fork` 从主对话 Fork 出子 Thread，再用 `thread/inject_items` 写入一条边界消息：边界之前是继承的主对话历史，只作参考；之后的消息才是有效的用户指令。Desktop 26.1111 起，来源 Thread 为分页历史且账号开启持久侧边聊天时，`thread/fork` 带 `attachToSource`，侧边聊天挂在来源下长期保存；否则带 `ephemeral`，是临时侧边聊天。官方 Codex Thread 由官方 app-server 处理，外部 Thread 由 Host 实现同一协议（`packages/host-runtime/src/external-thread-side-chat.ts`、`external-thread-fork.ts`）。

## 协议

| 请求 | Host 行为 |
| --- | --- |
| `thread/fork` + `attachToSource` | 按原有方式 Fork 来源的 Native Session，并记录 `attachedToThreadId` 和继承的 Turn 数。与官方一致：来源须为分页历史，不能与 `ephemeral` 同时使用。来源本身是临时 Thread 时同样拒绝。与官方一致，挂靠 Fork 不发 `thread/started`，否则 Desktop 会把侧边聊天当普通对话列在侧边栏。 |
| `thread/inject_items` | 只接受纯文本的 user message，文本暂存在 Thread 记录中，由下一个 Turn 带入，最多暂存 64 条，超过时报错并保留原有暂存。其他条目返回 `-32602`，Subagent Thread 返回 `-32076`。 |
| `thread/list` | 带 `attachedToThreadId` 时只返回挂在该 Thread 下的侧边聊天。其他列表不含侧边聊天，带 `includeAttachedThreads` 的搜索除外。`attachedToThreadId` 不能与 `parentThreadId`、`ancestorThreadId` 同时使用。 |
| `thread/read`、`thread/turns/list`、`thread/items/list` | 侧边聊天带 `attachedToThreadId`，只列出自己的 Turn，预览也取自己的第一条用户消息；继承的 Turn 留在 Native Session 中作为上下文。 |
| `thread/rollback` | 侧边聊天只能回退自己的 Turn，会越过继承历史时返回 `-32602`。 |
| `thread/delete` | 与官方一致，来源还有侧边聊天时拒绝删除，Desktop 会先删除侧边聊天。未完成的 Fork 不在列表中，不阻止删除。 |

## 上下文交付

- 外部 Harness 没有写入会话历史的接口。暂存文本放在下一个 Turn 原生输入的开头，与用户消息之间空一行；Harness 接受该 Turn 后才释放，开始失败时保留到下次。释放前核对这些文本仍在暂存开头，否则保留暂存。Harness 命令不是模型 Turn，不带暂存文本。
- 除侧边聊天边界外，Desktop 发送消息前的应用上下文、被动上下文和语音上下文也走 `thread/inject_items`，普通外部 Thread 同样按上述方式交付。
- 暂存写在 Thread 记录中，Host 重启后仍会交付。例外：创建时没有原生 ID 的 Harness，侧边聊天在第一条消息前和新建的对话一样只是未完成的记录，Host 重启时连同暂存一起清理。
- Desktop 只显示用户自己的消息。记录保存已交付前缀的长度和 SHA-256，回放历史时去掉该前缀；对不上时按原文显示。

## 来源运行中

Desktop 打开侧边聊天时不指定边界 Turn：持久侧边聊天带 `attachToSource`，临时侧边聊天带 `ephemeral`。与官方一致，侧边聊天只带已完成的历史，运行中的 Turn 不在其中。

- 来源已有完成的 Turn 时，从最后一个完成的 Turn Fork。
- 来源还没有完成任何 Turn 时，用来源 Harness 新开 Native Session，沿用来源当前的 Model、Thinking 和权限模式，不继承历史。

## 边界

- 其他 Fork 行为不变：边界 Turn 没有 Native Checkpoint 时返回 `-32080`。最后一个完成的 Turn 没有 Native Checkpoint 时，侧边聊天同样返回 `-32080`。
- 新增的记录字段读取失败时按缺省处理，不隔离整个 Thread。旧版 Host 会保留这些字段，但会把侧边聊天显示在普通列表中。
