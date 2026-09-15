## 1. 契约

- [x] 1.1 `HarnessGoalCapability`、`HostGoal`、`SessionGoalChangedEvent` 与 `HarnessSession.goal?`。
- [x] 1.2 `FakeHarnessSession` / `FakeHarnessAdapter` 的 Goal 支持与模拟辅助。

## 2. Claude Code Adapter

- [x] 2.1 SDK 流上的 Goal 信号解析（命令输出、Stop hook 判定、错误通知）。
- [x] 2.2 `ClaudeGoalTracker` 与 transcript `goal_status` 推导。
- [x] 2.3 `goal.set` 确认前缓冲、拒绝静默撤回；`goal.clear` 静默；`goal.read`；Turn 结束对账。
- [x] 2.4 历史读取识别 `/goal` 记录。

## 3. Host Runtime

- [x] 3.1 `thread/goal/set|get|clear` 显式路由、能力门、状态映射与通知。
- [x] 3.2 `session.goal.changed` 与 Turn 终态对 Host Goal 状态的影响。

## 4. 验证与文档

- [x] 4.1 Adapter、历史、Host 聚焦测试。
- [x] 4.2 `docs/external-thread-goal.md`、文档目录、术语表。
- [ ] 4.3 真实 Desktop 验收（`/goal`、达成自动清除、中断 → Resume、重启后补水）。
