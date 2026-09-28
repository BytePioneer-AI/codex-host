## 1. Watch 服务与入口

- [x] 1.1 新增 `delegation-watch.ts`，只依赖公开 `read`/`send`，由 `DelegationControlRegistry` 持有。
- [x] 1.2 新增 `thread watch`、`thread watches` 与 `delegate start --watch`，以及对应控制服务路由、帮助与委派 Skill 说明。
- [x] 1.3 统一外部 Thread 忙碌判断为运行中或存在待处理的调整方向。

## 2. 结果与送达

- [x] 2.1 原生 Codex 读取仅在确认 Thread 不存在时报告 `THREAD_NOT_FOUND`，其他读取错误按读取失败处理。
- [x] 2.2 投递仅在 `THREAD_BUSY` 或明确未启动时重试；结果未知与永久失败标记 `undeliverable`。
- [x] 2.3 为读取分类、投递分类与外部启动结果未知补充回归测试，并确认修复前失败。

## 3. 规范与文档

- [x] 3.1 以显式 watch 作为“不主动唤醒父 Agent”的唯一例外修改 `cross-harness-delegation` 规范，并写明重启丢失、不能取消与 Stop 行为。
- [x] 3.2 更新 `docs/architecture/thread-watch.md`。
- [ ] 3.3 维护者确认唤醒规则后，合入时归档本变更并同步主规范。
