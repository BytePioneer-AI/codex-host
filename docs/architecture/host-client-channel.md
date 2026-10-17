# CH 客户端通道 v1

## 所有权与入口

GUI、Web 和其他 App 的共享外部 Threads 由一个独立后台中的 `AppServerHost` 执行。Adapter、原生引用、Mapping Store 和 Thread/Turn 执行只属于该所有者；Desktop 的协议前端与 Web 网关不另开会话或第二份可写存储，也不保存共享 transcript。官方 Codex 路径仍使用原生协议与原生历史，不变成 Web 的外部 Harness。

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

- Rust 管理脱离前台进程树的服务监督进程、`shared-host-process.lock`、子进程实例身份与退出证明。并发启动只能产生一个执行所有者；Node 崩溃后须证明旧受监管进程树退出才释放启动锁。就绪文件只记录进程身份，不是会话索引或认证凭据。
- Node 后台拥有唯一生产 Mapping Store、插件注册表和 `SharedThreadOwner`。Desktop 协议前端复用同一存储对象和原生 Codex scope/account control，不通过另一份数据库或存储 RPC 合并状态。
- 官方 Codex 延迟启动：纯 Web 外部会话不需要启动 Desktop 或 stock Codex。首个 Desktop 的原生可执行文件、app-server 参数及功能标志在首个 backend generation 前确定，之后不因客户端接入而替换进程。官方 Codex 使用仍需要已安装的原生组件；后台不会安装 CLI、切换账号或自动登录。
- 关闭 Web 或 Desktop 只断开对应传输，不停止后台，也不把断线解释成取消。Desktop 连接若仍拥有原生执行，会在后台排空真实结束事件；其他客户端不受其退出影响。待处理交互不会自动作答。
- 后台保持运行，最后一个界面退出不触发自动停机。显式 `codexhost host stop` 是管理操作，会停止后台及其任务，并等待原生监管者确认进程树退出、释放执行准入锁，关闭请求的回执本身不算退出证明。若优雅清理停滞，原生层在短暂等待后仅终止关闭请求前已验证的后台进程实例，再由监管者清理子进程树；不会终止替代代次或绕过准入锁；仍打开的客户端可能按需重新启动它，应先退出界面再进行维护。后台崩溃恢复只恢复已有事实，不能保证中断中的 Harness 任务继续执行，也不重发结果未知的命令。
- 认证描述文件标记 `owner: service`。发现不仅校验 PID，还用认证 hello/epoch 探测端点。Web 的服务模式断线后重新发现或按需启动同一数据目录的所有者；不切换到独立插件模式。
- 已运行的旧 Desktop-owned Host 不会被接管、停止或绕过存储锁。旧客户端通道与显式 CDP 仍可连接；切换独立后台需要用户另行更新并重启 Desktop。构建源码不等于正在运行的进程已经升级。

既有 GUI 项目归属由后台只读读取 `CODEX_HOME/.codex-global-state.json`；没有文件时 GUI 集合为空，损坏文件明确失败，不写原生文件。`codexhost/workspace/read` 只投影 canonical external IDs，并合并唯一 Mapping Store 中明确记录的项目/无项目事实；生成的执行目录不凭 cwd 匹配变成项目。置顶写入仍走 Desktop 的原生服务，未接入 headless 置顶操作；保存的置顶读取不等于所有 Desktop 版本的实时分区状态。远程 SSH 的原有执行所有权保持原样，公开客户端通道仍只支持本地 external Threads；移动后台推送不是此改造的能力。

## 隔离 Web Codex 来源

显式启用的单个 Web Codex 配置由同一 shared Host 中的独立 `IsolatedSessions` owner 拥有。`session-runtime` 提供现有隔离运行/恢复和持久 journal，Web gateway 不加载该执行 Adapter 或保存第二份可写会话；explicit standalone 复用同实现。external AppServerHost/MappingStore保持原边界，GUI native Codex仍使用official route。官方项目文件保持只读，external官方pin写仍依赖Desktop；Host仅保存Web自建workspace及隔离local pin/archive。

隔离来源使用Host-private的配置、受限操作及follow/control通道，并携epoch和服务端返回的home散列scope。配置不注册为浏览器RPC；所有会话操作检查已配置scope/identity，不能传home/nativeRef改变执行身份。客户端通道增加 `web-codex-changed` 失效通知，继续使用既有epoch/cursor/reset机制；它不是可追加token，也不构成另一份durable journal。网关重连核对列表和待处理交互，原生交互仍由唯一owner仲裁，迟到epoch回答不生效。隔离 owner 按 Session/requestId 保留最多256个进程内提交回执；多个 gateway 的相同输入复用结果，冲突输入拒绝，淘汰或重启后不保证exactly-once。

停止gateway不停止shared隔离执行；Push依赖gateway存活。profile/home准入锁防止codexhost并发owner，但不控制用户手动CLI。native close未确认时不释放锁；崩溃后不能仅依据Node PID消失接管home，Rust清理旧受监管树后发布私有退出证明；Node验证记录与旧锁的PID、supervisor generation及canonical owner root匹配后才恢复，浏览器配置不能传入自认证证明。结果未知的写入不自动重发，也不保证跨重启exactly-once。迁移commit封存旧源以阻止新版writer重开；旧无锁二进制仍须显式停用。离线维护入口先原生stop、再校验退出/锁与无新mutation，成功后解封源并封存目标配置。单源迁移的显式确认、完整格式、路径保留与回滚限制见[独立Web](../product/standalone-web.md#显式迁移一个旧-web-codex-来源)。

## 认证与传输

Host 只监听 `127.0.0.1`，使用随机 Bearer token，拒绝带 Origin 的直接浏览器请求。私有描述文件位于 `$CODEXHOST_DATA_DIR/client-hosts`，默认 `~/.codexhost/client-hosts`，文件权限为 `0600`；PID 和 epoch 区分不同实例。发现时验证存活 PID、文件类型、大小和 Unix 所有者/权限，并通过打开的文件句柄校验，拒绝符号链接。描述文件不是会话索引。

浏览器/App 使用 Web 原有 Cookie/Bearer 认证及同源防护；Host 私有 token 不下发给客户端。公网使用仍需 TLS/可信网络部署，移动端仍要实现凭据保管、挂起恢复和通知生命周期。开发用 `--no-auth` 不应暴露到不可信网络。

| 操作 | Host 本地路径 | Web/App 路径 |
| --- | --- | --- |
| 通知 | `GET /v1/events?epoch=…&after=…` | `GET /api/ch/v1/events?epoch=…&after=…` |
| 受限 RPC | `POST /v1/rpc` | `POST /api/ch/v1/rpc` |
| Thread 快照 | `POST /v1/snapshot` | `POST /api/ch/v1/snapshot` |
| 回答交互 | `POST /v1/respond` | `POST /api/ch/v1/respond` |

服务还提供认证的 Host-private `/v1/desktop` WebSocket 和 `/v1/shutdown` 管理入口，不通过 Web 网关公开。Desktop 连接携带有界、版本化的运行时上下文，不能改写后台的存储目录、Codex home 或委派认证。Web 发行包携带原生 Launcher 和同一 Host bundle；它不是纯浏览器即可启动的后台，也不包含 Node 或 Harness CLI。

POST 使用 JSON，正文上限 1 MiB；返回 `{result: …}` 或 `{error: {code, message}}`。RPC 参数为 `{method, params}`，快照参数为 `{threadId}`，回答参数为 `{epoch, threadId, requestId, result}`。可用 RPC 在 `CLIENT_CHANNEL_METHODS` 中；不允许 `thread/resume`、官方 Codex 创建或非本地 external Thread 操作。具体 Harness 能力仍须通过已有 inspect 契约查询，不能因 RPC 在名单内便假定该 Harness 支持它。

本地 external `thread/start` 可传 `{model, projectlessWorkspace: {prompt?}}` 明确不选项目，由执行 Host 在创建时独占分配默认 `~/Documents/Codex/<日期>/<名称>/`；不能同时传 cwd 或 ephemeral，客户端不能指定生成根目录。cwd 是会话目录，`outputs/`、`work/` 只是其子目录。Host 将路径/无项目事实写入现有 Mapping Store metadata sidecar 后发布 Thread；普通选中目录仍传 cwd，真实 Harness 的执行与权限能力不改变。Web 在首次发送前仅持有无 cwd 草稿，不自行分配目录、不注册生成目录为项目；不读取或修改 Electron 私有根目录设置。创建结果未知不重发，也不自动删除可能已被 Native Session 引用的路径。详细目录/侧栏行为见[独立 Web](../product/standalone-web.md#新会话与无工作区目录)。

通知是 `application/x-ndjson`，空行是心跳，不是事件。慢消费者超过有界写缓冲时断开，不能阻塞 GUI。Node 通道断线重新发现描述文件；网关在底层 Host 离线时结束 App 的通知流，App 可携带游标重新连接。

## 通知、快照与恢复

通知有两种形状：

- `hello {version: 1, cursor: {epoch, sequence}, reset}`。
- `changed {cursor: {epoch, sequence}, threadId, method}`。

**changed 是失效通知，不是可追加的 token。** 首次先建立订阅，再取快照；读取期间收到新通知必须再校验。快照给出同一 Host 的元数据、最近 5 轮 full/desc、下一页 cursor、生效配置、当前待处理交互，以及 Shared Host 持有的绝对队列与暂停原因。热会话在不让出执行权的同步步骤中复制已接受状态及通知水位；状态可以包含尚待发出的后续通知所描述的变化，因此禁止把通知当增量再次拼接到快照上。

Host 和 Node 网关分别保留最近 512 条轻量通知。游标仍在窗口中时，`hello.reset=false`，随后重放大于旧游标的通知；hello 的 cursor 是本轮重放终点，不应在处理重放前覆盖旧消费游标。窗口不足、游标超前或 epoch 不同时，`reset=true`，重新读取所需 Thread 的快照。每次重连都重新校验已关注的 Thread，包括仍待处理的交互；不需要持久事件队列。

Web 将同一 Thread 的变化按 100ms 合并，读取中再次变化会安排后续读取，只对仍有 follow 的 Thread 读取正文。事件模式不运行原来的 1.5 秒历史轮询。Host 换代时退役旧 Web 展示流，以高于旧游标的新内存序号重新打开；客户端保留旧正文直到新的权威 baseline 到达，即使恢复后的原生 Turn/Item ID 改变，也不将其追加成重复消息。较早历史继续走原生分页，不为了同步一次读取全部历史。

Web 的 `session/control` 状态流必须先发送 baseline，再发送 projection 更新。异步草稿元数据准备完成后，服务端在同一个同步步骤中读取当前会话投影、注册广播并发送 baseline；准备期间的队列删除直接反映在 baseline 中。提前关闭的连接不再注册广播，避免异步准备结束后留下失效订阅。

浏览器的控制流承载队列和用量等投影，与正文历史订阅分别恢复。网络承载失败即使早于连接 generation 失效，也保持可取消的退避重试，不因连续两次失败永久结束消费者；业务或协议错误仍明确失败。连接 generation 恢复时创建新的控制流消费者，退役旧实例并忽略迟到回调，不能对已退出的消费者仅调用 `restart/start`。升级前端后，已打开的旧页面需要刷新一次加载新代码；此后普通断线与 Web 重启不要求手动刷新，也不重发输入。

同一 Host 内检测到原尾部消失或非追加正文改写时，旧展示缓冲失效并报告错误，重新打开页面取得当前历史；不把历史重写伪装成连续追加。v1 尚不是逐 Item patch/token 的低带宽协议，长工具输出快照仍可能较大。目录仍保留全量查询及差量发布；每 10 秒校验原生保存的项目元数据，项目变化不保证消息级即时性。

## 输入、工具与交互

Desktop 专用 `CodexTurnProjector.pendingTurn()` 不包含所有进行中的 Item，不能用作通用客户端完整快照。`snapshotTurn()` 复用同一投影器的 Item 状态，提供 Reasoning、命令输出及工具状态；原 Desktop 通知形状保留。Host 接受的普通用户输入保留给快照；来自客户端通道的输入还沿既有 shared-Thread 投影方式广播给 GUI。`clientUserMessageId`/`clientId` 关联用于撤下 Web 乐观回显，不能靠相同文本猜测确认。

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

使用真实 Host 类、公共 Node 客户端、临时 HTTP 服务、Fake Harness 和双浏览器验证；另以 `npm run test:shared-host` 在隔离 HOME、Codex home 和数据目录中运行真实 Launcher/Node 进程，覆盖并发启动、两个启动顺序、前台退出、原生启动参数、存储复用、后台崩溃后的旧子进程退出和不重发。发行测试验证仓库外的认证 Web 自动启动同一后台、晚到客户端收敛及无重复 Adapter。原生 Codex 进程测试是模拟协议，不调用真实 Codex CLI；不发送真实模型消息或真实审批。覆盖认证/同源隔离、GUI 与 Web 消息广播、完整热状态、并发输入、审批竞争、提问恢复、配置/停止、请求去重、通知窗口、读取竞态以及 epoch 切换后的新 baseline。测试并不代表所有 Harness、操作系统、后台任务投影或移动真机能力已验收。更新运行中的 Desktop 必须另行安排，源码通过验证不等于旧进程已启用新通道。
