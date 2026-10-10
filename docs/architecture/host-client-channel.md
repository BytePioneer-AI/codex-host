# CH 客户端通道 v1

## 所有权与入口

GUI、Web 和其他 App 操作同一个 `AppServerHost`。Adapter、原生引用、Mapping Store 和 Thread/Turn 执行仍由原 Host 管理。客户端通道不启动 Harness、不拥有第二份 Mapping Store，也不保存 transcript。

- `shared-contracts/client-channel` 定义浏览器安全的版本、游标、快照和交互契约。
- `host-runtime` 提供本地认证 HTTP 通道，复用原请求分派、投影器、配置观察器和交互响应路径。
- `desktop-control` 的公共 `HostClientChannel` 负责 Node 端发现、通知恢复和只读快照访问；命令不自动重试。
- `web-server` 一方面投影到现有 DSH UI，另一方面提供 `/api/ch/v1/*` 通用客户端网关。原生 App 可以消费此协议，不必实现 DSH 渲染日志、Adapter 或新的同步所有者。

当前生命周期接入 Launcher 启动的本地 Desktop Host，跟随该 Host 启停。远程/shared-socket 服务、脱离 Desktop 的常驻所有者和移动端后台推送不是此版本的能力。GUI 项目归属仍通过既有 CDP 只读读取，不把执行 `cwd` 当作项目。

## 认证与传输

Host 只监听 `127.0.0.1`，使用随机 Bearer token，拒绝带 Origin 的直接浏览器请求。私有描述文件位于 `$CODEXHOST_DATA_DIR/client-hosts`，默认 `~/.codexhost/client-hosts`，文件权限为 `0600`；PID 和 epoch 区分不同实例。发现时验证存活 PID、文件类型、大小和 Unix 所有者/权限，并通过打开的文件句柄校验，拒绝符号链接。描述文件不是会话索引。

浏览器/App 使用 Web 原有 Cookie/Bearer 认证及同源防护；Host 私有 token 不下发给客户端。公网使用仍需 TLS/可信网络部署，移动端仍要实现凭据保管、挂起恢复和通知生命周期。开发用 `--no-auth` 不应暴露到不可信网络。

| 操作 | Host 本地路径 | Web/App 路径 |
| --- | --- | --- |
| 通知 | `GET /v1/events?epoch=…&after=…` | `GET /api/ch/v1/events?epoch=…&after=…` |
| 受限 RPC | `POST /v1/rpc` | `POST /api/ch/v1/rpc` |
| Thread 快照 | `POST /v1/snapshot` | `POST /api/ch/v1/snapshot` |
| 回答交互 | `POST /v1/respond` | `POST /api/ch/v1/respond` |

POST 使用 JSON，正文上限 1 MiB；返回 `{result: …}` 或 `{error: {code, message}}`。RPC 参数为 `{method, params}`，快照参数为 `{threadId}`，回答参数为 `{epoch, threadId, requestId, result}`。可用 RPC 在 `CLIENT_CHANNEL_METHODS` 中；不允许 `thread/resume`、官方 Codex 创建或非本地 external Thread 操作。具体 Harness 能力仍须通过已有 inspect 契约查询，不能因 RPC 在名单内便假定该 Harness 支持它。

通知是 `application/x-ndjson`，空行是心跳，不是事件。慢消费者超过有界写缓冲时断开，不能阻塞 GUI。Node 通道断线重新发现描述文件；网关在底层 Host 离线时结束 App 的通知流，App 可携带游标重新连接。

## 通知、快照与恢复

通知有两种形状：

- `hello {version: 1, cursor: {epoch, sequence}, reset}`。
- `changed {cursor: {epoch, sequence}, threadId, method}`。

**changed 是失效通知，不是可追加的 token。** 首次先建立订阅，再取快照；读取期间收到新通知必须再校验。快照给出同一 Host 的元数据、最近 5 轮 full/desc、下一页 cursor、生效配置和当前待处理交互。热会话在不让出执行权的同步步骤中复制已接受状态及通知水位；状态可以包含尚待发出的后续通知所描述的变化，因此禁止把通知当增量再次拼接到快照上。

Host 和 Node 网关分别保留最近 512 条轻量通知。游标仍在窗口中时，`hello.reset=false`，随后重放大于旧游标的通知；hello 的 cursor 是本轮重放终点，不应在处理重放前覆盖旧消费游标。窗口不足、游标超前或 epoch 不同时，`reset=true`，重新读取所需 Thread 的快照。每次重连都重新校验已关注的 Thread，包括仍待处理的交互；不需要持久事件队列。

Web 将同一 Thread 的变化按 100ms 合并，读取中再次变化会安排后续读取，只对仍有 follow 的 Thread 读取正文。事件模式不运行原来的 1.5 秒历史轮询。Host 换代时退役旧 Web 展示流，以高于旧游标的新内存序号重新打开；客户端保留旧正文直到新的权威 baseline 到达，即使恢复后的原生 Turn/Item ID 改变，也不将其追加成重复消息。较早历史继续走原生分页，不为了同步一次读取全部历史。

同一 Host 内检测到原尾部消失或非追加正文改写时，旧展示缓冲失效并报告错误，重新打开页面取得当前历史；不把历史重写伪装成连续追加。v1 尚不是逐 Item patch/token 的低带宽协议，长工具输出快照仍可能较大。目录仍保留全量查询及差量发布；每 10 秒校验 GUI 项目元数据，项目变化不保证消息级即时性。

## 输入、工具与交互

Desktop 专用 `CodexTurnProjector.pendingTurn()` 不包含所有进行中的 Item，不能用作通用客户端完整快照。`snapshotTurn()` 复用同一投影器的 Item 状态，提供 Reasoning、命令输出及工具状态；原 Desktop 通知形状保留。Host 接受的普通用户输入保留给快照；来自客户端通道的输入还沿既有 shared-Thread 投影方式广播给 GUI。`clientUserMessageId`/`clientId` 关联用于撤下 Web 乐观回显，不能靠相同文本猜测确认。

审批与提问使用 Host 中现有 request ID，并绑定 epoch、Thread。Web 显示原生 action/选项标签，结果仍由 Host 的原有投影解析器校验。第一份有效响应在异步执行前认领，后续响应不重复调用 Harness；`serverRequest/resolved` 使其他 GUI/Web 卡片撤下。`{resolved:true}` 只表示请求已不再待处理，不证明当前客户端的答案获胜，更不代表工具执行成功。

断线会撤下 Web 的交互卡片，不自动回答或拒绝 Harness；重新连接只恢复快照中仍 pending 的请求。配置通知只报告观察器已接受的实际状态，多个配置命令不被包装成一个虚假的原子事务。草稿、阅读位置、输入框内容与当前选中 Thread 留在各端。

## 写操作边界

- 一个客户端 RPC 只提交一次；超时、响应断开或结果不明时不得自动重发。
- `turn/start` 以 Thread + `clientUserMessageId` 在当前进程内去重，相同 ID 不同输入拒绝；最多保留 256 条回执，不驱逐仍进行中的请求。确定未提交的参数错误/忙碌拒绝可释放回执；未知结果保留在窗口内。
- 这是有界、进程内的回执，不是跨 Host 重启、窗口驱逐或历史恢复的持久 exactly-once 保证。
- 原生历史刷新后，可在回执窗口内补回已接受输入的 `clientId`，不建立持久消息映射。
- 写入已确认后，随后的快照读取失败不会改报成“发送被拒绝”。
- 同时发送服从现有 Host/Harness 的忙碌、队列或 Steering 语义；不会另开 Adapter 伪造并发。

## 验证范围

使用真实 Host 类、公共 Node 客户端、临时 HTTP 服务、Fake Harness 和双浏览器验证；不发送真实模型消息或真实审批。覆盖认证/同源隔离、GUI 与 Web 消息广播、完整热状态、并发输入、审批竞争、提问恢复、配置/停止、请求去重、通知窗口、读取竞态以及 epoch 切换后的新 baseline。测试并不代表所有 Harness、操作系统、后台任务投影或移动真机能力已验收。更新运行中的 Desktop 必须另行安排，源码通过验证不等于旧进程已启用新通道。
