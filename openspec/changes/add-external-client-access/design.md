# Design

## Context

本设计服务于 [proposal](proposal.md)，涉及新的网络监听、凭据、持久化格式和对外协议，因此单独写出。

现状：`run-host-runtime` 为每个 Runtime 生成随机令牌，在随机端口启动委派控制服务，只把端点和令牌放进 Host 拉起的进程环境。`DelegationControlRegistry` 汇总多个 Host 会话；`delegate start` 没有父 Thread 时，靠“唯一存在活跃 Turn 的会话”推断来源。委派关系以每条一个 JSON 文件的严格 v1 格式存在映射存储中。控制台（`console-control-server`）已有“仅当前用户可读的描述文件 + 令牌”的发现模式。

## Decisions

### 1. 外部监听独立于内部控制服务

```text
Host 拉起的进程 ── 内部令牌 ──▶ 内部控制服务（随机端口，不变）
                                    │
外部 CLI / MCP 客户端 ── 客户端令牌 ──▶ 外部监听（127.0.0.1:4398）
                                    │
                         DelegationControlRegistry（共用）
```

两个入口共用同一个 Registry，因此语义一致；认证和路由各自独立。放弃的方案：

- **复用内部服务并把端口固定。** 内部令牌会暴露给 Host 之外的进程，也无法区分调用方。
- **只用描述文件、端口随机。** MCP 客户端配置需要固定 URL，每次重启都要改配置。
- **放在控制台进程里代理。** 多一跳；控制台和 Runtime 生命周期不同，Runtime 未运行时还会让人误以为“已连接”。

描述文件只用于 CLI 零配置发现，并在端口被改动时纠正；它不含令牌，泄露也不构成凭据泄露。

### 2. 客户端登记与令牌

令牌由 32 字节随机数编码而成，只在 `client add` 时输出一次。存储只保留加盐哈希、名称和登记时间，放在 Runtime 私有状态目录，权限 0600。比对使用恒定时间比较。CLI 从 `CODEXHOST_CLIENT_TOKEN` 或 `CODEXHOST_CLIENT_TOKEN_FILE` 读取令牌，不接受命令行参数，以免进入 shell 历史。本提案中所有客户端拥有完整权限，权限范围留给远程提案。

### 3. 客户端作为父来源，引用另存

客户端发起的无父委派以 `client:<name>` 作为父标识，写入普通的 v1 Delegation 关系。这样：

- 幂等（Request ID 与时间窗去重）、`thread list --client <name>`（等价于按该父标识列举）、重复请求返回原结果都沿用既有路径；
- Delegation 记录格式不变。标识是不透明字符串，旧版本只把它当作一个不存在的父 Thread，回滚不会丢弃记录；
- 同一个标识也是客户端 watch 的被通知方（见决策 5）。

`client:` 前缀不会与真实 Thread 标识冲突。外部监听只允许客户端以自己的名称作为来源或被通知方。

引用需要新字段，按 Thread 另存于 `<数据目录>/thread-refs/`，以 Thread 标识的摘要命名文件；Registry 在 `start`/`read`/`wait`/`list` 的结果中附加，没有引用时不加字段，既有输出不变。最初设想的 `origins/` 记录因此不再需要。

### 4. 无父委派的路由

经外部监听且未指定父 Thread 时，不走活跃 Turn 推断，而是选择本机 Desktop 会话。只有远程 SSH 会话或多个本机会话无法区分时返回歧义错误，并在错误中给出可选的 Host 标识。

### 5. 事件日志

每个客户端一个追加写的 JSONL 文件，事件标识按客户端单调递增，并把当前最大标识持久化，以免重启后重复使用。保留期默认 7 天，按天分段文件，过期整段删除。写入在 watch 投递路径上完成：被通知方为客户端时，“投递”就是追加一行并 fsync；成功即视为送达，因此客户端 watch 没有忙碌重试。PR 1 的至少一次语义在这里表现为：重启后可能追加内容相同、标识不同的事件，客户端按 Thread 与来源 Turn 去重。

SSE（`GET /v1/events`）与 long-poll（`POST /v1/events/poll`）都只是这份日志的读取器，彼此之间不保存状态。SSE 心跳间隔 25 秒。

### 6. MCP

使用 Streamable HTTP 传输，挂在外部监听的 `/mcp`，按最小子集自行实现（`initialize`、`ping`、`tools/list`、`tools/call`；`GET` 返回 405，`DELETE` 结束会话），不引入 SDK。工具名使用下划线风格（`delegate_start`、`thread_read`、`events_poll` 等），输入 schema 与 CLI 参数一一对应，结果直接返回 CLI 的 JSON 输出。服务端不依赖 MCP 的服务端推送来交付事件，因为多数 MCP 客户端不处理这类通知；需要实时事件的客户端使用 SSE。

## Risks / Trade-offs

- [固定端口冲突] → 冲突时只停用外部监听并在诊断中提示，Desktop 不受影响。
- [本机其他进程扫描端口] → 没有令牌就无法调用；错误响应不透露客户端名称。
- [客户端拥有完整权限] → 本提案只监听 127.0.0.1；跨机器访问前由远程提案引入权限范围。
- [事件日志增长] → 按天分段并按保留期删除；单客户端每天的事件数受 watch 数量限制。

## Migration

无需迁移：没有引用记录的 Thread 视为没有引用。回滚时引用存储、事件日志和客户端登记文件被旧版本忽略；以 `client:<name>` 为父的 Delegation 关系仍是有效的 v1 记录。重新升级后继续可用。
