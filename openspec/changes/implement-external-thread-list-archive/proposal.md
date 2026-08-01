## Why

当前 Mapping Store 已能持久化并恢复已知 External Thread，但 Host 尚未把这些记录聚合到 Codex Desktop 的 Thread 列表，也不能持久化 Archive/Unarchive 状态。结果是外部会话虽然可以通过已知 ID 重新打开，却还不是可在侧边栏中稳定发现和管理的一等 Thread。

## What Changes

- 让 Mapping Store 提供 External Thread 管理元数据列表，并原子更新归档状态，继续保持 Native Session 为完整历史的唯一事实源。
- 由 Host 接管 `thread/list`，按当前 Codex 协议的筛选、排序和分页语义合并官方 Codex Thread 与 External Thread。
- 由 Host 按资源归属接管 External `thread/archive` 和 `thread/unarchive`，持久化成功后再返回响应和发布通知，不修改或删除 Native Session。
- 列表、归档和恢复归档只读取 Mapping Store，不批量打开 Harness Session，也不持久化消息正文、Tool 输出、Diff、Usage 或 Codex 投影。
- 对当前 Desktop 新增但本次不支持的 Pin 元数据诚实降级：External Thread 投影为未固定，相关查询正确过滤；引用 External Thread 的不支持管理操作明确失败，不得回落到官方 Codex。
- 本次不实现 Detach、`trash/`、格式迁移器、History Projection Store、全文搜索或持久化 Transcript。

## Capabilities

### New Capabilities

- `external-thread-list-archive-routing`: 定义官方与 External Thread 列表聚合、稳定分页、Archive/Unarchive 路由、通知顺序和不支持管理操作的 fail-closed 行为。

### Modified Capabilities

- `external-thread-mapping-store`: 增加 External Thread 管理元数据枚举和归档状态原子更新要求，并保证这些操作不读取或保存 Native Transcript。

## Impact

- `packages/mapping-store`：扩展 Store 接口、原子归档更新和持久化测试。
- `packages/host-runtime`：增加 External Thread 元数据目录、列表聚合、官方响应关联、Archive/Unarchive 路由和通知。
- `packages/protocol-core`：增加当前 Thread 管理请求、列表参数和 Host cursor 的有界解码与运行时校验。
- `packages/renderer-extension`：原则上不新增页面 UI，只消费 Codex Desktop 现有列表与归档入口；若当前协议新增管理操作引用 External Thread，保持 fail closed。
- 测试覆盖 Mapping Store 重启恢复与写入失败、Metadata-only 列表、筛选排序、双来源多页合并、Archive/Unarchive、Codex 透明转发和 Native Session 保留。
