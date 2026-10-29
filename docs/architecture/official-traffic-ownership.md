# 官方流量归属

Host 夹在 Codex Desktop 与官方 app-server 之间。官方协议的方法和参数持续演进，Host 无法枚举，因此采用"默认放行、显式截获"：只处理确认归 codexhost 所有的请求，其余原样转发给官方，由官方自行校验。

## 归属判别

识别只读取以下字段，且识别本身不抛错；读不到或看不懂即视为官方请求：

- `method` 以 `codexhost/` 开头。
- `thread/start.params.model` 是带 `codexhost/` 前缀的文本运输标记（`decodeCreateRoute`）。这是选择外部 Harness 的唯一方式；官方 Model、非文本或缺失的 Model 都属于官方。
- `params.threadId` 指向 Mapping Store 中的外部 Thread（`ExternalThreadRuntime.locate`）。
- `thread/list.params.cursor` 是 Host 合并分页产生的游标（`carriesHostThreadListCursor`）。

只有确认归属后才做严格校验并返回 `-32602` 等错误。带 codexhost 前缀但格式非法的标记或游标直接报错，不回落官方。

## 共同参与的请求

- `thread/list`：Host 能完整解码时合并外部 Thread；解码失败且不带 Host 游标时整条转发官方，此页只显示官方结果。
- `thread/section/move`：Host 维护跨所有者的分区顺序；参数无法解码时，`threadId` 或 `beforeThreadId` 指向外部 Thread 则报错，其他原样转发。
- `thread/archive`、`thread/unarchive`、`thread/delete`、`thread/metadata/update` 及 `turn/*`、`thread/read` 等：先按 `threadId` 判定归属，官方 Thread 原样转发，外部 Thread 才解码参数。
- 其他带外部 `threadId` 的 `thread/*` 请求返回 `-32076`。例外是 `thread/attachment/list`、`thread/queue/list`、`thread/settings/update`：不带 codexhost 渲染扩展的官方客户端（如 SSH 连接的 ChatGPT iOS app）打开 Thread 或发送前都会调用它们，因此按官方结构返回空结果。`thread/settings/update` 只确认、不应用，权限仍由 Harness 自己的权限模式决定。

## 外部 Thread 的归档与永久删除

归档只改变 Host 记录的归档状态，可以取消归档。Desktop 原生「永久删除」通过 `thread/delete` 删除 codexhost 的 Thread 映射、备份与元数据，并关闭已加载的 Harness 连接；不删除 Harness 原生会话或历史，也不向官方 Codex 转发该删除请求。未加载的 Thread 无需启动 Harness 即可删除。此流程不增加 codexhost 弹窗。

已加载的 Thread 在现有生命周期队列内先确认连接关闭、输出消费结束，再删除持久化记录；关闭失败或超时返回错误，保留记录及资源所有权供重试或 Host 退出时清理，不发送删除通知。Mapping Store 先删除主记录、再删除备份、最后删除元数据；主记录删除失败时不触碰辅助文件，辅助文件删除失败时回写主记录，让失败保留的映射及元数据仍能在重启后读取。连接确认关闭后，即使持久化删除失败，Host 也清理该连接遗留的 Desktop 审批与提问。交互清理同时匹配 Thread 实例与交互 ID，不影响其他 Session 使用相同 ID 的请求。持久化删除失败不发送删除通知，已关闭的连接在后续打开时恢复。删除成功后，Host 返回成功并发送 `thread/deleted`，让 Desktop 及共享连接的其他窗口移除会话与缓存。原生会话仍可按导入规则重新导入，但已删除的 Host 元数据不会恢复。

## 已知例外

- Mapping Store 读取失败时，带 `threadId` 的请求返回 `-32081`，不放行官方，避免外部 Thread 请求误发官方。

## 请求必有回应

请求处理意外失败时，若该请求尚未回应、也未交给官方，Host 返回 `-32603`，避免 Codex Desktop 一直等待。处理函数转入后台继续执行的工作同样受此保护；已回应或已转发的请求不会被重复回应。

回归验证位于 `packages/host-runtime/test/app-server-host.official-passthrough.test.ts` 与 `packages/protocol-core/test/model-routing.test.ts`。
