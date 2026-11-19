# Desktop 侧栏会话树

Codex Desktop 侧栏把委派出去的子 Thread 收在父 Thread 下面，可以展开、收起，外观和动效与 [Web 会话树](web-thread-tree.md)一致。父子关系与 Web 相同，都来自 Host 的 `codexhost/thread/tree/read`，因此置顶的子 Thread 是顶层，外部客户端发起的委派不产生父 Thread。该功能只改变 Renderer 的显示，不改变 Thread 的 Harness 归属、执行、标题、置顶、归档，也不改变 Desktop 自己的行顺序。只处理本机 Host 的行，远程连接的行保持原样。

## 显示规则

- 侧栏的每个列表（每个项目的列表、“最近”）各自成树。一棵树在一个列表里只出现一次，位置是这棵树的成员在该列表里排得最靠上的那一行：这一行是根 Thread 自己的行时，就在原生行上显示；否则在该行的位置画出根 Thread 的行（Agent 图标、标题与原生行对齐）。树里其他成员的原生行隐藏。因此子 Thread 比父 Thread 新、或父行没有挂载（例如项目默认只显示前 5 条）时，子 Thread 仍收在父 Thread 下。
- 有子 Thread 的行，图标位置不变、标题不移位。鼠标移到图标上时图标换成展开箭头，展开期间一直显示箭头；点击箭头展开或收起。收起时行下方多一行汇总，与原行同属一个块：“N 个子会话 · N 运行中 · N 待批准”（后两项为后代中运行中、等待处理的数量，为 0 时不显示），点击汇总展开。点击行只打开 Thread：Web 侧栏里再次点击已打开的父行会展开或收起，Desktop 上双击已打开的行的标题是重命名，所以不这样做。默认收起；打开某个 Thread 时展开它的祖先一次，之后可以再收起。
- 子 Thread 的行每级缩进 24px，用带圆角的连线连到父 Thread 的图标；第 4 级起使用相同缩进、不再画连线。子 Thread 的行显示 Agent 图标、标题和状态，同级按委派时间从新到旧排列；有自己子 Thread 的行以同样方式展开。已归档或 Host 已不存在的 Thread 不显示，它下面的 Thread 也不随它显示。
- 点击子 Thread 的行会打开它：Desktop 已挂载该 Thread 的原生行时触发原生行的点击，否则通过 Desktop 自己的路由（`/local/<threadId>`）打开。codexhost 画出的行没有右键菜单、悬停操作和拖动。
- Desktop 切换上一个、下一个 Thread 的快捷键按显示顺序经过树里的行：codexhost 画出的行带 `data-sidebar-cycle-item`，打开的 Thread 的行带 `aria-current="page"`。
- 动效只在用户展开、收起时出现，系统开启“减少动态效果”时不出现：新出现的行 100ms 渐显，下方移动的行平滑滑到新位置，消失的行在原处 100ms 渐隐。滑动使用 Desktop 项目列表自己伸缩时的曲线（300ms，`cubic-bezier(0.19, 1, 0.22, 1)`），列表内的行与下方的项目同步移动，不会被正在收起的列表裁掉。
- 展开状态按 Thread ID 保存在当前 Desktop 的 `localStorage`（`codexhost.sidebar-thread-tree.expanded.v1`），不写入 Host；同一个 Thread 在多个列表里的展开状态相同。

## Renderer 绑定

`renderer-sidebar-thread-tree.ts` 负责数据和调度，`sidebar-thread-tree.ts` 是不依赖 DOM 的布局计算，`renderer-sidebar-thread-tree-dom.ts` 负责节点，`renderer-sidebar-thread-tree-motion.ts` 负责动效。

- 不移动、不克隆、不包裹原生节点。展开按钮是一个脱离文档流的按钮，叠在原生行的 Agent 图标上，大小与图标相同；汇总行和子 Thread 的行放在该行自己的 `role="listitem"` 内、原生内容之后。在其他成员的位置画出的树放在那一行的 `listitem` 内，原生内容以样式隐藏；被收进树的行，其 `listitem` 仅以 `display: none` 隐藏。树的位置所在的行缺少可挂载的结构时，该列表里不成树，也不隐藏任何行。卸载时全部移除并恢复，包括样式表。
- Thread 身份沿用侧栏 Agent 图标的读取方式（行属性与 Fiber 中 `conversationId` 一致）。当前打开的 Thread 取 Composer 上的 `data-above-composer-conversation-id`，没有时取 `data-app-action-sidebar-thread-active` 的行。
- codexhost 画出的行的高度、圆角、图标与标题的位置在运行时从同一列表的原生行量取，标题字体和颜色取自其中未打开、未选中的行；每次渲染先量完所有列表再写入。颜色通过 `var(--token, 回退值)` 读取 Desktop 的设计变量；不使用 Desktop 生成的类名。项目列表外层的高度由 Desktop 自己根据内容重新测量并播放伸缩动画。
- 展开、收起时先记下切换所在 `listitem` 内各行和其后各块的位置，立即重新布局，再从旧位置播放到新位置；消失的行复制到侧栏滚动区内一个不可交互的覆盖层中渐隐，结束后移除。Desktop 自己移动的块（例如下方的项目）在读取新布局时尚未移动，交给 Desktop 的动画。
- 只观察侧栏和 Composer 身份的变化；Desktop 重新渲染行之后，下一帧重新应用。写入是幂等的，自身的节点不触发再次渲染。

## 数据

| 数据 | 方法 | 读取时机 |
| --- | --- | --- |
| 父子关系 | `codexhost/thread/tree/read` | 安装时、Host 客户端被替换时、侧栏行的集合变化后（400ms 去抖）、页面恢复可见时，以及可见期间每 60 秒 |
| 标题、Harness、归档状态 | `codexhost/thread/tree/nodes`（`includeOfficial: true`） | 每次读取父子关系之后，以及出现尚未读取过的 Thread 时；读取范围是可见行所在树的根及其全部后代 |
| 运行状态 | `codexhost/thread/tree/nodes` | 页面可见且有可显示的树时每 5 秒 |

`codexhost/thread/tree/nodes` 接收 1–100 个不重复的 Thread ID，按请求顺序返回每个 Thread 的 `harnessId`、`status`（`pending` / `running` / `idle`）、可选的 `title`、`archived` 和 `delegatedAt`。

- 外部 Thread 的标题与归档状态取自 Mapping Store；记录已删除的外部 Thread 不在结果中。
- 官方 Codex Thread 没有 Host 记录，只有带 `includeOfficial` 时才读取：标题各向官方 app-server 读取一次（并发上限 8）；官方 Thread 对象不带归档标记，归档状态取自官方的已归档列表，每次请求最多读取 10 页、每页 100 条；列表在上限处截断时，不在已读部分里的官方 Thread 归档状态未知，不进入树。不带 `includeOfficial` 时不访问官方 app-server，也不返回这两个字段。
- 读取失败的字段不返回，不做猜测。归档状态未知的 Thread 不进入树，它自己的原生行保持原样。
- 状态是读取时刻的实时状态：在等用户处理（待批准的操作或未答的问题，官方与外部 Thread 都算）为 `pending`，Host 正在运行为 `running`。通过 codexhost 启动的 Desktop 连接的是共享 Host 中的前端 Host，它与运行外部 Thread 的 Host 共用记录但不共用运行状态，因此前端 Host 会向后者请求同一方法，并取两者中更紧急的状态；后者不可达时使用本端状态。
- 读取不会打开或恢复 Harness Session。
- 请求按后台优先级发送，30 秒超时。
- Host 没有这两个方法，或本机 Host 连接不存在时，Renderer 撤回全部显示，侧栏恢复 Desktop 原样；方法不可用时在该连接上不再请求。

## 已知边界

- 子 Thread 与父 Thread 属于不同项目时，子 Thread 所在项目的列表里也会出现父 Thread 的树（位置在子 Thread 处）。Web 侧栏把这样的子 Thread 移到父 Thread 的工作区；Desktop 的项目列表由 Desktop 决定，且项目只挂载前几条行，移走后子 Thread 可能在任何可见列表里都找不到，因此保留在原列表。
- 已折叠的项目里的行保持原样，展开项目后再成树。
- codexhost 画出的行可以用 Tab 聚焦、上下方向键移动、Enter 打开，但不进入 Desktop 自己的侧栏行键盘循环。
- 不显示未读状态，该状态由 Desktop 自己维护。
- 官方 Codex 子 Thread 在别处改名或归档后，最迟 60 秒反映到侧栏。
- 只显示委派关系，不处理 Fork 关系；Harness 原生 Subagent 不进入侧栏。
- 每次最多描述 400 个 Thread，超出的留在自己的原生行。
- codexhost 画出的行上的按下、双击、右键和拖动开始事件不会传给 Desktop；松开事件照常传递，在别处开始的拖动可以在这些行上结束。

## 验证

- `thread-tree-nodes.test.ts`：请求顺序、已删除的外部 Thread、`includeOfficial`、读取失败时不猜测、截断的归档列表、状态优先级、标题上限。
- `app-server-host.thread-tree.test.ts`：等待批准的 Thread 报告为 `pending` 而不是 `running`。
- `local-shared-host.test.ts`：前端 Host 报告由所有者 Host 运行的外部 Thread 的实时状态。
- `sidebar-thread-tree.test.ts`：树画在根自己的行或排得最靠上的成员处、每个列表各自成树、子 Thread 的子 Thread、收起时的计数与运行中和等待处理的数量、归档与未知的 Thread、成环、缩进上限。
- `renderer-sidebar-thread-tree.test.ts`：展开按钮叠在图标上且标题不动、汇总行与连线、在子 Thread 的位置画出父 Thread 的树、逐级展开、第 4 级起的嵌套与缩进、点击汇总展开、点击行只打开、切换 Thread 快捷键的标记、状态刷新后焦点留在汇总上、以屏幕上的 Composer 为准、两种打开方式、状态轮询与行变化后的重读、Desktop 重新渲染、祖先自动展开（含先打开后读到关系）、折叠的项目、无法挂载的行、子行卸载后的打开方式、其他 Host 与旧 Host、Host 不再提供或连接断开时撤回、被替换连接的迟到失败、卸载恢复、客户端替换。
- `renderer-sidebar-thread-tree-motion.test.ts`：新行渐显、移动的行滑动、离开的行在不可交互的覆盖层中渐隐后移除、汇总随所在行出现与消失、减少动态效果时不动。
- 在真实 Chrome 中用捕获的 Desktop 侧栏离线检查：图标、标题与同列表原生行的对齐（像素一致）、浅色与深色、展开与收起动效的逐帧截图。
