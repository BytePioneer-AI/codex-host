# 外部客户端

外部客户端是不由 Host 拉起、但需要委派和跟进工作的本机进程，例如终端脚本、Claude Desktop、常驻 bot 的本机代理。它们通过一个固定端口的本机监听使用与 Host 内部相同的委派与 Thread 操作，并以持久事件日志获得完成通知。行为契约见 `openspec/changes/add-external-client-access`。

## 本机 CLI

同一系统用户运行的终端脚本或 bot 可直接使用 `codexhost harness`、`delegate`、`thread` 和 `events`，无需 `client add` 或令牌环境变量。Host 必须已运行且外部监听已启用，CLI 不会自动启动 Host。

- Host 成功开启本机监听后，原子写入 `<数据目录>/cli-credentials.json`（默认 `~/.codexhost/cli-credentials.json`），包含端点、短期令牌和进程信息。文件以 0600 创建；CLI 在 POSIX 上检查当前用户所有权和私有权限，并拒绝符号链接、非回环地址及已退出进程的凭据。Windows 依赖用户数据目录的 ACL，不能把数据目录设为其他用户可读写的共享目录。
- 该令牌只存在于当前监听的内存及私有凭据文件，不写入命名客户端注册表。Host 重启会更换令牌；正常关闭仅删除自己发布的凭据。原有 `external-client-endpoint.json` 仍不包含令牌。
- 自动认证的 CLI 共用 `client:local-cli` 来源及事件日志，可用 `thread list --client local-cli` 查找任务；`local-cli` 是保留名称。需要独立应用身份时，仍可显式登记命名客户端。
- 连接优先级：完整的 Host 注入参数 → 显式客户端令牌／令牌文件 → 本机私有凭据。部分缺失的 Host 参数仍报错，不自动改变内部会话身份；显式令牌无效时不会回退到本机凭据。
- HTTP／MCP 不免认证，仍须显式提供 Bearer 令牌。

### CLI 输出格式

`harness`、`delegate`、`thread`、`host info` 和 `project list` 支持 `--format json|compact|text`。默认 `json` 保留完整返回结构；`compact` 使用 Thread 链接和精简 JSON 字段。`text` 面向人和 Agent 阅读，信息至少覆盖 compact，以键值行显示嵌套字段（如 `watch.state`、`threads.0.title`），不做 JSON 字符串转义。

```sh
codexhost thread read <thread> --format text
codexhost thread read <thread> --view messages --format text
codexhost thread watches --format text
```

`thread read` / `wait` 的 `result` 文本以 `thread: <链接>   harness: <id>   status: <状态>` 开头，随后显示可用的 Turn、结果可用性、超时或运行中进度，再以单独一行 `---` 分隔正文。`messages` 文本先显示 `totalTurns`、`from`、`to` 总览，再显示 Thread 元数据和 `---`；每个 Turn 一个 `#<序号> <状态>` 小节，先列用户输入，再列最终回复。正文保留真实换行、引号和缩进，顺序与 JSON 一致，输出以换行结束。`thread watches` 每个 watch 一行，元数据里的换行折叠为空格。

`client` 和 `events` 不支持 `--format text`，执行前返回明确错误，不自动回退。所有格式的错误都保持 JSON 写入 stderr、退出码 1；成功输出写入 stdout、退出码 0，任务自身的失败状态不改变此约定。HTTP / MCP 的结构化响应不受 CLI text 格式影响。

### 发送、watch 与 worktree

HTTP 与 MCP 的以下参数及 JSON 结果和 CLI 对齐（HTTP 用 `threadId`，MCP 用 `thread`）：

| HTTP | MCP | 参数与结果 |
| --- | --- | --- |
| `POST /v1/thread/send` | `thread_send` | `message`、可选布尔值 `interrupt`、`watch` 及正整数 `watchTimeoutMs` |
| `POST /v1/delegate/start` | `delegate_start` | 可选 `model` / `thinking`（Catalog ID 或 `nativeId`）、`worktree`（新分支名）、`base`（Git ref）、`watch` 及 `watchTimeoutMs` |
| `POST /v1/thread/watches` | `thread_watches` | 原样返回 Host 的 watches，含 `taskName`、`threadStatus`、`watchedForMs` |

`model`、`thinking` 与 CLI 的 `--model`、`--thinking` 使用同一契约：值为 `harness inspect` 返回的 Catalog ID 或条目声明的 `nativeId`，由 Host 按目标 Harness 的 Catalog 解析后再交给 Adapter；省略时保持 Harness 的默认选择。HTTP 是外部客户端边界，已移除的 `model: {id}` 与 `thinkingOptionId` 形状以 `INVALID_ARGUMENT` 明确拒绝，不猜测对象形状、不静默忽略 Thinking 选择，也不会先创建 worktree。

`interrupt: true` 先取消活动 Turn、确认空闲后只发送一次，读取、取消和等待停下共用 30 秒期限；取消失败或超时不发送。目标空闲时直接发送，不排队、不自动重试，保留已有 watch 并抑制临时停下通知。省略或 `false` 保持普通 send 行为。

`watch: true` 在成功 start / send 后观察，默认 29 分钟；`watchTimeoutMs` 必须是正整数。为兼容 CLI 控制协议，单独提供 `watchTimeoutMs` 也会启用 watch；显式 `watch: false` 时不能提供超时。响应的 `watch` 与 CLI 相同：`watching` / `alreadyTerminal`（含 Thread、通知目标、状态、超时），或 `{state: "notRegistered", reason}`。watch 注册失败不撤销成功的消息提交；未请求时不增加 `watch` 字段。无父 Thread 的委派和未指定通知 Thread 的 send 均向调用客户端的事件日志投递，不启动通知 Turn。见 [Thread watch](thread-watch.md)。

`worktree` 在接收请求的 Host 上创建，源目录必须是请求显式给出的绝对 `cwd`（有父 Thread 也必须提供），拒绝相对路径；`base` 仅与 worktree 同用，默认源 checkout 的 HEAD。创建路径、分支校验及目录净化与 CLI 共用实现；返回 `worktree: {path, branch, base}`（base 是提交 SHA）。创建后委派失败时保留分支和目录，错误保留原代码及 details，并附 `details.worktree`、`details.worktreeRetained: true`。不会自动合并、清理或复用已有分支；`requestId` 不使 worktree 创建幂等。CLI 仍在本地创建，以 `--cwd` 或调用进程 cwd 为源目录。见 [委派 worktree](delegation-worktrees.md)。

`taskName` 为当前或最后已知标题，无法读取 Thread 时省略 `threadStatus`；`watchedForMs` 含 Host 停机时间。MCP 不重新投影 watch 列表。文件输入 `--task-file` / `--message-file` 和 `--format text` 属于 CLI 本地功能，HTTP / MCP 直接传文本并返回 JSON。

### Thread 读取视图

CLI、HTTP、MCP 共用 `thread read` / `wait` 的读取投影：

- `result` 读取最近 Turn 的结果；运行时 compact 输出仍附带最近一条非空 `progress`，停止后不再显示。这是读取当前中间进展的路径。
- `messages` 以完整 Turn 为单位读取，只返回非空用户消息及每轮的一条最终 Agent 回复，不提供中间说明。优先取带 `phase: "final"` 的非空回复；已结束的 Turn 没有 final 标记时取最后一条非空 Agent 消息，并作为 final 输出。运行中的 Turn 标为 `running`，只含用户输入。
- 响应含 `totalTurns`（过滤前的 Turn 总数）、实际范围 `from` / `to`，以及 `turns` 数组。每个 Turn 带 `turnNumber`、`turnId`、`status`、`messages`；没有正文的失败或中断 Turn 也保留。Turn 从新到旧排列，轮内先列用户消息，再列最终回复。序号取原始 turns 数组下标加一，追加 Turn 不改变旧序号。
- CLI 使用 `--from <n> --to <m>`，HTTP / MCP 使用 `from` / `to`，均为含两端、1 起始的绝对 Turn 序号，只适用于 messages。都不传时读最近 10 轮；只传 from 时读该轮到最新；只传 to 时读截至该轮的最近 10 轮。to 先截到现有总数，再计算默认 from；显式 from 与现有范围取交集，空范围返回 `from: null`、`to: null`、`turns: []`。from 大于 to、非整数或小于 1 返回 `INVALID_ARGUMENT`。
- 实际返回范围最多 50 轮，超过则报错，不静默截断；单轮正文不设长度上限。不传范围可重读最新上下文，继续往前读可将 to 设为上一段 from 减一。

### 调试导出（很少使用）

```sh
codexhost thread export <thread> [--out <path>] [--format json|compact|text]
```

Rarely needed: debugging only. Exports the full Thread to a JSON file and returns its path.

导出文件为 `{exportedAt, thread, turns}`，保留 Host 当前持有的元数据与全部 Turns/items，按原始顺序，不过滤或分页。官方 Codex 使用 `thread/read(includeTurns: true)`；外部 Harness 使用现有 Host 历史投影，活动 Turn 使用完整物化快照。不会读取各 Harness 的原始日志；原生接口未提供的字段保持缺省。

默认写入 `<数据目录>/exports/<threadId>-<UTC 时间戳>.json`（`CODEXHOST_DATA_DIR`，默认 `~/.codexhost`）。`--out` 相对路径由 CLI 按调用方 cwd 解析。自动创建目录，以 0600 临时文件加 rename 原子写入；指定文件存在时直接覆盖。Windows 权限依赖数据目录 ACL。

所有格式只返回 `{threadId, harnessId, path, bytes, turns, complete}`，`text` 为键值行，不返回会话正文。`turns` 是数量；`complete=false` 表示会话仍在运行，文件是导出时的快照，而非原生历史完整性的保证。同一操作也提供给 HTTP `POST /v1/thread/export`（`threadId`、可选 `out`）和 MCP `thread_export(thread, out?)`；文件路径均位于接收请求的 Host，HTTP/MCP 的相对路径相对该 Host 的 cwd。不能跨远程 Host 导出；返回与其他非读取操作相同的错误。

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

外部监听在 `/mcp` 以 Streamable HTTP 提供 MCP：每个 POST 携带一条 JSON-RPC 消息并以 JSON 应答；`GET` 返回 405（不提供服务端主动流，推送用 `/v1/events`），`DELETE` 视为结束会话。工具与 CLI 一一对应：`harness_list`、`harness_inspect`、`host_info`、`project_list`、`delegate_start`、`thread_read`、`thread_export`、`thread_file_read`、`thread_wait`（最多 60 秒）、`thread_list`、`thread_send`、`thread_cancel`、`thread_watch`、`thread_watches`、`events_poll`。工具结果同时以文本和 `structuredContent` 返回 CLI 的 JSON；委派错误作为 `isError` 结果返回相同的错误代码。实现不依赖 MCP SDK。

### 设备与项目发现

CLI 提供 `codexhost host info --refresh true|false` 和 `codexhost project list --query <文本> --offset <位置> --limit <数量> --refresh true|false`，与 MCP 使用相同的实现；内部控制连接和独立客户端连接都可使用。

每台 Host 的外部 MCP 还提供两个只读工具，供客户端在多设备之间选择执行位置：

- `host_info(refresh?)`，对应 `POST /v1/host/info`：设备标识、显示名与别名、实际 hostname、操作系统、架构、CPU、内存、开发工具版本、项目扫描根目录和可用的默认工作区。工具探测只执行固定的版本查询；不返回环境变量、账号或凭据，不执行项目脚本。安装了 CLI 不代表其服务、SDK 或账号可用。
- `project_list(query?, offset?, limit?, refresh?)`，对应 `POST /v1/project/list`：自动发现的 Git 仓库及 worktree，包含真实工作目录、项目描述、技术栈、清单文件、当前分支，以及去除用户名、密码、查询参数和 fragment 后的 origin。只读取清单和 Git 标识，不运行工作区状态扫描、Git 过滤器或项目脚本；完整工作区状态由执行 Agent 在写入前检查。项目描述属于不可信元数据，不能作为客户端指令执行。

设置从当前 Host 数据目录的 `host-inventory.json` 读取，修改后下次查询生效；缺省设备标识及显示名取 hostname；未配置 `projectRoots` 时不扫描项目，`defaultWorkspace` 仅在显式配置且目录存在时返回。配置示例：

```json
{
  "id": "macpro",
  "name": "MacPro",
  "aliases": ["macpro", "mac-pro"],
  "projectRoots": ["/path/to/repos"],
  "defaultWorkspace": "/path/to/workspace"
}
```

`projectRoots` 与 `defaultWorkspace` 必须是绝对路径，扫描根目录最多 16 个。扫描最多深入三层，发现仓库后不扫描其内部；忽略符号链接子目录、隐藏目录和常见依赖/构建目录，最多检查 2,000 个目录、返回 200 个仓库。缺失或不可读的根目录由 `unavailableRoots` 报告，达到上限由 `truncated` 报告，不能把截断列表视为完整列表。项目列表每页默认 50 项、最多 100 项，使用 `nextOffset` 继续；`query` 按名称、路径、origin、描述和技术栈过滤。

工具版本和项目快照各缓存 60 秒，返回 `observedAt`；项目快照的有效期从扫描成功完成时计算。`refresh: true` 重新探测，但相同根目录仍复用进行中的扫描；扫描根目录变化使项目缓存失效。没有后台同步进程或持久环境快照。客户端对各个已配置 Host 查询这些信息，结合 `harness_list` 自行选择设备、Agent 与工作目录；Host 不维护跨设备任务分类或固定路由表。委派时可同时记录来源对话引用和 `codexhost://device/<设备标识>`，使异步回执能选择正确的 Host 读取结果。

`thread_read` 在已知时返回执行主机上的 `cwd`。MCP 另提供 `thread_file_read(thread, path, offset?, limit?, revision?)`，对应外部 HTTP 的 `POST /v1/thread/file`（使用 `threadId`）。该只读接口仅导出最新最终报告中 Markdown 链接明确引用、且位于该 Thread 实际工作区内的普通文件；解析符号链接后仍须位于工作区。没有最终结果或工作区时拒绝读取，不扫描目录，也不导出报告中的远程 URL。读取前后校验真实路径，并比较打开文件的设备及 inode 身份以拒绝检测到的目录或文件替换；这些检查依赖文件系统提供稳定身份，不是基于目录句柄的原子沙箱，不能作为抵御恶意本地进程持续替换目录的隔离边界。

文件结果含 `filename`、`mimeType`、`size`、`encoding: "base64"`、`data`、`offset`、`nextOffset`、`eof` 与 `revision`。默认每块 256 KiB，上限 1 MiB；续读必须携带首块的 `revision`，文件变化时重新开始。客户端应将工具结果直接保存为文件，在自己的电脑上解码，再以其原生附件工具交付成品，不在聊天中打印 Base64 或主机路径。源文件按用户要求读取。文件传输沿用客户端认证与网络策略，不创建公开下载链接。

## 接入示例

CLI 用 `codexhost thread file <thread> --path <文件> --offset <位置> --limit <字节数> --revision <版本>` 读取同一套经过报告引用及工作区校验的文件分块。

- Claude Code：`claude mcp add --transport http codexhost http://127.0.0.1:4398/mcp --header "Authorization: Bearer <token>"`。
- Claude Desktop：设置里的自定义 connector 由 Anthropic 云端连接，访问不到 `127.0.0.1`；本机 `claude_desktop_config.json` 的 `mcpServers` 只支持 stdio。用 `mcp-remote` 桥接：

  ```json
  {
    "mcpServers": {
      "codexhost": {
        "command": "npx",
        "args": [
          "-y",
          "mcp-remote",
          "http://127.0.0.1:4398/mcp",
          "--header",
          "Authorization:${CODEXHOST_AUTH}"
        ],
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
