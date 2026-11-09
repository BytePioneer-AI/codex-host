# Tasks

依赖 `persist-thread-watches`。行为验收见 [external-client-access](specs/external-client-access/spec.md) 与 [cross-harness-delegation](specs/cross-harness-delegation/spec.md)，技术决策见 [design](design.md)。

## 1. 客户端与外部监听

- [x] 1.1 客户端登记、哈希存储与吊销（`client add|list|remove`）。验证：令牌只输出一次、存储中不出现明文、名称校验与冲突、吊销后请求被拒且 SSE 连接被关闭。
- [x] 1.2 外部监听（固定端口、可配置）与发现描述；只接受客户端令牌。验证：内部令牌被拒、端口冲突时 Desktop 正常且诊断给出提示、描述文件权限 0600 且不含令牌、退出时移除。
- [x] 1.3 CLI 的连接选择：Host 参数优先，否则使用客户端令牌连接外部监听。验证：两种来源的端到端调用；两者都缺失时报 `RUNTIME_UNREACHABLE`；不读取 PATH 上的其他 CLI。

## 2. 来源与引用

- [x] 2.1 客户端以 `client:<name>` 为父来源的无父委派、路由与幂等。验证：客户端委派不需要活跃 Turn；时间窗去重按客户端生效；多会话歧义时报错；记录仍是 v1 Delegation 关系（回滚兼容由格式不变保证）。
- [x] 2.2 `--ref` 的校验、凭据剥离与继承；`thread read`/`list` 输出引用；`thread list --client`/`--ref` 过滤。验证：继承链 A→B→C、上限与长度校验、凭据剥离、过滤与分页组合。
- [ ] 2.3 Desktop 侧栏可见性。验证：真实 Desktop 中客户端发起的 Thread 出现在对应工作目录下，可以打开、继续对话、取消。

## 3. 事件

- [x] 3.1 客户端事件日志：追加写入、单调标识、按天分段与保留期、`CURSOR_EXPIRED`。验证：重启后游标连续、过期段删除、保留期配置生效、客户端之间相互隔离。
- [x] 3.2 watch 被通知方为客户端的分支，以及 `--notify` 的缺省和校验。验证：调整方向、到期、unreadable 与 Thread 被通知方一致；指向其他客户端时报 `INVALID_ARGUMENT`。
- [x] 3.3 SSE 与 long-poll 读取器，以及 `codexhost events [--after] [--follow]`。验证：`Last-Event-ID` 补发不重不漏、心跳、long-poll 超时返回空、吊销时连接关闭。

## 4. MCP 与文档

- [ ] 4.1 `/mcp` 工具集，参数与结果复用 CLI 结构。验证：官方 MCP SDK 客户端完成列举、派发、等待上限 60 秒、事件读取与错误代码（已完成）；真实 Claude Desktop 或 Claude Code 作为 MCP 客户端完成一次派发、等待与读取（待在 Mac 上验收）。
- [x] 4.2 更新 `codexhost delegate --help`（`client`、`events`、`--ref`、`--client`）与 `docs/architecture/external-clients.md`、`thread-watch.md`、`docs/index.md`。验证：帮助与 CLI 测试。
