# CH 客户端通道 v1

## 所有权与入口

GUI、Web 和其他 App 的共享外部 Threads 由一个独立后台中的 `AppServerHost` 执行。Adapter、原生引用、Mapping Store 和 Thread/Turn 执行只属于该所有者；Desktop 的协议前端与 Web 网关不另开会话或第二份可写存储，也不保存共享 transcript。官方 Codex 路径仍使用原生协议与原生历史，不变成 Web 的外部 Harness。

客户端通道也支持本机原生 Codex Thread。共享服务通过已有 `OfficialRuntimeClient` 连接与 Desktop 相同的 `OfficialRuntimeScope`，按 Mapping Store 归属区分 external 与 native，保留官方 Thread ID。`thread/list` 沿用原生／外部合并分页。Web 使用 `codexhost/thread/catalog/read { includeArchived?: boolean, officialCursor?: {live: string|null, archived?: string|null} }`：本地外部元数据完整读取，官方每个请求分支仅查询一页 `limit:20 / sortKey:updated_at / sortDirection:desc`，不经过混合分页聚合器。统一去重排序后返回 `{ threads, ownership, archivedThreadIds, officialCursor }`；续页 cursor 直接来自原生页，不从合并结果或置顶推算。请求不带 cursor 表示首批；分支值为 `null` 表示已结束，不再查询；仅显式续页才读取下一页。默认不查询官方归档；`includeArchived:true` 分别对 live／archived 读取独立一页。本地 Mapping Store 已知的归档 ID 可随元数据一起返回，官方归档 ID 仅描述已返回页，不表示全部成员。Web 并行读取原生 `pins/list` 及完整项目定义，置顶缺失摘要按 ID 有界补读，首批完成后才响应，不为置顶或项目枚举全局历史。Web `session/list` 返回绑定归档 scope 的 `nextCursor`，浏览器独立持有加载状态；续页合并去重，普通刷新只更新首批，局部遗漏不作删除或归档证据，也不触发逐行补读。直接链接可用 `session/list {sessionId}` 按 ID 查询。搜索仅查询已加载会话。原生不可用不影响外部目录，协议错误仍报错。官方 Codex 不经 Adapter，也不提供专用会话导入。Web 使用聚合响应中的归属，不再为整份目录分批查询所有权。

原生快照用 `thread/resume {threadId, excludeTurns: true}` 建立订阅，再调用官方 `thread/read` 与 `thread/turns/list`；没有模型、权限或沙箱默认值覆盖。新 Thread 在首条用户消息前可以尚未生成历史；官方 `thread/turns/list` 对初始页明确返回这一状态时，客户端通道投影为空历史，不标记连接故障、不缓存为空，也不触发写操作。其他历史错误及旧页游标错误保持原样。客户端通道保存 start／resume／fork 响应及 `thread/settings/updated` 确认的配置，快照直接携带 `configuration.effectiveModel`、`effectiveThinkingOptionId`、`effectivePermissionModeId`，Model Ref 与官方目录一致。客户端 inspect 仅在配置缺失时尝试恢复；恢复失败仍返回 `{owner: "codex", locked: false, history: …}`，不带配置字段，不阻止历史查看；已确认配置不随快照反复恢复；Desktop inspect 保持只读的 `{owner: "codex", locked: true}`，不恢复 Thread。游标在异步读取前捕获；读取中后台换代会拒绝快照，不能确认尚未包含的事件。后台退出清空原生订阅、配置与交互状态，并使已观察的会话失效。遇到官方 writer 冲突时退回只读历史，快照标记不可发送并跳过队列读取；再次发送保留官方错误并提示先在另一端关闭会话，不绕过锁或自动 Fork。

原生命令／文件审批和提问可由 Web 回答。MCP 的空字段表单以确认审批呈现，保留 `message`、风险提示与工具参数，不投影为空问题列表；带 `codex_approval_kind: "mcp_tool_call"` 的请求只提供原生 `_meta.persist` 声明的会话／永久授权范围，普通空表单只提供单次允许与拒绝。审批响应在认领请求前校验 action、空 content 与授权范围，不自动批准，也不接受未声明的持久化权限。审批严格保留原生可选 decision；Web 使用代次限定的不透明请求 ID，服务端再映射到官方 ID，旧页面不能回答重启后复用编号的新请求。首次有效回应后删除待处理项，不自动重放结果未知的响应。未支持的原生权限授予请求不转换成通用允许／拒绝；Web 提问卡片没有密码输入契约，因此含 `isSecret` 的提问也不降级成明文字段。对 Web 不能回答的官方请求，有 Desktop 连接时交由 Desktop；没有 Desktop 连接时立即返回错误并投影原因，不让 Turn 悬挂。

`request_user_input_async` 通过原生 `agentMessage {delivery: "async", questions: [{title, options?}]}` 发布，不是等待工具结果的 server request。客户端通道从实时 Item 与最近 5 轮快照恢复问题，每个问题保留原生 `questionItemId` 和索引，复用 Web 提问卡，支持选项及自由文本。Web 的“跳过”只撤下当前 Host 代次的问题投影，不发送原生输入或取消请求；Host 换代后，原生历史中的未答问题仍可恢复。答案按 Desktop 的 `<send_user_message_question_reply>` 用户消息格式提交：活动 Turn 用带 `expectedTurnId` 的 `turn/steer`，空闲时用 `turn/start`；不伪造工具响应。原生用户消息中已确认的答案会撤下问题卡，发送前再读取当前历史，多个 Web 响应在发送前认领同一问题。结果未知时不重发；明确的原生参数／状态拒绝保留问题供重试。该投影只保存在内存中，Host 换代后从当前快照窗口恢复，不扫描整份历史；原生协议没有跨 Desktop 与 Web 的原子异步答题接口，因此同时提交仍受原生用户输入语义约束。

- `shared-contracts/client-channel` 定义浏览器安全的版本、游标、快照和交互契约。
- `host-runtime` 提供本地认证 HTTP 通道，复用原请求分派、投影器、配置观察器和交互响应路径。
- `desktop-control` 的公共 `HostClientChannel` 负责 Node 端发现、通知恢复和只读快照访问；命令不自动重试。
- `web-server` 一方面投影到现有 DSH UI，另一方面提供 `/api/ch/v1/*` 通用客户端网关。原生 App 可以消费此协议，不必实现 DSH 渲染日志、Adapter 或新的同步所有者。

## 独立后台生命周期

```text
Desktop Shim → 认证 WebSocket → Desktop 协议前端 ─┐
                                                ├→ 唯一后台所有者 → Harness
Web / App → Web 网关 → 客户端通道 ──────────────┘
```

任一入口可按需通过原生 Launcher 的 `host ensure` 启动后台，或连接同一数据目录中已运行的所有者。用户无须先打开另一界面。Desktop-only、Web-only、任一启动顺序和晚到客户端共用相同 canonical Threads；当前页面、草稿和滚动位置仍各端独立。

- Rust 管理脱离前台进程树的服务监督进程、就绪通知与正常退出时的子进程清理。后台及监管者使用 Host 数据目录作为工作目录。就绪文件记录进程身份与运行入口，不是会话索引或认证凭据。
- 同一 Host 数据目录中的 `host ensure`、`host stop`、`host restart` 共用 `shared-host-lifecycle.lock` 操作锁。`ensure` 持锁后重新检查后台是否可用；正常并发启动时，后续调用等待并复用已就绪的后台。`restart` 持锁完成停止、清理、启动和就绪确认。等待操作锁超过约 40 秒会报忙且不执行操作；启动就绪超时则表示启动结果未知，不会因此终止可能已在执行任务的后台。
- 锁由生命周期操作进程持有，操作结束或进程退出后释放，锁文件保留；监管进程不持有该锁。它不是后台整个存活期的所有权锁，也不锁原生 Harness home 或阻止其他进程写入同一原生会话。串行化仅覆盖使用该锁、针对同一数据目录的生命周期入口，不覆盖绕过入口或不支持该锁的旧客户端。Mapping Store 保留自身的存储锁。
- Node 后台拥有唯一生产 Mapping Store、插件注册表和 `SharedThreadOwner`。Desktop 协议前端复用同一存储对象和原生 Codex scope/account control，不通过另一份数据库或存储 RPC 合并状态。
- 官方 Codex 延迟启动：连接 Web 本身不启动 Desktop 或 stock Codex；查询包含原生 Threads 的主列表时按需启动 stock Codex；原生置顶操作与完整置顶查询也可按需启动 stock Codex，但不启动 Desktop 窗口。官方程序优先使用 Desktop 自带版本，其次使用本机不低于 0.161.0 的 `codex`，拒绝 shim 或代理。Desktop 启动上下文保存到 `<data>/official-startup-v1.json`；Web 先启动时使用记录，没有记录时使用基线 `-c features.code_mode_host=true`。Desktop 接入参数不同时，空闲后台替换一次，有活动 Turn 则保留并记录诊断，不排队等待。后台不会安装 CLI、切换账号或自动登录。
- 关闭 Web 或 Desktop 只断开对应传输，不停止后台，也不把断线解释成取消。Desktop 连接若仍拥有原生执行，会在后台排空真实结束事件；其他客户端不受其退出影响。待处理交互不会自动作答。
- 后台保持运行，最后一个界面退出不触发自动停机。显式 `codexhost host stop` 是管理操作，会停止后台及其任务，并等待所连接后台的监管进程完成正常清理后退出。优雅清理停滞时，原生层在短暂等待后终止关闭请求前记录的后台进程，由仍在运行的监管者清理子进程树。单独 `stop` 后，仍打开的客户端可能按需启动后台；保持界面打开并切换后台构建时使用 `restart`；源码入口 `npm start` 和 `npm start web` 的后台重启选择见[独立 Web 的启动说明](../product/standalone-web.md#代码与构建)。不支持生命周期锁的旧客户端需先更新或退出。不提供监管者被强杀后的安全交接保证；后台重启只恢复已有事实，不保证中断中的 Harness 任务继续执行，也不重发结果未知的命令。
- 认证描述文件标记 `owner: service`。发现不仅校验 PID，还用认证 hello/epoch 探测端点。Web 的服务模式断线后重新发现或按需启动同一数据目录的所有者；不切换到独立插件模式。
- 已运行的旧 Desktop-owned Host 不会被接管、停止或绕过存储锁。旧客户端通道与显式 CDP 仍可连接；切换独立后台需要用户另行更新并重启 Desktop。构建源码不等于正在运行的进程已经升级。

既有 GUI 项目归属由后台只读读取 `CODEX_HOME/.codex-global-state.json`；没有文件时 GUI 集合为空，损坏文件明确失败，不写原生文件。`codexhost/workspace/read` 投影 canonical external IDs 及请求中指定的原生 Thread IDs，并合并唯一 Mapping Store 中明确记录的项目/无项目事实；生成的执行目录不凭 cwd 匹配变成项目。置顶统一通过 `codexhost/thread/pins/list` / `codexhost/thread/pins/set` 访问原生分区协议与同一 Mapping Store 的外部 Thread 分区记录，支持无 Desktop 窗口读写；查询与 Desktop 分区移动共用串行边界。官方 Thread 的置顶通过官方 `thread/section/move` 持久化，不要求外部 Mapping Store 记录；`pins/list` 始终查询官方 Pinned 分区，再合并未归档外部成员，返回与 Desktop 一致的混合顺序（包含没有外部置顶的情况）。`workspace/read` 的置顶字段仅从 Mapping Store 投影外部成员，不读取 GUI 全局文件中的置顶副本，也不是 Web 置顶列表的事实源；完整成员与顺序通过 `pins/list` 查询。不建立预置顶、补写队列或 Renderer 回退；原生能力不可用时明确失败，未知写入结果不自动重发。远程 SSH 的原有执行所有权保持原样，公开客户端通道支持本机原生与 external Threads，但不聚合远程连接；移动后台推送不是此改造的能力。

## 官方 Codex 的统一入口

Web 在插件列表之外调用 `codexhost/harness/inspect {harnessId: "codex"}`，就绪时显示一个“Codex”；不可用时不影响其他 Harness。`codex` 是保留 ID，不是插件描述符。新建传官方 Model Ref，由 Host 转为官方 `thread/start` 参数，直接返回官方 Thread ID，不创建 Mapping Store 记录。无项目时由 Host 分配默认生成目录再传 `cwd`，Web 不分配目录。

客户端统一使用现有方法，Host 的方法表按所有者分发。官方 `thread/queue/*` 同名转发；排队发送进入官方队列，Web 与 Desktop 可操作同一队列。

Web 的排队提交通过 `thread/read {includeTurns: false}` 读取运行态，不依赖历史是否已经生成。仅提交前原生状态明确为 `idle`，且入队后读取的队首仍为本条时，才尝试原生 `thread/queue/start`；其他运行态只入队。该原生操作拒绝活动或待启动 Turn，因此并发 Desktop 提交不会把排队变为 Steer。读取到已有队首时不启动本条，不因追加输入主动恢复暂停积压。读取与启动不是跨客户端原子事务，不承诺锁定队列顺序或停止边界；最终接受与否以原生操作结果为准，不回退到 `turn/start` 或 Steer。入队已确认而启动结果未知时明确提示不要重发；中断或失败后的非空队列投影对应暂停原因。插队请求保留本次提交策略，空闲时启动本条，不转为排队。浏览器以实际 `next-turn` 队列投影结束本地发送回显，即使发送时本地看起来空闲，也不会隐藏队列项并持续显示正在处理。

`codexhost/thread/queue/send-now` 在空闲时调用 `thread/queue/start`，活动 Turn 内则读取原队列项，以其完整输入和 `clientUserMessageId` 调用带 `expectedTurnId` 的 `turn/steer`，确认接受后才删除队列项。拒绝或结果未知不回退启动新 Turn；已接受但删除未确认时返回 `-32095`，保留“输入已接受，不要重发”的明确错误信息，不把它归为发送结果完全未知。相同 Thread／队列项的该操作复用当前 Host 的有界进程内回执，不承诺跨重启去重，也不能将两次原生写入变成原子操作。模型、Thinking 与权限选择转为 `thread/settings/update`，仅在匹配的 `thread/settings/updated` 通知确认后发布结果，空响应不表示已生效。权限选项来自 `permissionProfile/list` 中允许选择的档案，保留官方 ID。

官方 Thread 的客户端命令目录提供 `/compact`、`/review` 和 `skills/list` 返回的启用 Skill，Desktop 的 Host 命令目录仍为空，使用其官方菜单。菜单中的压缩和默认审查分别调用 `thread/compact/start`、`review/start`（`uncommittedChanges`）；显式发送 `/review 指令` 使用 `custom` target。压缩不接受文本参数，这两类操作不能排队或 Steer，不降级成普通 Prompt。Skill 同名时保留官方列表中首个有效启用项，目录通过 `warnings` 报告忽略的条目、解析错误或 Skills 加载失败，不影响有效入口；Skills 不可用时仍保留压缩和审查。`$name` carrier 保留原生前缀，发送时按当前工作区官方目录解析为 `type: "skill"` 的 `name/path` 输入，原有文本、附件及队列／Steer 语义保留；Skill 已失效或目录读取失败则拒绝发送，不退化为普通提示词。命令回执只在官方返回 Turn ID 时携带 `turnId`，压缩的空响应不生成虚构 Turn；执行进度仍以官方通知与历史为准。置顶和用量复用 Host 已有官方实现。官方 Thread 支持同目录 Web Fork，不开放 Web 历史回退。

官方 Fork 使用既有 `thread/fork {threadId, lastTurnId, excludeTurns: true}`，保留指定轮次及之前的原生上下文；不传模型、权限或 cwd 默认值覆盖。新 Thread 的订阅与实际配置按响应中的 `thread.id` 登记，不覆盖来源 Thread 的配置。新身份仍由官方持久化并与 Desktop 共用，不创建 Mapping Store 记录；通知使客户端目录失效重读。GUI 的原生 Fork 转发路径保持不变，结果未知不自动重试。

官方命令的开始和输出通知可能早于原生历史分页中的 Item。Host 在当前原生后端代次内保留 `commandExecution` 通知，补入原生 full Turn 页，已持久化的完成记录优先；不填充 summary/notLoaded 页，也不凭工具事件虚构 Turn。原生 `contextCompaction` Item 没有 `status`，客户端快照根据 `item/started` 和 `item/completed` 补齐压缩状态；原生历史仅持久化已完成的压缩，回放时标为完成，不重新打开压缩展示。未确认完成的压缩在所属 Turn 结束时按失败或中止收尾，不冒充成功。这些状态只补入客户端投影，不修改 Desktop 原生通知或历史。仅当全页 Item 都有原生 `startedAtMs` 时稳定排序，使完成时才追加的命令仍位于后来输入之前；缺失时间戳时保留原生顺序。Thread 关闭或后端换代清空临时状态，不持久化第二份历史。

官方停止使用 `turn/interrupt`，不等价于终止该 Thread 的后台终端。原生后台命令可以在 Turn 中断后继续运行，与显式启动的下一 Turn 重叠；终端清理属于独立的原生操作，Host 不在停止 Turn 时追加全量清理或进程强杀。

## 应用更新

共享 Host 持有同一更新协调器，Desktop 协议前端和 Web 客户端通道使用现有 `codexhost/update/check`、`start`、`status` 接口；Console 对同一安装复用这些接口。更新不要求 Desktop 在线。安装上下文来自原生服务监管进程，下载、校验、状态和互斥由 update-manager 管理。原生监管进程接管已准备请求并将锁交给独立 Updater，由它停止 GUI、Web、Host，安装并按请求恢复界面。安装期间其他客户端不能自动重拉服务。跨安装入口拒绝操作，不通过 PATH 猜测更新对象；源码构建不支持安装更新。具体恢复和失败语义见[控制台更新](../operations/codexhost-console.md#更新)。

## 认证与传输

Host 只监听 `127.0.0.1`，使用随机 Bearer token，拒绝带 Origin 的直接浏览器请求。私有描述文件位于 `$CODEXHOST_DATA_DIR/client-hosts`，默认 `~/.codexhost/client-hosts`，文件权限为 `0600`；PID 和 epoch 区分不同实例。发现时验证存活 PID、文件类型、大小和 Unix 所有者/权限，并通过打开的文件句柄校验，拒绝符号链接。描述文件不是会话索引。

浏览器/App 使用 Web 原有 Cookie/Bearer 认证及同源防护；Host 私有 token 不下发给客户端。公网使用仍需 TLS/可信网络部署，移动端仍要实现凭据保管、挂起恢复和通知生命周期。开发用 `--no-auth` 不应暴露到不可信网络。

| 操作        | Host 本地路径                    | Web/App 路径                            |
| ----------- | -------------------------------- | --------------------------------------- |
| 通知        | `GET /v1/events?epoch=…&after=…` | `GET /api/ch/v1/events?epoch=…&after=…` |
| 受限 RPC    | `POST /v1/rpc`                   | `POST /api/ch/v1/rpc`                   |
| Thread 快照 | `POST /v1/snapshot`              | `POST /api/ch/v1/snapshot`              |
| 回答交互    | `POST /v1/respond`               | `POST /api/ch/v1/respond`               |

服务还提供认证的 Host-private `/v1/desktop` WebSocket 和 `/v1/shutdown` 管理入口，不通过 Web 网关公开。Desktop 连接携带有界、版本化的运行时上下文，不能改写后台的存储目录、Codex home 或委派认证。Web 发行包携带原生 Launcher 和同一 Host bundle；它不是纯浏览器即可启动的后台，也不包含 Node 或 Harness CLI。

POST 使用 JSON，正文上限 128 MiB（`CLIENT_REQUEST_LIMIT_BYTES`，与桌面 WebSocket 一致，可容纳内联图片）；返回 `{result: …}` 或 `{error: {code, message}}`。RPC 参数为 `{method, params}`，快照参数为 `{threadId, knownTurns?, truncateToolOutput?}`（可选项见下文“快照的可选精简”），回答参数为 `{epoch, threadId, requestId, result}`。可用 RPC 在 `CLIENT_CHANNEL_METHODS` 中；支持官方 Codex 创建、恢复、Fork 及本地 external Thread 操作，不开放官方历史回退。具体 Harness 能力仍须通过已有 inspect 契约查询，不能因 RPC 在名单内便假定该 Harness 支持它。

client channel 透传既有的 `thread/revert {threadId, beforeTurnId}`。它与 GUI 共用分页历史回退路由；请求携带 canonical Turn ID，过期边界或活动 Turn 由 Host 拒绝。Web 编辑只对当前 Thread 声明 `history.rollbackLastTurn` 的最后一轮开放，回退确认后再通过 `turn/start` 重跑；这两个操作不构成新的原子编辑契约，结果未知不重试。详见[独立 Web 的已发送消息编辑](../product/standalone-web.md#编辑已发送消息)。

本地 `thread/start` 可传 `{model, projectlessWorkspace: {prompt?}}` 明确不选项目，由执行 Host 在创建时独占分配默认 `~/Documents/Codex/<日期>/<名称>/`；不能同时传 cwd 或 ephemeral，客户端不能指定生成根目录。cwd 是会话目录，`outputs/`、`work/` 只是其子目录。外部 Harness 将路径/无项目事实写入现有 Mapping Store metadata sidecar 后发布 Thread，官方 Thread 由官方协议保存；普通选中目录仍传 cwd，真实 Harness 的执行与权限能力不改变。Web 在首次发送前仅持有无 cwd 草稿，不自行分配目录、不注册生成目录为项目；不读取或修改 Electron 私有根目录设置。创建结果未知不重发，也不自动删除可能已被 Native Session 引用的路径。详细目录/侧栏行为见[独立 Web](../product/standalone-web.md#新会话与无工作区目录)。

通知是 `application/x-ndjson`，空行是心跳，不是事件。慢消费者超过有界写缓冲时断开，不能阻塞 GUI。Node 通道断线重新发现描述文件；网关在底层 Host 离线时结束 App 的通知流，App 可携带游标重新连接。

## 通知、快照与恢复

通知有两种形状：

- `hello {version: 1, cursor: {epoch, sequence}, reset}`。
- `changed {cursor: {epoch, sequence}, threadId, method}`。

**changed 是失效通知，不是可追加的 token。** 首次先建立订阅，再取快照；读取期间收到新通知必须再校验。快照给出同一 Host 的元数据、最近 5 轮 full/desc、下一页 cursor、生效配置、当前待处理交互，以及 Shared Host 持有的绝对队列与暂停原因。热会话在不让出执行权的同步步骤中复制已接受状态及通知水位；状态可以包含尚待发出的后续通知所描述的变化，因此禁止把通知当增量再次拼接到快照上。

显式 Harness 命令的临时 Turn 不进入 `turnsPage` 或原生历史。快照的可选 `command: {name, turn}` 单独提供当前 Host 进程最近一次显式命令；执行期间取实时 Item 快照，结束后保留确认的 Turn 结果，直到下一次命令覆盖或 Host/Session 重建。它不落盘，也不改变对话历史、分页或回退边界。Web 将其映射到已有命令卡，显示手动压缩进度及成功、失败、取消结果；接受回执不等于执行成功。普通 Turn 中的自动压缩仍以 `contextCompaction` Item 展示，客户端快照附带 Item 自身的 `status` 和失败原因，因此压缩结束后无需等待整轮回复结束。底部状态在明确的压缩活动期间显示“正在压缩”，其余活动显示通用处理状态；不依据缺失的手动标记猜测来源。

Host 和 Node 网关分别保留最近 512 条轻量通知。游标仍在窗口中时，`hello.reset=false`，随后重放大于旧游标的通知；hello 的 cursor 是本轮重放终点，不应在处理重放前覆盖旧消费游标。窗口不足、游标超前或 epoch 不同时，`reset=true`，重新读取所需 Thread 的快照。每次重连都重新校验已关注的 Thread，包括仍待处理的交互；不需要持久事件队列。

Web 将同一 Thread 的变化按 100ms 合并，读取中再次变化会安排后续读取，只对仍有 follow 的 Thread 读取正文。事件模式不运行原来的 1.5 秒历史轮询。Host 换代时退役旧 Web 展示流，以高于旧游标的新内存序号重新打开；客户端保留旧正文直到新的权威 baseline 到达，即使恢复后的原生 Turn/Item ID 改变，也不将其追加成重复消息。较早历史继续走原生分页，不为了同步一次读取全部历史。

### 快照的可选精简

`/v1/snapshot` 的两个可选参数让快照更小，而不改变“快照是绝对状态”的含义。不带参数（旧客户端）时返回与之前完全相同的快照；旧 Host 会忽略未知参数并返回完整 Turn，客户端据此自然回退。

- **`knownTurns: [{id, fingerprint}]`（最多 64 项，可为空数组）**：只要出现该字段，Host 就给已结束的 Turn 附 `fingerprint`。指纹是对“将要返回的形态”的哈希，并绑定 Host epoch，所以 Host 换代、内容或截断选项变化后都不会匹配。已结束且指纹与客户端所报一致的 Turn 以占位 `{id, status, items: [], fingerprint, unchanged: true}` 保持原顺序返回。活跃 Turn、`inProgress` Turn 永远完整返回，指纹只对内容的权威副本有效，不是游标或增量。
- **`truncateToolOutput: true`**：已结束 Turn 中、非 `inProgress` 的 `commandExecution.aggregatedOutput`、`fileChange.changes`（diff）、`mcpToolCall.result/error`、`dynamicToolCall.contentItems` 内超过 64 KiB（按 JS 字符计，常量见 `client-snapshot-compaction.ts`）的字符串只保留前 8 KiB（不拆代理对），并在该 Item 上加 `codexhostTruncated: {fields: [{path, originalLength}]}`（`path` 相对该 Item）。消息、Reasoning 与活跃 Turn 不截断。完整 Item 通过白名单内的 `thread/items/list`（`{threadId, turnId}`，按 `limit` ≤ 100 分页）获取，已结束 Turn 的 Item 与快照来源一致；找不到该 Item 时应重新取不带该选项的快照。

Web 网关当前只使用 `knownTurns`：`ChThreadHistory` 把窗口里已持有的已结束 Turn（最近 16 个，指纹随 Turn 保存）发给 Host，把占位还原成本地副本再投影。必须回退到完整快照的情况：Host 换代（视图随之退役，本地副本与指纹一并丢弃）、hello `reset=true`（清除已持有指纹，下一次读取发送空 `knownTurns`）、占位的指纹与本地副本不符或本地没有该 Turn（立即以空 `knownTurns` 重读一次，若仍返回占位则报错）、旧 Host（不返回指纹，从不发送占位）。Web 网关**不**启用 `truncateToolOutput`：DSH 界面没有按需展开长输出的路径，浏览器必须收到完整输出，而截断只会改善本机 Host 到网关的 HTTP，却多出一次 `thread/items/list`；该选项原样开放给 `/api/ch/v1/snapshot` 的原生 App，它们自行用 `thread/items/list` 展开。

Web HTTP 与浏览器 WebSocket 的压缩规则集中于 `packages/web-server/src/compression.ts`，共用 1 KiB 阈值。HTTP 的内置资产与 RPC JSON 回复仅压缩 `text/*`、`application/json`、`application/javascript`、`image/svg+xml`、`application/manifest+json`（忽略 Content-Type 参数）；按 Accept-Encoding 优先选择 br（quality 5），其次 gzip（level 6），`q=0` 拒绝该编码，不按其他 q 值排序。可压缩类型均带 `Vary: Accept-Encoding`，达到阈值且协商成功时使用异步 zlib 压缩。带 rev 的插件资源与 `/assets/` 的压缩结果按编码和完整 URL 缓存在同一个 Map 中，并发请求共享待完成结果，超过 64 条整体清空；其他回复逐次压缩。SSE、`/api/file` 图片、上传、`/api/ch/v1/` 网关及外部插件自管响应不经过这条压缩路径。

浏览器 WebSocket（`/api/remote.mux`）对不小于 1 KiB 的帧启用 `permessage-deflate`（`server/clientNoContextTakeover`，level 3，zlib 并发上限 4），仅作用于浏览器一侧；Host 与网关之间的本机 HTTP 不压缩。禁用上下文复用后每帧独立压缩，1 KiB 以下的投影更新不压缩，连接不保留 deflate 窗口。

Web 的 `session/control` 状态流必须先发送 baseline，再发送 projection 更新。异步草稿元数据准备完成后，服务端在同一个同步步骤中读取当前会话投影、注册广播并发送 baseline；准备期间的队列删除直接反映在 baseline 中。提前关闭的连接不再注册广播，避免异步准备结束后留下失效订阅。

浏览器的控制流承载队列和用量等投影，与正文历史订阅分别恢复。网络承载失败即使早于连接 generation 失效，也保持可取消的退避重试，不因连续两次失败永久结束消费者；业务或协议错误仍明确失败。连接 generation 恢复时创建新的控制流消费者，退役旧实例并忽略迟到回调，不能对已退出的消费者仅调用 `restart/start`。升级前端后，已打开的旧页面需要刷新一次加载新代码；此后普通断线与 Web 重启不要求手动刷新，也不重发输入。

同一 Host 内检测到原尾部消失或非追加正文改写时，旧展示缓冲失效并报告错误，重新打开页面取得当前历史；不把历史重写伪装成连续追加。v1 尚不是逐 Item patch/token 的低带宽协议；已结束的 Turn 可以按指纹跳过、长工具输出可由客户端显式截断，但活跃 Turn 的快照仍完整且可能较大。目录仍保留全量查询及差量发布；每 10 秒校验原生保存的项目元数据，项目变化不保证消息级即时性。

## 输入、工具与交互

Desktop 专用 `CodexTurnProjector.pendingTurn()` 不包含所有进行中的 Item，不能用作通用客户端完整快照。`snapshotTurn()` 复用同一投影器的 Item 状态，提供 Reasoning、命令输出及工具状态；原 Desktop 通知形状保留。Host 接受的普通用户输入保留给快照；来自客户端通道的输入还沿既有 shared-Thread 投影方式广播给 GUI。`clientUserMessageId`/`clientId` 关联用于撤下 Web 乐观回显，不能靠相同文本猜测确认。

Turn 可附 `codexhostFileOperations: [{beforeItemId, item}]`，保留被 Desktop 累计 `fileChange` 卡合并的原始编辑调用。`item` 沿用原生 Item ID、参数、输出及成功/失败/取消状态；`beforeItemId` 指向后续的非文件 Item，`null` 表示放在轮末，同一锚点按数组顺序排列。客户端展示逐次调用时替换正文里的累计文件卡，而不是叠加两种表示；累计文件卡的 `changes` 仍供本轮变更汇总使用。字段缺失表示 Host 只提供旧的累计表示，不能从累计 diff 猜测真实的工具调用次数或边界。实时快照、已完成 Turn 和分页历史均携带该信息；它参与已完成 Turn 指纹，原始调用不受 `truncateToolOutput` 对 `items` 的截断影响。

审批与提问使用 Host 中现有 request ID，并绑定 epoch、Thread。Web 显示原生 action/选项标签，结果仍由 Host 的原有投影解析器校验。第一份有效响应在异步执行前认领，后续响应不重复调用 Harness；`serverRequest/resolved` 使其他 GUI/Web 卡片撤下。`{resolved:true}` 只表示请求已不再待处理，不证明当前客户端的答案获胜，更不代表工具执行成功。

断线会撤下 Web 的交互卡片，不自动回答或拒绝 Harness；重新连接只恢复快照中仍 pending 的请求。配置通知只报告观察器已接受的实际状态，多个配置命令不被包装成一个虚假的原子事务。草稿、阅读位置、输入框内容与当前选中 Thread 留在各端。跟进队列不属于这些本地 UI 状态：Desktop 的原生 `thread/queue/*` 与 Web 的 DSH inbox 操作都落到 Shared Host；正常成功后推进，停止、失败或 unknown outcome 后暂停。

## 写操作边界

- 一个客户端 RPC 只提交一次；超时、响应断开或结果不明时不得自动重发。
- `turn/start` 以 Thread + `clientUserMessageId` 在当前进程内去重，相同 ID 不同输入拒绝；最多保留 256 条回执，不驱逐仍进行中的请求。确定未提交的参数错误/忙碌拒绝可释放回执；未知结果保留在窗口内。
- 这是有界、进程内的回执，不是跨 Host 重启、窗口驱逐或历史恢复的持久 exactly-once 保证。
- 原生历史刷新后，可在回执窗口内补回已接受输入的 `clientId`，不建立持久消息映射。
- 写入已确认后，随后的快照读取失败不会改报成“发送被拒绝”。
- 同时发送服从 Host 的 canonical queue 或 Steering 语义；队列通知只触发绝对快照重读，unknown outcome 不自动重发，也不会另开 Adapter 伪造并发。

## 验证范围

使用真实 Host 类、公共 Node 客户端、临时 HTTP 服务、Fake Harness 和双浏览器验证；另以 `npm run test:shared-host` 在隔离 HOME、Codex home 和数据目录中运行真实 Launcher/Node 进程，覆盖顺序启动复用、两个启动顺序、前台退出、原生启动参数、存储复用、后台崩溃后的旧子进程退出和不重发。发行测试验证仓库外的认证 Web 自动启动同一后台、晚到客户端收敛及无重复 Adapter。原生 Codex 进程测试是模拟协议，不调用真实 Codex CLI；不发送真实模型消息或真实审批。覆盖认证/同源隔离、GUI 与 Web 消息广播、完整热状态、并发输入、审批竞争、提问恢复、配置/停止、请求去重、通知窗口、读取竞态以及 epoch 切换后的新 baseline。测试并不代表所有 Harness、操作系统、后台任务投影或移动真机能力已验收。更新运行中的 Desktop 必须另行安排，源码通过验证不等于旧进程已启用新通道。
