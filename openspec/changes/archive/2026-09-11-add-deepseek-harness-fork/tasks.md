## 1. Checkpoint 与原生 Fork

- [x] 1.1 使用 `turn/end.seq` 为历史及实时 terminal 发布稳定 Checkpoint，覆盖成功、失败和取消结果
- [x] 1.2 严格校验 source/checkpoint、完整连续历史、真实 terminal 与同 cwd 边界
- [x] 1.3 精确调用 DSH `sessions.fork({ sessionId, atSeq })`，映射原生错误并处理 `workspace-attach-failed`
- [x] 1.4 对账 child identity、原始 seed、Turn 数、terminal Checkpoint、Native Ref 归属和原生 Model/Thinking 回读

## 2. 测试与能力状态

- [x] 2.1 覆盖历史/实时 Checkpoint 一致性、中间 Turn、活动源后续 Turn和 child/source 隔离
- [x] 2.2 覆盖 foreign/malformed/stale/missing checkpoint、cross-cwd、fork-unavailable 和 child identity/history 不匹配
- [x] 2.3 覆盖 partial success 对账、child Model/Thinking 回读和所有 open 失败路径的 subscriber 清理
- [x] 2.4 将 inspection 与 Session capabilities 更新为同 cwd Fork 支持

## 3. 文档与验证

- [x] 3.1 更新中英韩 README 中 DeepSeek Harness 的 Model/Thinking、Fork 和斜杠命令状态
- [x] 3.2 更新 Harness 当前实现参考和 DeepSeek Harness 规范 delta
- [x] 3.3 运行 OpenSpec strict validation、typecheck、聚焦/跨包测试、Prettier、ESLint 和边界检查

## 4. Modern Last-Turn Rollback

- [x] 4.1 多轮复用倒数第二轮 Checkpoint Fork；单轮创建继承当前 Agent Preset 的空 Session，并接受其 `cursor=-1` projection baseline
- [x] 4.2 零轮、活动 Turn、非法 Agent Preset 失败关闭，且不修改来源 Session 或项目文件
- [x] 4.3 更新 Modern/Legacy 能力声明、聚焦测试、中英韩 README 和实现参考
- [x] 4.4 对 exact `dsh-v0.1.2-rc.1` compiled artifact 完成多轮、单轮及继续对话实机验收
