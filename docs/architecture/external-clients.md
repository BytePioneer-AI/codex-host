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

## 边界

- 本地监听只绑定 `127.0.0.1`，所有客户端拥有完整的委派权限；tailnet、公网、权限范围与 webhook 推送见 `openspec/changes/add-remote-client-access`。
- 外部客户端发起的 Thread 与其他 Thread 一样出现在 Desktop 侧栏；按客户端分组尚未提供。
- npm 安装没有自带 Node：在 codexhost 会话之外运行 `codexhost client`、`codexhost events` 等命令时，需要 `CODEXHOST_CLI_NODE_PATH` 指向一个 Node。MCP 与 HTTP 客户端不受影响。
