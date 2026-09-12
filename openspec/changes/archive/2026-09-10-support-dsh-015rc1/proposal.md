## Why

当前 Adapter 只接入 DSH `0.1.1-rc.2` Legacy 与 `0.1.2-rc.1` Modern。最新 `0.1.5-rc.1` 使用 V3 日志及独立 Assistant 流，修改白名单不足以完成对接；用户要求退役 Legacy 并明确仅支持两个 RC。

## What Changes

- **BREAKING** 删除 DSH Legacy 实现、HTTP attach/fallback、专属测试和旧 SDK 依赖，仅允许精确 `0.1.2-rc.1` / `0.1.5-rc.1`。
- 原有不支持版本错误改为明确列出两版并推荐 `dsh-v0.1.5-rc.1`，不新增弹窗或 RPC。
- 按选定版本读取 V0/V3 日志、系统消息、surface 替换、Assistant 流/结算、PTC 和原生控制命令。
- 保留创建、恢复、导入、Fork、最后回合回滚、工具/审批/问题和故障清理；隔离不同日志格式的 checkpoint。
- 改写当前支持矩阵、连接/导入/消息修订说明、打包依赖说明和相关 OpenSpec；历史归档明确属于旧实现，不改写历史事实。
- 提供整个 DSH Adapter 的可复现覆盖率检查，目标 80%～90%，最低 80%，以及受影响跨包回归。

## Capabilities

### New Capabilities

- `deepseek-versioned-web-protocol`: 精确双版本、日志与流式解析、命令差异、checkpoint 隔离、文档和验证要求。

### Modified Capabilities

- `local-deepseek-harness-session`: 退役外部 Legacy attach，以精确版本托管 Web Remote 作为来源，明确显式导入及原生历史恢复。
- `deepseek-harness-fast-session`: 更新早期 MVP 的历史能力声明，移除已被双版本原生 Fork/回滚规范取代的禁止要求。

## Impact

- `packages/adapters/deepseek-harness`、对应测试、插件打包依赖清单、根锁文件和覆盖率配置。
- `docs/harness-session-import.md`、`docs/dsh-edit-recovery.md`、插件架构与运行时文档中实际受影响段落。项目及多语言 README 保持原样，plan/todo 仅保留本地，不纳入 PR。
- 不改变公共 Harness/Mapping Store 格式、Host 导入 RPC 别名、其他 Harness、Rust、DSH 源码或用户原生会话数据。
