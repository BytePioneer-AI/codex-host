# Tasks

依赖 `persist-thread-watches` 与 `add-external-client-access`。行为验收见 [spec](specs/cross-harness-delegation/spec.md)。

## 1. 静默检测与提醒

- [x] 1.1 `thread watch`、`delegate start --watch true` 与 MCP 接受 `--stall-after-ms`/`stallAfterMs`，未启用 watch 时拒绝，重复注册保留原阈值。验证：CLI、MCP 与 watch 服务测试。
- [x] 1.2 从原生 app-server 通知与外部 Harness 输出收集活动，沿子代理祖先关系传播；原生 Thread 关闭后只要还有未关闭的后代就保留整条祖先链，子树全部关闭、外部会话释放或后端停止后清除。验证：活动收集单元测试与 Host 集成测试。
- [x] 1.3 静默达到阈值时提醒一次并继续观察；提醒以“至少 <阈值>”精确表述、不带进度，经待投递机制合并投递，外部客户端写入事件日志。验证：watch 服务与客户端事件测试。
- [x] 1.4 阈值随 watch 持久化，卡住提醒、活动时间与已提醒状态不落盘，重启后重新计时。验证：存储与重启测试。

## 2. 文档与验收

- [x] 2.1 更新 `codexhost delegate --help`（`thread watch` 结果列表与 `events`）、`docs/architecture/thread-watch.md`、`external-clients.md` 与 `docs/index.md`。验证：帮助测试。
- [ ] 2.2 真实 Desktop 验收：委派长任务并 `--watch true --stall-after-ms <n>`，子 Thread 长时间没有事件时父 Thread 收到一次卡住提醒，之后子 Thread 停下时再收到停下通知。记录平台与版本。
