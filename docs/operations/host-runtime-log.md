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

客户端通道的原生／外部混合 `thread/list` 每页完成后输出一条 `[thread/list]` JSON 记录，失败也保留已执行的阶段。Web 的 `session/list` 会读取多页，所以一次 Web 请求可对应多条 Host 记录；加入已有目录刷新时，两者的时间区间也可能不同。`requestId` 是 Host 内部请求 ID，不是浏览器的 `rpcId`；按时间、`archived` 和 `hasCursor` 查看同一轮查询，不把同一个共享任务重复累加。此诊断不覆盖原样转发的官方查询、分区排序查询或委派列表。

- `store`：读取 Mapping Store 记录与分区位置；`shared_catalog`：读取共享外部目录（配置该来源时）。
- `aggregate`：整页聚合总耗时，其内部包括 `external`（外部元数据投影、过滤、排序）、`official_page`（正常官方页请求）、`official_cursor_repair`（为准确续页游标重查已消费前缀）。内外层计时不能相加。
- 每阶段记录累计毫秒 `ms`、次数 `calls` 和最慢一次 `maxMs`。`officialCalls` 按调用顺序记录每次官方请求的类型、limit、是否有游标、耗时、返回条数及成功状态，受聚合器每页最多 256 次官方调用的现有限制约束。耗时覆盖官方调用的等待，不等于 Codex CPU 执行时间。
- `counts` 记录 Mapping Store、分区位置、共享目录、外部候选和最终返回条数；`officialUnavailable` 标记官方程序不可用而沿用外部目录回退的次数，避免把空回退当作成功读取了原生目录。
- 不记录游标值、查询目录、标题、会话 ID、正文、完整请求或上游错误内容。日志沿用上述文件、权限和轮转规则，写诊断失败不改变 RPC 结果。

Host 内部诊断需要更新并重启共享 Host，仅重启 Web 不会生效。重启 Host 会中断其任务，应在任务结束后进行。
