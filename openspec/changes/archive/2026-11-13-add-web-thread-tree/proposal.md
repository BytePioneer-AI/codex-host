# Proposal

## Why

委派让一个 Thread 派生出大量子 Thread，Web 侧栏把它们与普通 Thread 平铺在一起，列表难以浏览。Host 已持久化委派父子关系，但 Web 没有使用；用户也无法把相关 Thread 手动归到一起。

## What Changes

- Web 侧栏把 Thread 显示为树：任一 Thread 可以作为父节点，子 Thread 显示在它下面并可展开、收起，支持任意层级。
- 委派创建的子 Thread 自动显示在发起它的父 Thread 下，包括已有的历史委派。
- 用户可以在 Web 中把一个 Thread 移到另一个 Thread 下，或移回顶层；该选择由 Host 持久化，并覆盖委派关系。
- 收起的父 Thread 汇总显示后代的运行中、待处理交互和未读完成状态。
- 子 Thread 跟随顶层 Thread 所在的分组；顶层 Thread 保持现有排序方式，按更新时间排序时使用整棵子树的最近更新时间；子 Thread 固定按自身更新时间倒序排列。
- 只有顶层 Thread 可以在 Web 中置顶，置顶时整棵子树随之进入置顶区。
- 在 Web 中归档或恢复一个 Thread 时，同时归档或恢复它的全部后代。
- Codex Desktop 的侧栏、置顶、归档和委派行为不变。

## Decisions

- **显示父 Thread 只用于整理视图**：显示父 Thread = 用户的手动放置 ?? 委派父 Thread ?? 无。该关系不改变执行归属、路由、委派通知或标题，也不复用 Harness 原生 Subagent 的父子关联；Subagent 仍不进入侧栏。
- **Host 持有完整的树关系**：委派关系和手动放置都由 Host 保存，Web 一次读取全部父子关系，用于嵌套显示、补齐未加载的祖先和归档级联，不依赖会话列表分页。
- **手动放置不随 Mapping Store 的 Thread 记录保存**：使用独立文件，官方 Thread 和外部 Thread 都适用；旧版本忽略该文件，不会因此隔离 Thread 记录。
- **以菜单完成手动放置**：桌面和手机都使用行菜单中的“移到…下”和“移到顶层”。不做拖到某一行上挂靠，避免与现有的排序拖动和拖入引用冲突，手机上也无法拖动。
- **置顶不同步修改 Desktop**：已置顶的 Thread 成为子 Thread 后，Web 不再把它显示为置顶，但不修改 Host 与 Desktop 共享的置顶状态。
- **折叠状态只保存在当前浏览器**：默认收起，打开某个 Thread 时自动展开它的祖先。

## Capabilities

### New Capabilities

- `web-thread-tree`：Web 侧栏的 Thread 树显示、显示父 Thread 的来源与优先级、手动放置及其持久化、树内排序、置顶和归档规则。

### Modified Capabilities

无。委派关系的持久化契约（`cross-harness-delegation`）不变，本变更只读取它。

## Impact

- `packages/shared-contracts`：新增读取树关系和设置手动放置的 Host 方法契约。
- `packages/mapping-store`：新增手动放置文件的读写。
- `packages/host-runtime`：合并委派关系与手动放置，校验放置请求（同一 Host、不成环、目标不是 Subagent）。
- `packages/web-server`：向会话列表提供显示父 Thread、补齐未加载的祖先、级联归档。
- `apps/web-ui/packages/client/ui-workspace`：树的生成、缩进与展开收起、状态汇总、排序、置顶规则和放置菜单。
- 文档：新增 `docs/architecture/web-thread-tree.md`，更新 `docs/index.md` 和 `docs/product/standalone-web.md`。
- 无新依赖；Desktop 和 Renderer 扩展不变。
