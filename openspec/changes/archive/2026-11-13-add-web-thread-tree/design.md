# Design

## Context

- 委派关系已由 Mapping Store 独立持久化（`delegations/<id>.json`，字段 `parentHostThreadId`、`childHostThreadId`），一个子 Thread 至多属于一条委派关系；官方 Codex 子 Thread 与外部 Harness 子 Thread 都有记录。
- Web 的会话摘要只从 Harness 原生 Subagent 关联设置 `parentSessionId` 和 `origin: "subagent"`（`packages/web-server/src/ch-sessions.ts` 的 `summary()`）。侧栏因此隐藏这些行（`ui-workspace/src/client/tree.ts` 的 `sessionVisible`）。委派子 Thread 没有任何父子标记，平铺显示。
- Web 的会话列表来自 Host 的 `codexhost/thread/catalog/read`。官方 Thread 分页加载，所以父 Thread 可能不在已加载的页面中。
- 官方 Thread 与外部 Thread 的置顶通过 `codexhost/thread/pins/list|set` 与 Desktop 共享；归档逐个调用 `thread/archive` / `thread/unarchive`（`ch-sessions.ts` 的 `setArchived`）。
- Mapping Store 已有与 Thread 记录分开保存的 `section-placements`，可同时保存官方 Thread 与外部 Thread，旧版本会忽略该文件。
- 远程 Host 的 Thread 通过 `remote-sessions.ts` 转发，不经过本地 Host 的 Mapping Store。

## Decisions

### 1. Host 提供完整的树关系，不放进分页的列表结果

新增两个 Host 方法，契约放在 `shared-contracts`，处理逻辑放在 `host-runtime` 的独立模块中，不写进 `app-server-host.ts`：

- `codexhost/thread/tree/read`：返回 `{ parents: Record<threadId, parentThreadId> }`，只包含存在显示父 Thread 的 Thread。由“手动放置 ?? 委派父 Thread”计算；明确放在顶层的 Thread 不出现在结果中。
- `codexhost/thread/tree/place`：参数 `{ threadId, parentThreadId: string | null }`，`null` 表示移到顶层。成功后返回最新的 `parents`。

理由：委派关系和手动放置都只有 ID，数据量小，Host 可以一次给出完整关系。Web 用同一份数据完成嵌套显示、补齐祖先和归档级联三件事，不需要另外的子树查询。放弃的方案是在 `catalog/read` 的每一行上附加父 Thread，因为它跟随分页，无法补齐祖先，也无法找到未加载的后代。

两个方法加入 `ch-host-client.ts` 的方法白名单，Web 的读取方式与置顶一致。

### 2. 手动放置的持久化

在 Mapping Store 中新增与 `section-placements` 同类的独立版本化文件（例如 `thread-tree-placements.json`）：

```
{ formatVersion: 1, placements: [{ hostThreadId, parentThreadId: string | null, placedAt }] }
```

- `parentThreadId: null` 表示明确放在顶层。只有该 Thread 存在委派父 Thread 时才需要保存这一条；否则删除记录即可。
- 写入采用原子替换，与 `section-placements` 相同。读取失败时保留原文件并按“无手动放置”处理，不影响 Thread 记录。
- 不修改 `StoredThreadRecordV1` 和委派记录。

### 3. 放置校验在 Host 执行

`tree/place` 依次校验：

1. `threadId` 和 `parentThreadId` 都是本 Host 能确认归属的 Thread（官方或外部）。
2. 两者都不是 Harness 原生 Subagent。
3. `parentThreadId` 不是 `threadId` 本身，也不在其后代中（按合并后的关系判断）。

不满足时返回 `INVALID_ARGUMENT`，不写入。归档状态由 Web 的选择器过滤，Host 不拒绝，避免与之后的恢复操作冲突。

### 4. Web Server 只做传递和补齐

- 每次刷新列表时，与 catalog 一起读取 `tree/read`，缓存最近一次结果。
- 摘要的 `projectionValues` 中加入 `threadTreeParent: string | null`。沿用 `tree.ts` 中 `threadReference` 的模块扩展方式，不修改 `SessionSummary` 的结构，也不复用 `parentSessionId`、`origin`。
- 补齐祖先：对已加载的行，沿 `parents` 向上查找，未加载的祖先用现有直接读取路径（`thread/read`，`includeTurns: false`）补入 `rows`，再随本页一起返回。设置访问深度上限并记录已访问的 ID，遇到环时停止。
- 关系变化（委派创建、放置）通过现有 catalog 变更推送触发列表刷新；`catalogKey` 加入显示父 Thread，使变化能推送到浏览器。
- 归档级联：在 `session/archive` / `session/unarchive` 中按 `parents` 计算全部后代，先处理父 Thread 再处理后代，逐个复用 `setArchived` 的路径。失败的 ID 在错误结果中返回，已成功的不回滚。
- 新增 `session/place` RPC 供 Web UI 调用，转发到 `tree/place`。
- 远程 Host 的会话不加 `threadTreeParent`，`session/place` 拒绝远程 ID。

### 5. Web UI：在新模块中生成树

- 新建 `ui-workspace/src/client/thread-tree.ts`，作为纯函数模块：输入为已经按现有规则过滤后的行和 `threadTreeParent`；输出为带 `depth`、`children`、`descendantCount`、子树汇总状态和子树最近更新时间的节点。处理孤儿、环和不可见父 Thread 时降级为顶层。
- `tree.ts` 的 `deriveGroups` / `deriveFlat` 只对顶层节点套用现有的分组、置顶分区、手动排序与 `sidebarWindow`。子 Thread 跟随顶层节点，不进入自己工作区的分组。新逻辑不写进 `tree.ts`（682 行）和 `WorkspaceBrowser.tsx`（2059 行）。
- 排序：按更新时间排序时，顶层节点使用子树最近的更新时间；`reconcileManualOrder` 只接收顶层 ID。子节点按自身 `updatedAt` 倒序排列。
- 展开状态与 `expandedGroups` 采用相同的浏览器本地保存方式，以 Thread ID 为键。导航到某个 Thread 时，把它的祖先加入展开集合。
- 行渲染：缩进 `min(depth, 3)` 级，加展开箭头和子 Thread 数量。收起时显示子树汇总状态。`sidebarWindow` 的“始终显示”条件加入“后代运行中或等待处理交互”。
- 置顶：非顶层节点的置顶显示为 false，并隐藏置顶菜单项；不修改 pins。
- 菜单：“移到…下”打开一个使用现有 `Modal` 的可搜索选择器，候选项在前端过滤（同一 Host、未归档、非草稿、非 Subagent、非自身及后代）；“移到顶层”只对有显示父 Thread 的行显示。拖动排序对子节点禁用，拖入聊天区域作为会话引用保持不变。
- 搜索结果保持平铺，副标题显示“工作区 · 父 Thread 标题”。

## Risks / Trade-offs

- [未加载的后代运行中，收起的父 Thread 汇总不到] → 运行中的 Thread 更新时间较新，通常在第一页；汇总只基于已加载的行，并在文档中说明。
- [补齐祖先增加列表请求] → 只补齐已加载行缺失的祖先，按 ID 去重并设深度上限；委派链通常很浅。
- [级联归档部分失败] → 逐个执行并报告失败 ID。重复执行同一操作是幂等的，用户可以重试。
- [Desktop 与 Web 的视图不一致] → 这是有意的范围限制。Desktop 仍依靠“子任务名 · 父会话名”的标题区分子 Thread。
- [SSH 共享 owner 或 Remote Control 下委派记录分布在多个注册中] → 第一版只读取 Web 所连接 Host 的 Mapping Store。实现时需要核实这些部署下 `listDelegations` 是否覆盖共享后端的委派；没有覆盖时，相应子 Thread 降级为顶层，不报错。

## Migration

- 无需迁移：历史委派关系立即生效，放置文件首次写入时创建。
- 回滚：旧版本忽略放置文件和新增的 Host 方法；侧栏恢复平铺，Thread 数据不受影响。
