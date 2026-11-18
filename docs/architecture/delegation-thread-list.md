# Delegation CLI Thread 列表分页

`codexhost thread list` 列出当前 Host Runtime 中指定工作区的 native Codex 与外部 Harness Thread，默认使用调用进程的 cwd、`created-desc` 排序和 25 条页大小，最大 100 条。`--parent` 则按委派关系列出子 Thread。把 `nextCursor` 原样传给下一次请求；`null` 表示本次遍历结束。

## 数据来源与归属

- `--parent` 请求交给拥有该父 Thread 的注册。
- SSH 共享 owner、Windows Remote Control 主 Host 作为 Registry 的 Harness catalog，负责共享后端的全局列表。附加客户端共享同一官方后端和 Mapping Store，不作为独立列表来源；catalog 返回的 native／Host 聚合 cursor 原样透传。
- 没有 catalog 且只有一个注册时，直接透传该注册的列表和 cursor。
- 没有 catalog 且有多个独立注册时，Registry 按请求的 created、updated 或 recency 时间升／降序归并各来源。各来源内部的同时间戳顺序由来源维护，不建立新的全局同时间戳次序契约。

全局列表不加载外部 Harness Session 来枚举历史。发送、读取等 Thread 操作仍走既有所有权路由，不因列表 catalog 转移执行归属。

## 独立来源的复合 cursor

Registry 对每个来源请求一条记录，只有该记录实际返回给调用方，才保存该来源返回的后继 cursor。尚未返回的候选记录不会推进来源的位置。续页直接使用保存的原生位置，不重读旧页后按数量跳过前缀，也不创建历史快照或跨请求缓存 Thread 内容。

复合 cursor 是不透明的版本化编码，绑定：

- Registry 实例和注册集合的 generation，包括同数量替换或重新注册；
- cwd 和排序；
- 每个独立来源的原生续读位置或结束标记。

调用方可以改变 `limit`，不能改变 cwd、排序或列表来源。格式错误、版本不支持、查询或注册集合不匹配时返回 `INVALID_ARGUMENT`，应不带 cursor 重新开始。Registry 的复合 cursor 不能用于 `--parent`、catalog 或退化为单注册后的列表。父 Thread 的列表由所属注册校验 cursor；SSH 注册合并旧 SSH 与 shared 子 Thread 时，使用绑定该注册、父 Thread、cwd 和排序的复合 cursor，不接受 Registry 全局列表的 cursor。单注册及 catalog 的 cursor 校验仍由原有来源负责。

正常非空来源每页最多发出“活跃来源数 + 返回条数 - 1”次一条记录请求；候选内存为 O(来源数)，归并比较为 O(来源数 × 返回条数)。空但未结束的来源页会继续读取，每个来源每次请求最多读取 256 页；无进展、超出页大小或超出请求界限的来源返回错误，不静默丢弃数据。

## 活列表边界

分页不是快照。静态数据源可完整遍历并保持请求的时间排序；并发变化仍遵循各原生后端的 cursor 语义。例如，keyset 后端不会因已返回记录之前插入／删除记录而重新计数，但已返回 Thread 的排序时间变化并移动到 cursor 之后时，后端仍可能再次返回它。尚未读取来源的新记录也可能出现在后续页中，因此不保证并发修改期间跨页的全局时间单调性。

Host 不承诺底层未提供的快照稳定性，也不额外维护已返回 Thread 的全局去重历史。若来源在可变数据上使用 offset 分页，其原有的重复或漏项风险也不会由 Registry 消除。需要反映完整最新状态时，应重新开始遍历；`nextCursor: null` 不用于轮询未来新增 Thread。

## 验证边界

`delegation-thread-list-pagination.test.ts` 通过真实 AppServerHost、共享 Mapping Store、OfficialRuntimeScope 和可变 keyset 后端覆盖共享 catalog、插入／删除、cwd 校验、limit 变化及六种排序；`run-host-runtime.remote-control-catalog.test.ts` 检查生产 Remote Control 注册路径。它们不代替真实 Windows Remote Control 的连接验收，也不证明任意 native 后端具备快照能力。

## 派出会话的状态

`--parent` 列表来自 Delegation 记录。委派记录只保存子会话最近一次结束时的状态，已结束的子会话再收到后续消息开始新一轮时，记录仍是 `completed`；因此 Host 当前正在运行的子会话一律报 `running`，其余沿用记录。

## Desktop 侧栏徽标

徽标和 Web 会话树显示同一份父子关系：Host 的 `codexhost/thread/tree/read`（见 [Web 会话树](web-thread-tree.md)），所以置顶的子会话和外部客户端发起的任务不算在父会话下。

Desktop 左侧本地会话行上，有子会话的会话在 Agent 图标右下角显示子会话数（超过 9 个显示 `9+`）。角标颜色取子会话中最紧急的状态：待回答（橙）> 运行中（蓝）> 无活动（灰）。待回答指子会话有未答的 Question（Host 的问题列表，不含权限审批）；运行中指 Host 当前正在运行该子会话。Web 侧栏的“待批准”“未读”由 Web 客户端维护，Desktop 不显示。该图标随之可点击，点击弹出子会话列表而不打开父会话。列表用角标同一份轮询结果当场打开，按状态从紧急到不紧急，同状态按派出时间从新到旧，打开期间随同一次轮询更新；每行为 Harness 图标、标题和状态，点击一行经 Desktop 自己的路由打开该会话。列表在图标下方放不下时向上展开；用键盘打开时焦点进入列表，上下方向键切换，Esc 关闭并把焦点还给图标。角标挂在侧栏 Agent 图标上，不另占标题位置，Desktop 悬停时在行尾显示的按钮不会使其移动；Agent 图标被重建时角标随下一次侧栏变化重新挂上。

Renderer 通过 `codexhost/thread/delegation-children` 批量读取可见行的子会话（Host 用会话树的关系拼上子会话的 Harness、标题和状态），页面可见时每 5 秒一次，隐藏时不读；只观察侧栏节点的变化来恢复被重新渲染的徽标。原生 Codex 子会话没有 Host 记录，标题只在列表打开期间、对还没有标题的子会话各向官方读取一次，状态仍以轮询为准。轮询中途页面隐藏、Host 客户端被替换或模块被销毁时，这次结果整体丢弃。只处理本地 Host 的行；远程连接的行不显示徽标。
