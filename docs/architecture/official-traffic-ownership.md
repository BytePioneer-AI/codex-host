# 官方流量归属

Host 夹在 Codex Desktop 与官方 app-server 之间。官方协议的方法和参数持续演进，Host 无法枚举，因此采用"默认放行、显式截获"：只处理确认归 codexhost 所有的请求，其余原样转发给官方，由官方自行校验。

## 归属判别

识别只读取以下字段，且识别本身不抛错；读不到或看不懂即视为官方请求：

- `method` 以 `codexhost/` 开头。
- `thread/start.params.model` 是带 `codexhost/` 前缀的文本运输标记（`decodeCreateRoute`）。这是选择外部 Harness 的唯一方式；官方 Model、非文本或缺失的 Model 都属于官方。
- `params.threadId` 指向 Mapping Store 中的外部 Thread（`ExternalThreadRuntime.locate`）。
- `thread/list.params.cursor` 是 Host 合并分页产生的游标（`carriesHostThreadListCursor`）。

只有确认归属后才做严格校验并返回 `-32602` 等错误。带 codexhost 前缀但格式非法的标记或游标直接报错，不回落官方。

## Desktop 创建入口

Renderer 请求桥不使用 Host 上最后一次选择覆盖 `thread/start`。普通外部草稿通过当前 `client-new-thread` 身份绑定的原生草稿 setter 携带 transport Model，设置 `modelSettingsPersistAsDefault: false`，不修改官方默认 Model；切回 Codex 时恢复该草稿的原始设置。无法验证草稿 setter 或原生创建接入时，外部草稿不可提交。已有 Thread 继续依据持久化归属，不写入草稿设置。

Desktop 26.1021 的原生预热池按工作目录匹配。每次创建使用独立的消费检查：官方创建不能消费外部预热，外部创建只能消费与本次 transport Model 一致的预热。检查读取本次创建参数，异步准备期间不依赖全局选择。错配的外部预热通过既有未提交预热释放接口清理；普通草稿的配置失效和预热接管规则保持不变。显式任务创建使用独立创建操作跳过普通草稿预热，正文不在创建时执行。

官方定时任务入口没有外部草稿配置，保留原生 Codex Model 和创建路径。官方列表中已有外部任务仍按原 Thread 的持久化 Harness 归属执行。固定聊天任务的接入限制见[外部 Harness 定时任务](../product/harness-schedules.md)。

## 共同参与的请求

- `thread/list`：Host 能完整解码时合并外部 Thread；解码失败且不带 Host 游标时整条转发官方，此页只显示官方结果。
- `thread/section/move`：Host 维护跨所有者的分区顺序；参数无法解码时，`threadId` 或 `beforeThreadId` 指向外部 Thread 则报错，其他原样转发。
- `thread/archive`、`thread/unarchive`、`thread/metadata/update` 及 `turn/*`、`thread/read` 等：先按 `threadId` 判定归属，官方 Thread 原样转发，外部 Thread 才解码参数。
- 其他带外部 `threadId` 的 `thread/*` 请求返回 `-32076`。例外是 `thread/attachment/list`、`thread/queue/list`、`thread/settings/update`：不带 codexhost 渲染扩展的官方客户端（如 SSH 连接的 ChatGPT iOS app）打开 Thread 或发送前都会调用它们，因此按官方结构返回空结果。`thread/settings/update` 只确认、不应用，权限仍由 Harness 自己的权限模式决定。

## 已知例外

- Mapping Store 读取失败时，带 `threadId` 的请求返回 `-32081`，不放行官方，避免外部 Thread 请求误发官方。

## 请求必有回应

请求处理意外失败时，若该请求尚未回应、也未交给官方，Host 返回 `-32603`，避免 Codex Desktop 一直等待。处理函数转入后台继续执行的工作同样受此保护；已回应或已转发的请求不会被重复回应。

回归验证位于 `packages/host-runtime/test/app-server-host.official-passthrough.test.ts` 与 `packages/protocol-core/test/model-routing.test.ts`。
