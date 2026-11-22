# Host Runtime 日志

Host Runtime 的 stderr 由 Codex Desktop 接管，Desktop 只保留最后一行，`npm start` 也会在就绪后脱离终端。因此 Runtime 把自己的诊断输出另存一份到文件，崩溃后仍有据可查。

- 位置：`<数据目录>/logs/host-runtime-<进程号>.log`，数据目录为 `CODEXHOST_DATA_DIR`，未设置时是 `~/.codexhost`。
- 始终开启，无需配置。每个进程独立写入和轮转，避免多个 Runtime 争用同一文件。单个文件上限 5 MiB，超过后轮转为同名 `.log.1`，每个进程至多保留一份旧文件；单次输出超过上限时只保留末尾完整 UTF-8 字符。
- 每行带 UTC 时间和进程号。Runtime 启动及轮转时会按修改时间清理旧的 `host-runtime-<进程号>.log[.1]`，为当前文件预留空间，并将这类日志控制在 20 个文件、50 MiB。仍在运行的进程会保留当前文件，因此并发 Runtime 很多时可能暂时超过上限；同目录的其他诊断日志不参与清理。
- 日志目录使用 `0700`、当前文件与轮转文件使用 `0600`；启动时也会收紧已有对象的权限（权限位按平台支持生效）。

记录内容：

- Runtime 写到 stderr 的诊断（`codexhost Host Runtime: ...` 等）；
- 未捕获异常与未处理 Promise 拒绝的完整堆栈（`FATAL <来源>: ...`），记录后进程仍按原样退出，行为不变；
- Runtime 启动与退出码。

委派 CLI 等短生命周期子命令不写这个文件，它们按原契约把错误写到自己的 stderr。

写日志或清理失败（目录不可写等）会被忽略，不影响 Runtime。

## Web 会话目录慢查询

### 默认行为与开启方式

`Server-Timing` 响应头始终保留。在浏览器开发者工具的 Network → `session/list` → Timing 中，可以直接查看各阶段耗时，无须开启日志。

详细性能 JSON 日志默认关闭。只有进程环境变量 `CODEXHOST_TRACE_SESSION_LIST=1` 才开启以下三类记录：

- Web：`[session/list]`，输出到 Web 服务的标准输出。
- Host 聚合目录：`[thread/catalog/read]`。
- Host 混合分页：`[thread/list]`。两类 Host 记录写入上面的 Runtime 日志文件。

关闭详细记录不影响 RPC 错误返回、已有错误／崩溃日志。列表请求失败时仍输出简短的 `request failed` 错误记录，不附带性能 JSON 或会话内容。

从源码同时启用 Web 和共享 Host 的记录（macOS / Linux）：

```bash
CODEXHOST_TRACE_SESSION_LIST=1 npm start -- web --restart-host
```

PowerShell：

```powershell
$env:CODEXHOST_TRACE_SESSION_LIST = "1"
npm start -- web --restart-host
```

**重启 Host 会中断其任务，应在任务结束后执行。** 环境变量必须传给实际运行服务的进程；给新终端设置变量不会改变已经运行的 Host。只诊断 Web 时可用 `--keep-host` 替代 `--restart-host`，但 Host 的开关保持不变。Launcher 会将此变量传给它启动的 Web／Host 服务。

排查结束后，使用相同启动方式将变量设为 `0`，或移除变量并重新启动对应服务，即恢复默认关闭。例如：

```bash
CODEXHOST_TRACE_SESSION_LIST=0 npm start -- web --restart-host
```

手工保存的 `session-list-probe-*.json`、`official-thread-list-probe-*.json` 只是测量结果，不是功能依赖，可单独删除；不要为清理它们而删除会话数据、认证文件或整个日志目录。

### Web 请求记录

开启后，每个 `session/list` HTTP 请求输出一条 JSON，以 `rpcId` 对应浏览器请求。`stages` 记录累计毫秒、次数 `calls` 和最慢一次 `maxMs`，包括 `workspace_wait`、`catalog_wait`、`summaries`、`serialize` 和 `compress`。`catalog` 记录共享任务的 `host_catalog`、`pins`、`project_definitions`、`projects`、`workspace_sync`、`archive_sync` 和 `catalog_publish`，以及已加载条目计数（不是历史总数）；`mode` 为 `started` 或 `joined`。共享任务可能早于当前请求开始，不能将其耗时与外层等待相加。`pins` 记录原生置顶列表等待；首批还会等待缺失置顶摘要的有界补读。项目定义与目录、置顶并行，已加载 Thread 的分配关系在摘要就绪后读取。

`responseBytes` 为未压缩 JSON 的 UTF-8 字节数，`encodedBytes` 为编码后的响应体字节数，不含 HTTP 头。计时从 RPC 信封解析后开始，覆盖处理、序列化与压缩，不包括认证、请求体读取、网络下载。`Server-Timing` 使用同一组计时，`catalog_*` 是共享任务的内部阶段。不记录会话 ID、标题、正文、路径或完整响应；Web 不额外创建诊断文件。

### Host 分页与聚合记录

开启后，客户端通道的原生／外部混合 `thread/list` 每页完成后输出一条 `[thread/list]` JSON 记录，失败也保留已执行的阶段。直接使用该分页接口的客户端读取多页时，会对应多条 Host 记录。Web 的首批和显式续页使用下面的目录接口；加入已有目录刷新时，Web 与 Host 的时间区间也可能不同。`requestId` 是 Host 内部请求 ID，不是浏览器的 `rpcId`；按时间、`archived` 和 `hasCursor` 查看同一轮查询，不把同一个共享任务重复累加。此诊断不覆盖原样转发的官方查询、分区排序查询或委派列表。

- `store`：读取 Mapping Store 记录与分区位置；`shared_catalog`：读取共享外部目录（配置该来源时）。
- `aggregate`：整页聚合总耗时，其内部包括 `external`（外部元数据投影、过滤、排序）、`official_page`（正常官方页请求）、`official_cursor_repair`（为准确续页游标重查已消费前缀）。内外层计时不能相加。
- 每阶段记录累计毫秒 `ms`、次数 `calls` 和最慢一次 `maxMs`。`officialCalls` 按调用顺序记录每次官方请求的类型、limit、是否有游标、耗时、返回条数及成功状态，受聚合器每页最多 256 次官方调用的现有限制约束。耗时覆盖官方调用的等待，不等于 Codex CPU 执行时间。
- `counts` 记录 Mapping Store、分区位置、共享目录、外部候选和最终返回条数；`officialUnavailable` 标记官方程序不可用而沿用外部目录回退的次数，避免把空回退当作成功读取了原生目录。
- 不记录游标值、查询目录、标题、会话 ID、正文、完整请求或上游错误内容。日志沿用上述文件、权限和轮转规则，写诊断失败不改变 RPC 结果。

Web 使用的 `codexhost/thread/catalog/read` 每次完成输出一条 `[thread/catalog/read]` JSON 记录：`includeArchived` 标明请求范围，`officialUnavailable` 标明是否因初始化阶段明确不可用而仅返回外部目录，`returnedRows` 为去重后的条目数。`sources` 分别统计本地元数据、共享目录、官方初始化及未归档／归档查询的累计耗时、请求次数和成功状态。官方每个未结束的请求分支只读一页 20 条，按更新时间倒序；普通刷新不遍历历史，归档分支仅在显式请求时读取。原生置顶分区查询不等于全局历史扫描。来源之间可并行，不将其耗时相加作为总耗时；`totalMs` 是整次聚合等待。此记录同样不包含会话内容、标识或游标，诊断失败不改变响应。

Host 内部诊断需要更新并重启共享 Host，仅重启 Web 不会生效。重启 Host 会中断其任务，应在任务结束后进行。
