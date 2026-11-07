# Design

## Context

`SessionLog.follow()` 每次发送窗口 snapshot；`SessionEventStream` 将其映射为 Gateway 日志流的完整替换。`RecentSessionViews` 仅保留事件、分页与投影，没有日志身份和已确认尾游标。Assistant 使用独立 revision，活动工具输出在 `codexhostToolOutput` 投影中。CH 展示日志可重建，也可 prepend 较早页而不改变已有 seq。

## Decisions

- **日志身份**：每个日志实例生成进程内唯一 epoch，`reset()` 换代；CH 展示视图重建自然产生新 epoch。向前补页不换代。不能将持久文件的最后 seq、时间戳或 Host 通知 epoch 当作浏览器展示日志身份。
- **一个续传谓词**：请求具有缓存身份，epoch 相同，`firstSeq - 1 <= cursor <= lastSeq`，且该尾部连续时续传；否则使用已有窗口算法。空日志使用 -1。请求针对的会话地址必须一致；新分叉目标不能继承源会话缓存身份。
- **原子打开响应**：follow 增加可选 `{ epoch, cursor }` 恢复输入。打开帧区分 snapshot/resume，携带新 epoch、权威截止游标、最新 projections 和 opted-in assistant baseline；resume records 只包含 `seq > cursor`。订阅登记与响应基线捕获保持同步执行，之后再交付实时事件。
- **客户端合并**：缓存只保存确认过的持久游标，不从可能含 transient Assistant 的可见最后一项推导。先校验连续性，再合并新增持久记录，重装当前 Assistant 基线并应用投影；此后才解除同步状态。旧尝试不能随缓存重复保留。保留已加载较早页与原有 hasMore，snapshot 则走既有替换路径。
- **日志流边界**：扩展 Gateway 日志流的公开打开/seed 表达以接纳已缓存连续窗口，不另建重连循环；Session Controller 负责 epoch 与基线语义。分页和 gap repair 不复用未经确认的恢复令牌。物理连接重连也只能使用最新已发布的恢复位置。
- **范围**：8 项内存缓存、follow 释放、阅读锚点、同步错误及历史操作门禁不变。Host `knownTurns`、HTTP/WebSocket 压缩不变。

## Risks / Trade-offs

- [seq 相同但历史已换代] → 日志实例和 reset 均更新 epoch；加入 Web 重启及同长度改写测试。
- [持久游标不动但流式内容增加] → 每次打开都提供独立 Assistant revision 与活动输出投影，测试只有 transient 更新及旧尝试结算。
- [新响应覆盖阅读位置或更早页] → resume 只增量合并；扩展 `session-cache.spec.ts` 和 `ch-session-cache.test.ts` 验证锚点与分页。
- [只优化了记录却忽略基线体积] → 字节测试统计整个打开响应，包括投影与 Assistant 基线，不把“零条记录”等同于零流量。

## Migration

浏览器与 Web 协议配套更新；缺少恢复输入的请求保持 snapshot 行为，无持久数据迁移。回滚后忽略恢复输入并正常发送 snapshot，页面刷新清除进程内缓存。实施顺序先完成此变更，再叠加连接级工具预览；两项可分别提交，但本任务不创建提交。
