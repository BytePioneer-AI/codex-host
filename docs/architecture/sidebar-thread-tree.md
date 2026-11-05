# 侧边栏父子 Thread 嵌套

Codex Desktop 左侧边栏把 CodexHost 委派出的子 Thread 和 Fork 出的 Thread 缩进显示在父 Thread 下面。父 Thread 前出现展开／折叠按钮。该功能只改变 Renderer 的呈现，不改变执行归属、Thread 身份、导航或官方 Codex 的列表结果。

## 数据来源

关系只读取已持久化的数据，不打开 Harness Session、不读取 Snapshot、不加载 Turn：

| 关系 | 来源 | 读取方式 |
| --- | --- | --- |
| 委派 | Mapping Store 中 Delegation 的 `parentHostThreadId` → `childHostThreadId` | Host 本地方法 `codexhost/thread/relation/list` |
| 外部 Harness Fork | 外部 Thread 记录的 `forkSource.hostThreadId` | 同上 |
| native Codex Fork | 官方 `thread/read`（`includeTurns: false`）返回的 `forkedFromId` | Renderer 通过既有 Host 通道请求，仅对 Host 报告为 Codex 所有、且没有委派关系的 Thread 读取 |

同一 Thread 同时有委派和 Fork 来源时，以委派为准。官方 Subagent（`parentThreadId` 或 `source.subAgent`）和外部 Subagent 记录由 Desktop 原生嵌套，这里不重复处理。SSH 共享 owner 上的 Thread 由其他 Host 持有，本机不报告其关系。

`codexhost/thread/relation/list` 是新增的最小只读方法，参数与 `codexhost/thread/ownership/list` 相同（1–100 个不重复 Thread ID），返回每个 Thread 的 `owner` 和可选 `parent: { threadId, relation: "delegation" | "fork" }`。它不经过官方 Codex。Delegation 此前未暴露给 Renderer，所以需要这个方法；ownership 结果是严格 schema，不在原方法上扩字段。旧 Host 返回方法不可用时，Renderer 退回 ownership 列表，只保留 native Fork 嵌套；stock Codex 两者都没有时，所有 Thread 视为 native。

## Renderer 绑定

`renderer-sidebar-thread-tree.ts` 与侧边栏 Agent 图标共用同一套绑定方式：

- 用 Fiber 中与行属性一致的 `conversationId` 识别 Thread（`threadIdFromSidebarRowElement`），按 Host 区分相同 ID。
- `MutationObserver` 只在侧边栏行、列表或本功能标记的节点变化时调度一次 `requestAnimationFrame` 全量扫描。React 重渲染或替换节点后，下一次扫描重新应用布局，不依赖一次性 DOM 修改。
- 不移动、不包裹、不删除原生节点。只在原生 `role="listitem"` 上设置 CSS `order`、行首缩进和折叠时的 `display: none`，并保存原值；没有嵌套的列表不改样式。React 的节点协调和原生点击导航保持不变。
- 跨列表嵌套：Desktop 把每个 Thread 只放进一个列表，新 Fork 不继承置顶，所以置顶 Thread 的 Fork 出现在“最近”或项目列表里，与父 Thread 不在同一列表。所有列表一起规划（`planSidebarThreadForest`）：同列表内的父 Thread 优先；否则子 Thread 及其子树显示在根祖先所在的列表中。原生子行在原列表中以 `display: none` 隐藏，父列表末尾追加一个 CodexHost 自有的镜像节点（`data-codexhost-sidebar-thread-mirror`），用 CSS `order` 和缩进排到父 Thread 下面。
- 镜像是原生列表项的深拷贝，去掉 `id`、`draggable`、行识别属性（`data-app-action-sidebar-thread-row`／`-id`／`-host-id`）、键盘循环和拖放属性，保留选中、置顶等视觉属性；原生行标记或内容变化时重新拷贝。镜像上的 click、dblclick、auxclick、contextmenu 及 Enter／空格键在原生子行的对应节点上重放，导航、右键菜单和行内按钮仍由 Desktop 处理。只有在全部列表中只出现一次的 Thread 才会跨列表移动；跨列表的环保持原位。
- 只有值变化时才写样式或属性，扫描是幂等的，自身写入不会形成观察循环。
- 展开／折叠按钮插入在 `[data-thread-title-trigger]` 最前面，绝对定位并用负的行首外边距放到图标左侧的行首留白中，不占行内宽度，所以有子 Thread 的行与同层级行的图标对齐，子 Thread 相对父 Thread 图标恰好缩进一级（14 px）。按钮阻止事件冒泡到原生行，避免触发导航。折叠状态只保存在当前 Renderer 内存中。
- 关系结果按 Host 批量请求，单批最多 100 个。委派记录可能晚于子行出现，没有父 Thread 的结果在 1 s、3 s、10 s 后各重试一次；读取失败的行保持顶层。native Fork 读取并发上限为 4，结果在 Renderer 生命周期内缓存。
- Renderer 绑定刷新时，清除失败和“尚无父 Thread”的缓存；释放时恢复所有原始样式并移除按钮。

## 已知边界

- 子 Thread 所在分组（例如「最近」）折叠后，若父 Thread 仍留在其他列表（置顶／项目），已创建的镜像会保留在父 Thread 下，折叠按钮与子树不随源行卸载而消失。冷启动时若「最近」已折叠且从未挂载过子行，仍需展开一次才能建立镜像（没有可克隆的源 DOM）。
- 父 Thread 尚未渲染（未加载到当前页，或所在分组已折叠）时，子 Thread 留在原位置；父 Thread 再次出现后自动嵌套。
- 镜像不承接拖放、悬停卡片和只响应 pointerdown 的交互。
- 视觉顺序由 CSS `order` 决定；依赖 DOM 顺序的键盘循环仍按原生顺序。
- 层级缩进最多 6 级，更深的层级按第 6 级显示。
- 新增 Host 方法需要重启 CodexHost 后生效；只更新 Renderer 时只有 native Fork 嵌套。

## 验证

`renderer-sidebar-thread-tree.test.ts` 覆盖布局、环、置顶父 Thread 的跨列表 Fork（含后出现的 Fork、折叠、父 Thread 消失、最近分组卸载后 sticky 镜像保留和释放镜像）、跨列表的子树、同列表优先、重复 Thread 和跨列表环、折叠、重渲染、Host 区分、旧 Host 回退、迟到委派重试和释放；`renderer-model-client.test.ts` 覆盖方法结果校验和回退；`thread-relation-list.test.ts` 与 `app-server-host.thread-relations.test.ts` 覆盖 Host 关系读取、参数校验、存储失败和不写官方 stdin。
