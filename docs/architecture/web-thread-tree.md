# Web 会话树

Web 侧栏把本机 Host 的 Thread 显示成可以展开、收起的树。树关系只决定侧栏中的位置，不改变 Thread 的 Harness 归属、执行、路由、输入能力、标题或委派状态。Codex Desktop 的侧栏、置顶和归档不受影响。

## 显示父 Thread

每个 Thread 至多有一个显示父 Thread，按以下顺序确定：

1. 用户在 Web 中的手动放置：放在某个 Thread 下，或明确放在顶层；
2. 委派关系中的父 Thread，包括升级前已有的委派；
3. 都没有时，Thread 显示在顶层。

外部客户端发起的委派以 `client:<name>` 作为父标识，不是 Thread，因此不产生显示父 Thread。Harness 原生 Subagent 使用自己的父子关联，不进入侧栏，也不能放置或作为放置目标。

## Host 接口与持久化

- `codexhost/thread/tree/read`：返回 `{ parents }`，键为子 Thread ID，值为显示父 Thread ID，只包含有显示父 Thread 的 Thread。
- `codexhost/thread/tree/place`：参数 `{ threadId, parentThreadId }`，`parentThreadId: null` 表示移到顶层，成功后返回最新的 `parents`。Host 会确认两个 Thread 都属于本 Host（官方或外部）、都不是 Subagent、目标不是自身或其后代；任一条件不满足返回 `INVALID_ARGUMENT`，不写入。
- 委派关系建立或放置成功后，Host 发出 `codexhost/thread/tree/changed`，Web 据此刷新列表。

手动放置保存在 Mapping Store 目录下的 `thread-tree-placements.json`，与 Thread 记录和委派记录分开：

```json
{ "formatVersion": 1, "placements": [{ "hostThreadId": "…", "parentThreadId": "…或 null", "placedAt": "…" }] }
```

明确顶层只在该 Thread 有委派父 Thread 时才保存，否则删除记录。文件原子替换。读取失败时按没有手动放置处理，不影响 Thread 记录；旧版本忽略该文件。委派关系仍由委派记录保存，放置不修改它，`codexhost thread list --parent` 的结果也不受放置影响。

## Web Server

- 每次刷新列表都读取完整的 `parents`。本机 CH 会话摘要的投影 `threadTreeParent` 为显示父 Thread ID 或 `null`；草稿和远程 Host 会话没有该字段。
- 已加载行的祖先不在当前页时，Web Server 按 ID 单独读取并一起返回，最多向上 64 层。遇到环或无法确认的祖先时停止，子 Thread 显示在顶层。
- `session/place` 转发放置请求。远程或草稿 ID 返回 `session/place-invalid`。
- 侧栏的归档与恢复（`workspace/archiveSession`、`workspace/unarchiveSession`、`session/archive`、`session/unarchive`）级联到全部后代，包括未加载的后代：先父后子，跳过已处于目标状态的后代，最后只刷新一次列表。用户直接操作的 Thread 写入失败时返回它自己的错误，不处理后代；只有后代失败时返回 `session/archive-partial`，`details.failedSessionIds` 列出失败的 Thread，已成功的不回滚。

## Web 侧栏

- 整棵树显示在顶层 Thread 所在的工作区分组或最近分组中。子 Thread 不在自己的工作区中重复出现。
- 显示父 Thread 不可见时，子 Thread 显示在顶层。不可见包括：已归档且当前视图不显示归档、尚未加载、属于其他 Host、关系成环。
- 顶层 Thread 沿用侧栏的排序方式：按更新时间排序时取整棵子树中最近的更新时间；手动排序只作用于顶层。子 Thread 固定按自身更新时间倒序排列，不能拖动排序，但仍可以拖入聊天区域作为会话引用。
- 有子 Thread 的行显示展开箭头和后代数量。收起时额外显示后代的汇总状态：等待处理、运行中、完成未读；行本身的状态不变。有后代运行中或等待处理的顶层 Thread 不会被“显示更多”截断。
- 展开状态按 Thread ID 保存在当前浏览器的工作区视图设置中，默认收起。通过链接、搜索或通知打开某个 Thread 时，会展开它的祖先。缩进最多 3 级，更深的层级使用相同缩进。
- 只有顶层 Thread 可以置顶，置顶后整棵子树一起显示在置顶区。已置顶的 Thread 成为子 Thread 后，Web 不再显示其置顶状态，但不修改 Host 与 Desktop 共享的置顶状态。
- 行菜单的“移到…下”打开可搜索的选择器，候选为已加载的同一 Host Thread，排除已归档、草稿、Subagent、自身及后代。有显示父 Thread 的行另有“移到顶层”。远程 Host 的会话平铺显示，没有这两项。
- 搜索结果保持平铺，有显示父 Thread 的结果同时显示父 Thread 标题。

## 已知边界

- 只读取 Web 所连接 Host 的 Mapping Store。Remote Control 主 Host 与附加客户端共用同一份存储；SSH 独立共享 owner 使用自己的数据目录，其中的委派关系不会被汇总，相应子 Thread 显示在顶层。
- 收起时的汇总状态只基于已加载的行。
- 在 Desktop 中归档不会级联；被归档父 Thread 下未归档的子 Thread 在 Web 中显示在顶层。
