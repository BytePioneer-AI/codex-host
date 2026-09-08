# DSH Modern 原生停止确认

活动 Session 关闭先请求取消，再等待对应原生 turn/end。未关联请求不能被另一个自主 Turn 的终态遮蔽；故障先于关闭时，本地清理不能证明原生停止；关闭期间晚到的接受回执仍获得终态。无法确认停止时明确拒绝 close，保留上游 Modern rollback 支持和 Legacy 声明。

提供基于本地 SSE 模型、隔离临时数据和真实 CLI 的生命周期 Gate：`tools/gate-dsh/lifecycle.real.test.mjs`。通过对应的 `CODEXHOST_DSH_REAL_COMMAND` 指定原生命令，缺少命令时明确跳过。

Gate 覆盖流式输出、取消、空/保留历史编辑、冷恢复、默认配置保持、源历史不变和活动关闭。不把默认配置验证推广为任意非默认配置，也不证明 Windows、独立第三方客户端或任意后台工具进程的退出。
