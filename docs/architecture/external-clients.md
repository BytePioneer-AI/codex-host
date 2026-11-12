# 外部客户端

外部客户端是不由 Host 拉起、但需要委派和跟进工作的本机进程，例如终端脚本、Claude Desktop、常驻 bot 的本机代理。它们通过一个固定端口的本机监听使用与 Host 内部相同的委派与 Thread 操作，并以持久事件日志获得完成通知。行为契约见 `openspec/changes/add-external-client-access`。

## 本机 CLI

同一系统用户运行的终端脚本或 bot 可直接使用 `codexhost harness`、`delegate`、`thread` 和 `events`，无需 `client add` 或令牌环境变量。Host 必须已运行且外部监听已启用，CLI 不会自动启动 Host。

- Host 成功开启本机监听后，原子写入 `<数据目录>/cli-credentials.json`（默认 `~/.codexhost/cli-credentials.json`），包含端点、短期令牌和进程信息。文件以 0600 创建；CLI 在 POSIX 上检查当前用户所有权和私有权限，并拒绝符号链接、非回环地址及已退出进程的凭据。Windows 依赖用户数据目录的 ACL，不能把数据目录设为其他用户可读写的共享目录。
- 该令牌只存在于当前监听的内存及私有凭据文件，不写入命名客户端注册表。Host 重启会更换令牌；正常关闭仅删除自己发布的凭据。原有 `external-client-endpoint.json` 仍不包含令牌。
- 自动认证的 CLI 共用 `client:local-cli` 来源及事件日志，可用 `thread list --client local-cli` 查找任务；`local-cli` 是保留名称。需要独立应用身份时，仍可显式登记命名客户端。
- 连接优先级：完整的 Host 注入参数 → 显式客户端令牌／令牌文件 → 本机私有凭据。部分缺失的 Host 参数仍报错，不自动改变内部会话身份；显式令牌无效时不会回退到本机凭据。
- HTTP／MCP 不免认证，仍须显式提供 Bearer 令牌。

## 登记与认证

- `codexhost client add <name>` 生成 `chc_` 开头的随机令牌并只输出一次；`client list` 列出名称与登记时间；`client remove` 立即吊销。
- 登记保存在 `<数据目录>/external-clients.json`（默认 `~/.codexhost`，仅当前用户可读写），只存加盐 SHA-256 摘要。CLI 直接编辑该文件，因此 Runtime 未运行时也能登记；Runtime 按文件修改时间重读，删除在下一次请求生效。
- 名称只允许小写字母、数字和连字符，同时用作事件日志的目录名；`local-cli` 保留给自动认证的本机 CLI。

## 监听与发现

- 本机共享后台 Host、本机 Desktop Runtime 与受管 Remote Host 均在 `127.0.0.1:4398` 提供外部监听；`CODEXHOST_EXTERNAL_CLIENT_PORT` 改端口，`off` 关闭。端口被占用时只停用外部监听并写诊断，Host 的其他功能不受影响。不要求 GUI 或 Web 页面保持打开，Remote Host 的委派使用其共享执行会话。
- Remote Host 的客户端登记、凭据与事件使用该 Host 的数据目录（默认 `~/.codexhost/remote/data`）。运行 `codexhost client` 时须使用相同的 `CODEXHOST_DATA_DIR`。
- 无界面的共享执行会话在首次原生 Codex 委派前协商官方协议；使用默认模型无需先查询模型目录或打开 Desktop。
- 监听只接受客户端令牌，不接受 Host 内部令牌；令牌缺失、未知或已吊销都返回相同的 `UNAUTHORIZED`，不透露客户端名称。
- Runtime 写出 `<数据目录>/external-client-endpoint.json`（端点、进程标识、启动时间，不含令牌），退出时只删除自己写的那份。
- CLI 有 Host 提供的连接参数时照旧使用；没有时，显式 `CODEXHOST_CLIENT_TOKEN` 或 `CODEXHOST_CLIENT_TOKEN_FILE` 经描述文件或配置端口连接外部监听；都未配置时读取本机私有凭据。没有可用凭据时提示启动或更新 Host，也可配置命名客户端令牌。
- Host 内部控制服务与外部监听共用 `routeDelegationRequest` 路由表，语义不会分叉。

## 客户端作为来源

客户端不是 Thread。它以 `client:<name>` 作为自己发起工作的父来源，也作为自己 watch 的被通知方：

- 外部监听把客户端未指定父 Thread 的 `delegate start` 补成 `parentThreadId: client:<name>`，未指定 `--notify` 的 `thread watch` 补成 `notifyThreadId: client:<name>`；指向其他客户端的值被拒绝。
- 这类委派写入普通的 v1 Delegation 关系，父标识为 `client:<name>`。幂等重试、`thread list --client <name>`（即按该父标识列举）沿用既有路径；旧版本读取时只是一个不存在的父 Thread，不会丢弃记录。
- 客户端没有自己的工作目录，所以无父委派必须给出 `--cwd`；Registry 把它交给共享 catalog 或唯一的 Host 会话，无法唯一确定时返回 `PARENT_THREAD_AMBIGUOUS`。
- 经外部监听且未给 `--cwd` 的 `thread list` 不限定工作目录。

## 引用

- `delegate start --ref <uri>`（可重复）为新 Thread 记录来源链接。值必须是绝对 URI，去除其中的用户名口令后保存，每个 Thread 最多 16 个；子委派先继承父 Thread 的引用，再追加自身引用，超出上限时优先保留自身引用。
- 引用保存在 `<数据目录>/thread-refs/`，每个 Thread 一个以其标识摘要命名的私有文件；Registry 在 `start`、`read`、`wait`、`list` 的结果中附加 `refs`，没有引用时不加该字段。
- `thread list --ref <uri>` 扫描引用存储，按最近写入排序，并从各自会话读取状态与标题（及创建时记录的工作目录）；已删除的 Thread 被跳过。

## 事件

- 被通知方为客户端的 watch 停下时，Host 不启动 Turn，而是在 `<数据目录>/client-events/<name>/<UTC 日期>.jsonl` 追加事件，写入并 fsync 后才算投递。事件只含标识、时间、结果、来源 Turn、Harness、深度链接与引用，不含会话内容。
- 事件标识由时钟（微秒）派生，在进程内严格递增，重启后从已有最大值之上继续。多个 Runtime 共用数据目录时标识可能交错，但不会重复使用同一进程内的值。
- 整日超过保留期（默认 7 天，`CODEXHOST_CLIENT_EVENT_RETENTION_DAYS`）的文件被删除，删除范围记在 `pruned.json`；早于该范围的游标返回 `CURSOR_EXPIRED` 与当前最早事件标识，客户端用 `thread list --client` 对账。
- 崩溃留下的半行被跳过，下一次追加先补换行，不会吞掉新事件。
- 读取方式：`GET /v1/events`（SSE，按 `Last-Event-ID` 或 `?after=` 补发后推送，25 秒心跳；客户端被删除后在心跳时关闭）、`POST /v1/events/poll`（long-poll，最多等 60 秒）、`codexhost events [--after] [--follow]`。三者都不带游标时从保留的最早事件开始补发，客户端应保存最后一个事件标识，下次从它之后读取；事件标识也可用于去重。

## MCP

外部监听在 `/mcp` 以 Streamable HTTP 提供 MCP：每个 POST 携带一条 JSON-RPC 消息并以 JSON 应答；`GET` 返回 405（不提供服务端主动流，推送用 `/v1/events`），`DELETE` 视为结束会话。工具与 CLI 一一对应：`harness_list`、`harness_inspect`、`delegate_start`、`thread_read`、`thread_wait`（最多 60 秒）、`thread_list`、`thread_send`、`thread_cancel`、`thread_watch`、`thread_watches`、`events_poll`。工具结果同时以文本和 `structuredContent` 返回 CLI 的 JSON；委派错误作为 `isError` 结果返回相同的错误代码。实现不依赖 MCP SDK。

## 接入示例

- Claude Code：`claude mcp add --transport http codexhost http://127.0.0.1:4398/mcp --header "Authorization: Bearer <token>"`。
- Claude Desktop：设置里的自定义 connector 由 Anthropic 云端连接，访问不到 `127.0.0.1`；本机 `claude_desktop_config.json` 的 `mcpServers` 只支持 stdio。用 `mcp-remote` 桥接：

  ```json
  {
    "mcpServers": {
      "codexhost": {
        "command": "npx",
        "args": ["-y", "mcp-remote", "http://127.0.0.1:4398/mcp", "--header", "Authorization:${CODEXHOST_AUTH}"],
        "env": { "CODEXHOST_AUTH": "Bearer <token>" }
      }
    }
  }
  ```

  修改后重启 Claude Desktop。token 放在 `env` 中，避免出现在进程参数里时被拆分。

## 权限范围与网络

- 每个客户端有权限范围 `read`（读取、列举、等待、watch 列表、事件）或 `dispatch`（另含委派、发送、取消、注册 watch），以及允许的网络 `local`、`tailnet`、`public`。没有这两个字段的旧登记视为 `dispatch` + `local`。`client add|set --scope --network` 修改，下一次请求生效。
- 请求的网络由它到达的监听决定，不看请求内容。不允许的网络返回与未知令牌相同的 `UNAUTHORIZED`；`read` 客户端调用派发路由返回 `FORBIDDEN`（HTTP 403，MCP 中为工具错误）。事件流在心跳时检查网络，收窄后关闭。
- 客户端通过校验的请求会记录最近访问网络与时间（`lastAccess`，按 5 秒节流写入 `external-clients.json`），供 `client list` 与控制台展示。
- 登记、权限修改、撤销与访问时间回写使用同一跨进程文件事务；访问记录不会恢复已删除的客户端或覆盖收紧后的权限。

## tailnet 与公网

- `client access --tailnet on|off --public on|off` 或控制台外部客户端页面写入 `<数据目录>/external-client-access.json`，两者默认关闭。运行中的 Runtime 每 30 秒按它和 Tailscale 状态调整监听，并把实际状态写入 `external-client-access-status.json`，`client access` 与控制台外部客户端页面会一起显示。
- 控制台外部客户端页面（`/api/external-clients`、`/api/external-clients/access`）直接读写数据目录中的状态与登记文件，展示本机、tailnet、公网监听状态与 Funnel MCP URL、开关、已登记客户端的权限/网络范围、最近访问及 webhook 投递状态，不返回任何令牌或密钥，且在 Desktop 未运行时同样可用。
- tailnet：在本机 Tailscale IPv4 地址上使用与本机监听相同的端口；地址变化时重新绑定，Tailscale 不可用时报告原因。
- 公网：一个独立的 loopback 端口，只由 Tailscale Funnel 的 `/codexhost` 路径转发过来，因此公网请求不可能被当作本机请求。Funnel 会剥离前缀，后端收到 `/mcp`、`/v1/...`。公网 MCP 地址是 `https://<机器>.<tailnet>.ts.net/codexhost/mcp`。codexhost 只添加和删除自己的路径，路径已指向非 loopback 目标时报告不可用而不替换；关闭公网后，或新 Runtime 发现上次留下的映射时删除它。
- Tailscale 通过其 CLI 操作（macOS 上也查找 `Tailscale.app` 内的 CLI，可用 `CODEXHOST_TAILSCALE` 指定）；两个开关都关闭时 Runtime 不调用它。
- 公网入口同时支持静态 `Authorization: Bearer <token>`（Grok Bot 等支持静态 header 的 connector）和基于一次性配对码的 OAuth 2.1 + PKCE（供只支持 OAuth 的托管 MCP connector 使用）：
  - 未认证请求返回 `401` 与 `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`，并在公网入口提供 `/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、`/oauth/register`（动态客户端注册）、`/oauth/authorize`、`/oauth/token`。
  - 用户在本机运行 `codexhost client pair <name>` 生成 10 分钟有效、仅可使用一次的配对码（保存在 `<数据目录>/external-client-oauth.json`，仅存加盐 SHA-256 摘要）；授权页只包含配对码输入框，不显示任何客户端、Thread 或工作目录列表；连续 5 次配对失败会使当前配对码立即失效。
  - 授权成功后签发的访问令牌（1 小时）与刷新令牌（30 天，轮换制）均以哈希保存并绑定到对应客户端，继承其权限范围；执行 `codexhost client remove <name>` 会立即使该客户端的全部访问令牌与刷新令牌失效。
  - 配对码与授权码的消费、刷新令牌轮换和撤销使用跨进程文件事务串行处理，CLI 与监听共用存储时不会覆盖彼此的修改。

## webhook 推送

- `client webhook <name> --adapter grok-bot --url <url>`，密钥来自 `--key-file` 或 `CODEXHOST_WEBHOOK_KEY`，保存在 `<数据目录>/client-webhooks/<name>.json`（0600），不显示也不写日志。新建的 webhook 从最新事件之后开始，不重放历史。
- Runtime 每 2 秒检查各客户端的新事件，按顺序推送；投递游标、重试次数与最近失败保存在 `<name>.state.json`，重启后继续。
- `grok-bot` adapter：`Authorization: Bearer <key>`，JSON 正文不超过 4 KB（引用过多时省略并标 `refsOmitted`），`Idempotency-Key: <client>:<事件标识>`。2xx 为已投递；429、5xx 与网络错误按 5 秒起翻倍、最长 15 分钟退避，最多 24 小时；其余 4xx 立即作为配置错误放弃该事件。推送失败不影响事件日志，客户端仍可按游标读取。

## 边界

- 本地监听只绑定 `127.0.0.1`；tailnet 与公网监听只在用户打开开关后存在，见上文。
- 外部客户端发起的 Thread 与其他 Thread 一样出现在 Desktop 侧栏；按客户端分组尚未提供。
- npm 安装没有自带 Node：在 codexhost 会话之外运行 `codexhost client`、`codexhost events` 等命令时，需要 `CODEXHOST_CLI_NODE_PATH` 指向一个 Node。MCP 与 HTTP 客户端不受影响。
