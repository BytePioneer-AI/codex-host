# Tasks

行为验收见 [spec](specs/cross-harness-delegation/spec.md)。

## 1. 持久化与恢复

- [x] 1.1 watch 记录的私有持久文件（每个 watch 一个记录，标注所属进程，接管已退出进程的记录）：注册、状态变化、投递成功移除、标记无法投递时原子写入；Runtime 启动时读取并恢复，文件缺失、损坏或版本不认识时记诊断并从空集合开始，不阻止 Runtime 启动。验证：单元测试覆盖写入时机、原子替换、损坏文件、权限 0600，以及记录中不出现任务文本。
- [x] 1.2 期限改用绝对时间；恢复后先读被观察 Thread，终态优先于 `timedOut`。验证：用可控时钟模拟停机跨越观察期限和投递期限，分别得到终态通知、`timedOut` 和 `undeliverable`。
- [x] 1.3 恢复后的 `unreadable` 宽限从会话重新注册后开始计算。验证：会话延迟注册超过 60 秒时不报 `unreadable`；注册后持续读取失败 60 秒才报告。
- [x] 1.4 投递前先持久化“投递中”状态；恢复时把“投递中”视为待投递并再投一次。运行期间“结果未知”的处理保持不变。验证：在投递调用返回前终止 Runtime，重启后被通知 Thread 收到一次通知；运行期间结果未知的用例仍标记 `undeliverable` 且不重试。

## 2. 文档与端到端验收

- [x] 2.1 更新 `docs/architecture/thread-watch.md`、`codexhost delegate --help` 中的 watch 说明和随附的委派 Skill 文本。验证：帮助快照测试更新，文档不再出现“重启后丢失”。
- [ ] 2.2 真实 Desktop 验收：委派一个长任务并 `--watch true`，在子 Thread 运行中退出并重启 codexhost，子 Thread 完成后父 Thread 被唤醒一次；再验证停机期间子 Thread 已完成的情形。记录平台与版本。
