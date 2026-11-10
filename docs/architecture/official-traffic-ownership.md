# 官方流量归属

Host 夹在 Codex Desktop 与官方 app-server 之间。官方协议的方法和参数持续演进，Host 无法枚举，因此采用"默认放行、显式截获"：只处理确认归 codexhost 所有的请求。除下述原生 Fork 的模型继承外，其余原样转发给官方，由官方自行校验。

## 归属判别

识别只读取以下字段，且识别本身不抛错；读不到或看不懂即视为官方请求：

- `method` 以 `codexhost/` 开头。
- `thread/start.params.model` 是带 `codexhost/` 前缀的文本运输标记（`decodeCreateRoute`）。这是选择外部 Harness 的唯一方式；官方 Model、非文本或缺失的 Model 都属于官方。
- `params.threadId` 指向 Mapping Store 中的外部 Thread（`ExternalThreadRuntime.locate`）。
- `thread/list.params.cursor` 是 Host 合并分页产生的游标（`carriesHostThreadListCursor`）。

只有确认归属后才做严格校验并返回 `-32602` 等错误。带 codexhost 前缀但格式非法的标记或游标直接报错，不回落官方。

## 原生 Codex Fork 的模型继承

Desktop 可能在 `thread/fork` 中省略 Model，原生 app-server 因此使用全局默认配置，而不是来源 Thread 的配置。共享原生通道对 Desktop 与 Web 一致补齐省略的 Model、Provider、Thinking 和 Fast：来源只取当前原生进程通过 `thread/start`、`thread/resume`、`thread/fork` 响应或 `thread/settings/updated` 确认的设置，不读取 Host 的最后一次草稿选择，也不复制权限、指令或其他配置。

显式指定 Model 或 Provider（包括 `config.model`、`config.model_provider`）时整条请求保持原样，避免为另一个 Model 注入不适用的 Thinking。只覆盖 Thinking 或 Fast 时保留该覆盖；`model: null` / `modelProvider: null` 仍表示省略。带 `path` 或 `history` 的 Fork、未知来源和无法识别的配置形状保持原生行为。`cwd`、精确轮次边界和未来协议字段均保留；继承的是来源 Thread 当前已确认的设置，不反推历史轮次当时的 Model。

确认的设置只存在于当前原生进程的内存中，关闭、归档、取消订阅或删除 Thread 时清除，进程换代后也不沿用。已有客户端订阅在换代后的首次 Fork 前按既有恢复参数重新 `thread/resume`，以新响应确认设置；没有订阅或确认时仍直接交给原生处理。Fork 的身份、历史、执行和最终配置继续以官方响应为准，不创建外部映射，也不自动重试失败的请求。

## Desktop 创建入口

Renderer 请求桥不使用 Host 上最后一次选择覆盖 `thread/start`。普通外部草稿通过当前 `client-new-thread` 身份绑定的原生草稿 setter 携带 transport Model，同时携带与该 setter 关联的当前 `usesAccountPreferences` 模式，设置 `modelSettingsPersistAsDefault: false`，不修改官方默认 Model；切回 Codex 时恢复该草稿的原始设置。无法验证草稿 setter、当前账号设置模式或原生创建接入时，外部草稿不可提交。同一草稿可以对应多个 Hook setter，绑定按每个 setter 的草稿身份及 Model 上下文验证，不要求整个 Composer 只有一个 setter。已有 Thread 继续依据持久化归属，不写入草稿设置。

选择策略先登记当前草稿的选择，再写入草稿模型；原生存储在写入时同步渲染新创建模式，也能读到本次选择。策略拒绝时不写草稿；草稿 setter 拒绝写入时（包括已执行 updater 后才拒绝提交），把该草稿的选择恢复为写入前草稿实际携带的 carrier（原本没有外部 carrier 时清除），不改动其他草稿。writer 只在 setter 正常返回后才记录新 carrier；updater 延迟执行时，连续外部选择共享首次写入前的原生设置，切回 Codex 或卸载时排队恢复该设置。

Desktop 26.1027 的主进程 Manager 通过 Renderer app scope 中按 Host 发布的 RPC 连接发现。混合布局逐 Host 优先使用可用的 Renderer Manager，其余 Host 继续使用当前 `ready` 的 RPC client；一个 Host 就绪不会销毁其他 Host 的 RPC 路由或草稿绑定。RPC family 在同一 store 的绑定有效期间复用，client 在每次读取时解析。原生 Manager 消失后也可回到仍有效的 RPC peer。没有可用连接时仍保持不可用，不以挂载注册表或信号目录键本身作为就绪依据；Desktop 内置的 `durable` 长连接 Host 不作为外部 Harness 路由或已发现 Host。Remote Control 的连接代次为 `null`（断开、连接中、歧义或读取失败）时，两条路径都不可用，也不列入已连接 Host；没有代次信号的旧布局以 `undefined` 保留 RPC 兼容。

RPC 路由的原生 owner 发现由 Composer 身份读取（`hostIdForComposer`、`forComposer`）和 Host 集合协调（`knownHostIds`）承接，复用这些读取已有的发现结果；指定 Composer 时只检查该 Composer。普通 `forHost` 查询和 RPC 发送不会为寻找尚未出现的原生 Manager 扫描整个文档。Renderer 的 Composer 协调及 Controller 的既有安装检查会发现晚挂载的 owner，包括同一 editor 上新出现的 owner；仅持有 Host ID 的调用方在此之前继续使用有效 RPC，不主动触发 native 发现。发现原生 owner 后，原生 router 仍实时解析 registry 成员、Manager 和连接代次；这里不缓存 `null`、不缓存 registry 的连接结果，也不增加轮询或 React commit 钩子。

RPC 布局下的 Windows Remote Control 复用已加载模块中的原生 Manager 工厂、RPC 会话与界面控制器。Controller 通过结构契约及工厂调用关系发现引用，不依赖混淆符号名，不复制 Desktop 实现，不修改签名应用。作用域和服务必须具有已验证的自身属性，不能把可动态生成任意成员的 RPC Proxy 当作作用域。引用仅用于当前 Renderer 文档，发现结束释放 CDP 对象组。相同模块目录和本地 RPC owner 下最多探测三次，前两次失败分别冷却 5 秒和 10 秒；已有发现或安装中的尝试去重，耗尽后保持稳定的 `unavailable`，不随 Controller 的 500ms 检查反复扫描。模块目录、CDP catalog owner 或本地 RPC owner 变化会重置预算；旧尝试的延迟结果不能覆盖新尝试。

界面控制器的服务入口为 Windows Remote Control 提供独立原生 Manager，其余 Host 委托官方服务。仅改写公开连接信号不能接入界面的历史订阅、审批和重放协调，因此使用原生控制器维护这些关系。每次物理连接世代变化或订阅租约释放都淘汰旧 Manager 和桥接，延迟平台探测不得发布到新连接。控制帧直接使用保留的上游 RPC，避免与等待控制帧响应的逻辑请求争用同一队列；清理完成后才释放上游句柄。

主进程消费的原生审批、提问及 MCP elicitation 不会作为普通窗口请求广播。适配器订阅这些原生交互事件，按事件中的 Thread 从原生会话读取待处理请求，并通过原生 Manager 展示和回应；安装或重连时读取一次未完成工作的快照以恢复已有交互，不轮询。请求按 Thread 与原生 request ID 去重，读取期间发生的新交互或解决事件会触发一次新快照，旧快照不能重新显示已解决的审批。交互订阅成功后才发布新路由；订阅失败时释放候选 Manager，保留官方服务。

该版本的官方模型目录可能过滤草稿中的外部 transport Model。RPC 路由依据已登记的 `clientThreadId`，在本次 `startConversation` 发出时把官方回退模型替换为外部 carrier（创建参数没有 Model 时同样写入 carrier），保留输入、工作区、Thinking、原生回调及传输参数；不修改原始模式对象。不属于已登记草稿的创建、无法识别的参数和明确指定另一个外部 carrier 的创建保持原样。可识别的外部预热请求一律带上预热标记：请求本身指定了外部 carrier 时保留其 Harness 与 Model，否则使用当前已选择的 carrier；Host 据此把它登记为可丢弃的预热，而不是发布新 Thread。没有外部选择的官方预热及无法识别的 carrier 保持原样。

普通草稿的 transport Model 同时按本地 Host 连接和 `client-new-thread` 身份登记。原生 `startConversation` 进入时读取本次创建的 `clientThreadId`，在异步准备前捕获对应的路由，只替换这次创建的 Model，保留权限、工作区、输入、Thinking 和原生回调。后台发送派生新客户端身份时，通过同一草稿的原生 collaboration-mode 对象关联来源；该关联使用不进入 JSON 协议的 Symbol，并随原生浅复制保留。Codex 的备用额度模式不能改变外部 Thread 的 Harness。官方创建、其他草稿与显式定时任务没有该草稿关联时，保持传入配置；切回 Codex、Adapter 卸载和连接释放会清理路由。

Desktop 26.1021 的原生预热池按工作目录匹配。每次创建使用独立的消费检查：官方创建不能消费外部预热，外部创建只能消费与本次 transport Model 一致的预热。检查读取本次创建参数，异步准备期间不依赖全局选择。错配的外部预热通过既有未提交预热释放接口清理；普通草稿的配置失效和预热接管规则保持不变。官方任务弹窗沿用原生创建链路，预热消费同样检查本次显式 Model，不额外提供独立任务创建操作。

官方定时任务新建弹窗默认保留原生 Codex Model 和创建路径，不继承普通聊天偏好。用户在该弹窗显式选择外部 Harness 时，将 transport Model 写入当前任务草稿，并传给本次原生会话创建；不设置 Host 全局选择或官方默认 Model。显式指定工作区时调用原生项目创建接口，将确认后的目标 Thread 回填当前任务；不改变其他创建入口或共享预热策略。外部选择只开放本地固定聊天，选择未确认或绑定失效时阻止提交，不回落 Codex。官方列表中已有外部任务仍按原 Thread 的持久化 Harness 归属执行。固定聊天任务的接入限制见[外部 Harness 定时任务](../product/harness-schedules.md)。

## 共同参与的请求

- `thread/list`：Host 能完整解码时合并外部 Thread；解码失败且不带 Host 游标时整条转发官方，此页只显示官方结果。
- `thread/section/move`：Host 维护跨所有者的分区顺序；参数无法解码时，`threadId` 或 `beforeThreadId` 指向外部 Thread 则报错，其他原样转发。
- `thread/archive`、`thread/unarchive`、`thread/delete`、`thread/metadata/update` 及 `turn/*`、`thread/read` 等：先按 `threadId` 判定归属，官方 Thread 原样转发，外部 Thread 才解码参数。
- `thread/queue/*`：官方 Thread 原样转发；外部 Thread 的 list/add/update/delete/reorder/start 由 Host 管理真实队列，见[外部 Thread 跟进消息队列](external-thread-queue.md)。不支持的外部队列方法返回 `-32076`。
- 其他带外部 `threadId` 的 `thread/*` 请求返回 `-32076`。例外是 `thread/attachment/list`、`thread/settings/update`：不带 codexhost 渲染扩展的官方客户端（如 SSH 连接的 ChatGPT iOS app）打开 Thread 或发送前会调用它们，因此按官方结构返回空结果。`thread/settings/update` 只确认、不应用，权限仍由 Harness 自己的权限模式决定。

## 外部 Thread 的归档与永久删除

归档只改变 Host 记录的归档状态，可以取消归档。Desktop 原生「永久删除」通过 `thread/delete` 删除 codexhost 的 Thread 映射、备份与元数据，并关闭已加载的 Harness 连接；不删除 Harness 原生会话或历史，也不向官方 Codex 转发该删除请求。未加载的 Thread 无需启动 Harness 即可删除。此流程不增加 codexhost 弹窗。

已加载的 Thread 在现有生命周期队列内先确认连接关闭、输出消费结束，再删除持久化记录；关闭失败或超时返回错误，保留记录及资源所有权供重试或 Host 退出时清理，不发送删除通知。Mapping Store 先删除主记录、再删除备份、最后删除元数据；主记录删除失败时不触碰辅助文件，辅助文件删除失败时回写主记录，让失败保留的映射及元数据仍能在重启后读取。连接确认关闭后，即使持久化删除失败，Host 也清理该连接遗留的 Desktop 审批与提问。交互清理同时匹配 Thread 实例与交互 ID，不影响其他 Session 使用相同 ID 的请求。确认关闭且输出消费结束的实例会从 Runtime 移除，即使其未发送 Turn 终态，也不保留旧实例的运行中标记。持久化删除失败不发送删除通知，后续打开按保留的映射恢复原生会话。删除成功后，Host 返回成功并发送 `thread/deleted`，让 Desktop 及共享连接的其他窗口移除会话与缓存。原生会话仍可按导入规则重新导入，但已删除的 Host 元数据不会恢复。

## 已知例外

- Mapping Store 读取失败时，带 `threadId` 的请求返回 `-32081`，不放行官方，避免外部 Thread 请求误发官方。

## 请求必有回应

请求处理意外失败时，若该请求尚未回应、也未交给官方，Host 返回 `-32603`，避免 Codex Desktop 一直等待。处理函数转入后台继续执行的工作同样受此保护；已回应或已转发的请求不会被重复回应。

回归验证位于 `packages/host-runtime/test/app-server-host.official-passthrough.test.ts` 与 `packages/protocol-core/test/model-routing.test.ts`。
