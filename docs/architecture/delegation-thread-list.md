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

调用方可以改变 `limit`，不能改变 cwd、排序或列表来源。格式错误、版本不支持、查询或注册集合不匹配时返回 `INVALID_ARGUMENT`，应不带 cursor 重新开始。复合 cursor 不能用于 `--parent`、catalog 或退化为单注册后的列表。单注册及 catalog 的 cursor 校验仍由原有来源负责。

正常非空来源每页最多发出“活跃来源数 + 返回条数 - 1”次一条记录请求；候选内存为 O(来源数)，归并比较为 O(来源数 × 返回条数)。空但未结束的来源页会继续读取，每个来源每次请求最多读取 256 页；无进展、超出页大小或超出请求界限的来源返回错误，不静默丢弃数据。

## 活列表边界

分页不是快照。静态数据源可完整遍历并保持请求的时间排序；并发变化仍遵循各原生后端的 cursor 语义。例如，keyset 后端不会因已返回记录之前插入／删除记录而重新计数，但已返回 Thread 的排序时间变化并移动到 cursor 之后时，后端仍可能再次返回它。尚未读取来源的新记录也可能出现在后续页中，因此不保证并发修改期间跨页的全局时间单调性。

Host 不承诺底层未提供的快照稳定性，也不额外维护已返回 Thread 的全局去重历史。若来源在可变数据上使用 offset 分页，其原有的重复或漏项风险也不会由 Registry 消除。需要反映完整最新状态时，应重新开始遍历；`nextCursor: null` 不用于轮询未来新增 Thread。

## 验证边界

`delegation-thread-list-pagination.test.ts` 通过真实 AppServerHost、共享 Mapping Store、OfficialRuntimeScope 和可变 keyset 后端覆盖共享 catalog、插入／删除、cwd 校验、limit 变化及六种排序；`run-host-runtime.remote-control-catalog.test.ts` 检查生产 Remote Control 注册路径。它们不代替真实 Windows Remote Control 的连接验收，也不证明任意 native 后端具备快照能力。
