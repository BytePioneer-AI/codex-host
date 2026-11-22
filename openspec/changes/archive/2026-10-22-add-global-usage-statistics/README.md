# add-global-usage-statistics

设置中的全局用量统计页：汇总本机全部 Harness、全部会话的 Token、缓存与 API 等价费用（按官方公开价估算），并让未计价模型可直接补价。

状态：**部分实现，尚未全部验收**。公共契约、Host 汇总、统计页和首批读取器已实现；Qoder / Qoder CN 已接线并通过隔离测试，真实会话对账仍待完成。Kimi Code、Antigravity、Kiro CLI、Cursor CLI 暂未暴露读取能力，原因见 `design.md` 与 `docs/product/usage-statistics.md`。Codex 已作为独立 `codex-usage` 插件实现并完成本机对账、Loader 与 Host 集成测试，不接管原生会话操作；运行中 Desktop 未重启验收。完整待办见 `tasks.md`。
