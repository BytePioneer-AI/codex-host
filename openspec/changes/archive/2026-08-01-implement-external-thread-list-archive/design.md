## Context

当前 Mapping Store 以每个 Host Thread 一个严格 V1 JSON 文件保存 External Thread 的归属、Native Session 定位、Turn/Fork 映射和管理元数据。Store 已经提供进程内 `listThreads()`，V1 Record 也已经包含 `archived`，但 Host Repository 尚未暴露列表和归档更新；`thread/list`、`thread/archive`、`thread/unarchive` 仍会进入官方 app-server。

已知 External Thread 可以通过已知 ID 在 Host 重启后恢复，但 Desktop 侧边栏只能依赖官方列表发现 Thread。当前 Desktop `26.727.6591.0` 内置 `codex-cli 0.146.0-alpha.9.2` 的生成 Schema 还增加了 `Thread.isPinned`、`thread/list.isPinned` 和 `thread/metadata/update`。Pin 不属于当前 PRD，但引用 External Thread 的新管理请求仍必须遵守资源归属，不能落入官方 Codex。

列表聚合比单条资源路由更复杂：官方结果使用官方 opaque cursor，External 结果来自 Mapping Store，Host 必须在两种有序来源之间保持 limit、筛选、正反向分页和同时间戳稳定性，同时不能通过批量恢复 Native Session 获得 Preview 或状态。

## Goals / Non-Goals

**Goals:**

- 让 Mapping Store 原子保存 Archive/Unarchive，并提供只读 External Thread 管理元数据目录。
- 在不读取 Native Transcript 的前提下，将可恢复 External Thread 投影到当前 Codex `Thread` 列表形状。
- 聚合官方与 External `thread/list`，支持当前协议的筛选、排序、limit、next cursor 和 backwards cursor。
- 按持久化资源归属接管 External `thread/archive`、`thread/unarchive` 和相关不支持管理操作。
- 保持官方 Codex Thread 的原始行为、External Native Session 和现有实时/历史链路不变。

**Non-Goals:**

- Detach、`trash/`、Native Session 删除或导入/重新绑定。
- Pin、Git 元数据更新、全文搜索或 External Subagent 列表关系。
- V2 Record、通用迁移框架、SQLite 或 History Projection Store。
- 为列表持久化 Preview、Prompt、Transcript、Tool 输出、Diff、Usage 或 Codex Turn/Item。
- 为列表打开 Adapter、读取 Snapshot 或验证全部 Native Session 是否仍存在。

## Decisions

### 1. Mapping Store 继续只拥有最小管理元数据

Store 接口增加 `setArchived(hostThreadId, archived)`，并把已有 `listThreads()` 暴露给 Host Repository。归档更新复用当前每 Thread 写队列、严格 Schema、backup 和原子替换；相同目标状态作为幂等成功，不产生不必要的 Revision。

本次不修改 V1 Record。`archived` 已存在，Pin 明确不持久化，因此不需要迁移器。Store 返回防御性副本，列表调用方不能修改内存权威记录。

替代方案是建立单独目录数据库或全局索引文件。该方案会引入第二套恢复和事务边界，而当前规模尚未证明逐文件扫描不足，因此不采用。

### 2. External 元数据目录只列出可恢复记录

Host Catalog 从 Store 一次读取全部记录，只将 `state=ready` 且具有 `nativeSessionRef` 的记录作为持久列表候选。未获得 Native 身份的 provisional Thread 继续由当前进程中的 `thread/started` 和 Runtime 管理，不作为可重启目录项；损坏或隔离记录也不进入列表。

Catalog 使用一次构建的 `Map` 解析 Fork 树根 `sessionId`，避免每条记录重复查询 Store。未加载 Thread 的状态投影为 `notLoaded`；已加载 Thread 使用当前 Runtime 的 `idle` 或 `active` 状态。所有列表行的 `turns` 为空。

由于 Mapping Store 不保存正文，未加载 External Thread 的 `preview` 使用空字符串；标题来自 Store 的 `title`。这比为侧边栏预览批量读取 Native Snapshot 更符合当前数据边界。

### 3. External 列表在纯内存模块中筛选和排序

新增聚焦的 External metadata catalog/list 模块，负责当前协议字段，不把逻辑继续堆入 `AppServerHost`。它按以下规则处理 External 候选：

- `archived=true` 只包含归档记录；`false`、`null` 或缺省只包含未归档记录。
- `cwd` 使用记录中 cwd 的精确匹配。
- External `modelProvider` 固定为 `codexhost`，`source` 使用当前交互来源 `vscode`。
- `searchTerm` 只匹配持久标题，不读取第一条消息。
- External 普通/Fork Thread 不是 Codex Subagent；存在 `parentThreadId` 或 `ancestorThreadId` 过滤时不注入 External 记录。
- 本次 External `isPinned=false`；`isPinned=true` 查询不返回 External 记录。
- `useStateDbOnly` 是官方扫描策略提示，不排除已在 Mapping Store 中的 External 记录。
- `created_at` 使用 `createdAt`；`updated_at` 和当前 `recency_at` 使用 `updatedAt`。相同值使用 Host Thread ID 形成稳定 External 次序。

如果未来请求出现 Host 无法安全应用的新过滤语义，Host 保留官方结果但不注入 External 记录，不猜测匹配关系。

### 4. Host 使用内部官方请求关联获取列表页

`thread/list` 不再把 Desktop 原帧直接转发。Host 为官方子请求分配独立内部 JSON-RPC ID，在官方输出循环中只截获这些响应；普通响应和全部通知仍按原始路径转发。最终聚合响应继续使用 Desktop 原请求 ID。

内部 pending 请求必须有界、在官方错误/退出/Host 关闭时全部结束，且不能与 Desktop 或 Host Question ID 冲突。官方返回错误、Mapping Store 读取失败或返回结构无效时，Host 失败完整聚合请求，不返回部分列表。

替代方案是在一个官方页后直接追加 External 行。它会破坏全局 limit、排序和下一页连续性，因此不采用。

### 5. 组合 cursor 分别推进两种来源

Host cursor 是经过运行时校验的版本化 opaque 值，只包含：

```text
formatVersion
查询条件指纹
排序字段和方向
官方opaque cursor或边界
External排序锚点
包含锚点语义
```

cursor 不包含 Thread 行、cwd、标题、Native Ref 或正文。查询条件、版本或方向不匹配时明确拒绝。

每页通过两路有序归并产生。External 来源可以直接在稳定锚点后继续；官方来源按需请求。若一批官方结果只有前缀被合并页消费，Host 使用同一起始 cursor 和精确消费数量重新取得该前缀边界，而不是把未消费官方行塞入 Host cursor。精确时间相同时，External 与官方使用固定来源次序，官方来源内部保持官方返回顺序，避免未知的官方同秒后续项越过已返回 External 项。

`nextCursor` 表示两种来源在本页末尾后的状态；`backwardsCursor` 表示本页开头的反向边界。任一来源耗尽不影响另一来源继续分页。没有后续结果时 `nextCursor=null`。

### 6. Archive/Unarchive 是 Metadata-only Host 操作

Host 先通过 Repository 定位资源：不存在 External 记录时保持官方原帧转发；存在记录时不恢复 Session，直接原子设置归档状态。操作幂等，持久状态确认后才写响应，并保持 response-before-notification：

```text
thread/archive   -> result {}       -> thread/archived
thread/unarchive -> result {thread} -> thread/unarchived
```

Unarchive 返回的 Thread 是 Metadata-only 投影，`turns=[]`。若 Thread 已加载，Host 同步替换 Runtime 中的 Record 引用，但不关闭 Session、不取消活动 Turn，也不修改 Native Session。

### 7. 当前不支持的 External Pin 明确失败

所有 External Thread 行投影 `isPinned=false`。当前 `thread/metadata/update` 若引用 External Thread，Host 明确返回不支持，不转发官方 Codex；其中的 Pin 或 Git 元数据都不写入 V1 Record。官方 Thread 的同一请求继续原帧转发。

这是一项协议漂移保护，不代表产品支持 Pin。未来若 PRD确认 External Pin，应单独设计持久字段和格式演进。

## Risks / Trade-offs

- [双来源 cursor 容易出现重复、遗漏或方向切换错误] -> 将查询解码、单源分页和两路归并拆成纯函数，覆盖多页、一侧耗尽、同时间戳、反向分页和查询指纹测试。
- [官方协议继续增加筛选字段] -> 使用当前生成 Schema 做有界解码；未知过滤语义不注入 External 行，引用 External 资源的未知管理操作 fail closed。
- [列表没有 Native Preview] -> 返回空 Preview 和持久标题，不突破 Transcript 边界；未来体验不足必须先修改产品数据边界。
- [逐次扫描大量 JSON 记录] -> 当前启动后使用内存记录，列表不重新读文件；先增加 1000 Thread 方向性测试，未超预算前不增加数据库或持久索引。
- [归档期间仍有活动 Turn] -> Archive 只改变 Host 可见目录状态，不改变 Session 生命周期；活动 Turn 保持完整终态。
- [Host Runtime 模块继续膨胀] -> 将官方子请求关联、External metadata list 和 cursor 归并放入独立模块，AppServerHost 只负责编排。

## Migration Plan

1. 增加 Store/Repository 列表与归档接口，不改变 V1 文件结构。
2. 增加纯 External metadata 投影、过滤、排序和 cursor 测试。
3. 增加官方列表子请求关联及聚合路由，再接 Archive/Unarchive 和 metadata-update fail-closed。
4. 运行聚焦测试、TypeScript 工程门禁和当前 Codex 透明代理回归；使用受控 Desktop 验证普通列表、归档列表和恢复归档入口。
5. 回滚时移除 Host 接管和新增接口；已有 V1 文件仍可由旧实现读取，已写入的 `archived` 状态保持有效。

## Open Questions

- External Pin 是否进入后续产品范围；本次答案固定为不支持并 fail closed。
- Detach 是否复用当前 `thread/delete` 以及是否引入 `trash/`，由独立 Change 决定。
