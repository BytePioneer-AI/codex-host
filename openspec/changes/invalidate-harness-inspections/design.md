## Design

Host 的 owner client channel 使用 `harness-inspection-changed`，载荷为 `harnessId` 和现有 cursor，仅表示失效，不携带检查快照。任一入口的 `refresh: true` 检查完成后发布，包括 Codex 与规范化失败状态；普通检查不发布。

`ChHarnessCatalog` 订阅本机 Host realtime。Harness 事件删除该 Harness 的所有 cwd 缓存；hello 清空全部检查与插件列表缓存。两者转发无载荷的 `codexhost/harness-inspection-changed`，本机目录随后重新读取完整检查。关闭时取消订阅。缓存中的 Promise 是所有权令牌：迟到结果或异常只有仍拥有该条目时才可删除，失效后旧请求不得写回。插件列表的异常清理采用相同规则。

选择器只刷新 `this.catalog`，沿用目录 refresh 的并发合并与代次保护，不将本机 Host 事件用于远程目录。

设置页保留 availability 检查。已有检查期间的手动点击共享一个后续刷新 Promise；后台调用继续复用当前检查，不形成无限队列。

## Constraints

不使用 TTL、轮询、自动重试或网关方法拦截，不把轻量检查结果写入完整检查缓存。Adapter 的检查缓存策略由各 Adapter 决定，本变更不修改。
