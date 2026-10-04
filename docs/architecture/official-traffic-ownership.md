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
- `thread/archive`、`thread/unarchive`、`thread/metadata/update` 及 `turn/*`、`thread/read` 等：先按 `threadId` 判定归属，官方 Thread 原样转发，外部 Thread 才解码参数。

## 已知例外

- Mapping Store 读取失败时，带 `threadId` 的请求返回 `-32081`，不放行官方，避免外部 Thread 请求误发官方。
- 原生 `turn/start` / `turn/steer` 中明确携带 codexhost Delegation 引用的文本输入，会在转发前改写为托管 Skill 引用；其他输入及字段不变。
- 用户确认过[本地 Codex 请求档位设置](../product/codex-service-tier.md)后，原生 `turn/start` 会按 Thread 的自定义 Provider 覆写 `serviceTierForTurn`；关闭时仅中和 Composer 自带的档位。此例外不改变请求归属，不严格解码其他官方参数，也不作用于 `openai` Provider、远程 Thread、外部 Harness 或 `turn/steer`。未确认设置、无法确认 Thread Provider，或无需覆写时继续转发原帧；不修改用户认证配置。

## 请求必有回应

请求处理意外失败时，若该请求尚未回应、也未交给官方，Host 返回 `-32603`，避免 Codex Desktop 一直等待。处理函数转入后台继续执行的工作同样受此保护；已回应或已转发的请求不会被重复回应。

回归验证位于 `packages/host-runtime/test/app-server-host.official-passthrough.test.ts` 与 `packages/protocol-core/test/model-routing.test.ts`。
