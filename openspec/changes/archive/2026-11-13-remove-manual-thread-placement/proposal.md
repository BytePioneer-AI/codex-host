# Proposal

## Why

会话树的目标是让大量委派出来的子 Thread 不再淹没侧栏。委派自动挂载已经解决了这个问题；用户手动把 Thread 放到另一个 Thread 下的能力（“移到…下”菜单、拖动挂靠、每层手动顺序）带来了大量交互与实现复杂度：落点判定与误操作、触屏菜单、乐观更新、跨 Host 与归属校验失败，而实际需求不明确。

## What Changes

- 去掉手动放置：Web 不再提供“移到…下”“移到顶层”，也不再支持拖动一个 Thread 挂到另一个 Thread 下；Host 不再提供 `codexhost/thread/tree/place`，不再保存手动放置，Web Server 不再提供 `session/place`。
- 显示父 Thread 只来自委派关系（含升级前已有的委派）。Host 仍提供 `codexhost/thread/tree/read` 与 `codexhost/thread/tree/changed`。
- 顶层 Thread 的拖动排序、置顶、子 Thread 按更新时间排序、展开收起、汇总状态、归档级联、搜索平铺等其余行为不变。
- 磁盘上已有的 `thread-tree-placements.json` 被忽略，不迁移、不删除。

## Decisions

- **只做委派**：树关系只表达“谁委派了谁”，不提供用户整理树的入口，避免排序与挂靠共用同一手势造成的误操作。以后如有真实需求再单独评估。
- **后端一并移除**：不保留无调用方的放置接口与持久化，减少 Host 公共契约。
