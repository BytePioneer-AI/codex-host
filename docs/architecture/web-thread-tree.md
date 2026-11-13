# Web 会话树

Web 侧栏把本机 Host 的 Thread 显示成可以展开、收起的树。树关系只来自委派，只决定 Thread 在侧栏中的位置，不改变 Thread 的 Harness 归属、执行、路由、输入能力、标题或委派状态。Codex Desktop 的侧栏、置顶和归档不受影响。

## 显示父 Thread

每个 Thread 至多有一个显示父 Thread，即委派它的父 Thread，包括升级前已有的委派；没有时显示在顶层。Web 不提供手动改变显示父 Thread 的入口。

外部客户端发起的委派以 `client:<name>` 作为父标识，不是 Thread，因此不产生显示父 Thread。Harness 原生 Subagent 使用自己的父子关联，不进入侧栏。

## Host 接口

- `codexhost/thread/tree/read`：返回 `{ parents }`，键为子 Thread ID，值为显示父 Thread ID，只包含有委派父 Thread 的 Thread。
- 委派关系建立后，Host 发出 `codexhost/thread/tree/changed`，Web 据此刷新列表。

委派关系由 Mapping Store 的委派记录保存，`codexhost thread list --parent` 的结果与之一致。旧版本保存的手动放置文件 `thread-tree-placements.json` 不再读取，也不会被删除。

## Web Server

- 每次刷新列表都读取完整的 `parents`。本机 CH 会话摘要的投影 `threadTreeParent` 为显示父 Thread ID 或 `null`；草稿和远程 Host 会话没有该字段。
- 已加载行的祖先不在当前页时，Web Server 按 ID 单独读取并一起返回，最多向上 64 层。遇到环或无法确认的祖先时停止，子 Thread 显示在顶层。
- 侧栏的归档与恢复（`workspace/archiveSession`、`workspace/unarchiveSession`、`session/archive`、`session/unarchive`）级联到全部后代，包括未加载的后代：先父后子，跳过已处于目标状态的后代，最后只刷新一次列表。用户直接操作的 Thread 写入失败时返回它自己的错误，不处理后代；只有后代失败时返回 `session/archive-partial`，`details.failedSessionIds` 列出失败的 Thread，已成功的不回滚。

## Web 侧栏

- 整棵树显示在顶层 Thread 所在的工作区分组或最近分组中。子 Thread 不在自己的工作区中重复出现。
- 显示父 Thread 不可见时，子 Thread 显示在顶层。不可见包括：已归档且当前视图不显示归档、尚未加载、属于其他 Host、关系成环。
- 顶层 Thread 沿用侧栏的排序方式：按更新时间排序时取整棵子树中最近的更新时间；手动排序只作用于顶层。子 Thread 固定按自身更新时间倒序排列，不能拖动排序，但仍可以拖入聊天区域作为会话引用。
- 有子 Thread 的行在图标前有展开箭头，点图标也能展开、收起。收起时用箭头颜色表示后代的汇总状态：等待处理、运行中、完成未读；行本身的状态不变。有后代运行中或等待处理的顶层 Thread 不会被“显示更多”截断。
- 展开状态按 Thread ID 保存在当前浏览器的工作区视图设置中，默认收起。打开某个 Thread 时只展开它的祖先 Thread，不会自动展开它所属的工作区文件夹。缩进最多 3 级，更深的层级使用相同缩进，展开的子树左侧有引导线。
- 只有顶层 Thread 可以置顶，置顶后整棵子树一起显示在置顶区。已置顶的 Thread 作为委派子 Thread 显示时，Web 不再显示其置顶状态，但不修改 Host 与 Desktop 共享的置顶状态。
- 远程 Host 的会话平铺显示。
- 搜索结果保持平铺，有显示父 Thread 的结果同时显示父 Thread 标题。

## 已知边界

- 只读取 Web 所连接 Host 的 Mapping Store。Remote Control 主 Host 与附加客户端共用同一份存储；SSH 独立共享 owner 使用自己的数据目录，其中的委派关系不会被汇总，相应子 Thread 显示在顶层。
- 收起时的汇总状态只基于已加载的行。
- 在 Desktop 中归档不会级联；被归档父 Thread 下未归档的子 Thread 在 Web 中显示在顶层。
