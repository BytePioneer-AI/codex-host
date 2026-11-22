# Grok 权限模式

Grok 插件提供 `ask`（询问）、`auto`（自动）和 `always-approve`（始终批准）。`permissionModeScope` 为 `live`：会话创建后仍可切换，不重新创建 Native Session。切换需要会话空闲；活动 Turn、上下文压缩或其他配置操作期间返回可重试的 `sessionBusy`。

## 原生接线与生效确认

每个 Host Session 使用独立的 `grok agent --no-leader stdio` 进程。插件发送 ACP 扩展通知 `_x.ai/yolo_mode_changed`，包含 `yolo_mode`、`auto_mode` 和 `permission_mode`。线上的 `_` 前缀必需；Grok 分发给扩展处理器时会去掉此前缀。原生通知作用于进程内的匹配会话，Subagent 继承父会话的权限管理器，权限切换保持这一原生语义。

Grok `1.0.67` 的 `session/set_config_option` 仅提供模型与 Thinking，`_x.ai/session/info` 不返回当前权限，权限通知也没有 RPC 回执。因此插件为子进程的 `RUST_LOG` 追加 `xai_grok_workspace::permission::manager=info`，保留已有日志过滤设置，读取该管理器输出的实际开关值：

| 模式 | `always-approve set to` | `auto permission mode set to` |
|---|---|---|
| `ask` | `false` | `false` |
| `auto` | `false` | `true` |
| `always-approve` | `true` | `false` |

管理器输出的是实际应用值，包含受管策略对 always-approve 的限制，以及原生 Auto 功能开关的结果。插件同时等待 `_x.ai/session/info` 对目标 Session 的往返响应，确认目标身份与会话命令队列；只有两个实际开关均匹配才发布 `session.state.changed` 并返回成功。通知写入成功、请求值、普通诊断文字或单个开关均不能充当确认。

创建、Resume、Fork 和回滚打开后的权限也经过同一确认流程。Resume 使用 Host 保存的模式；从已加载源会话派生 Fork 或回滚时，使用源会话最新已确认的模式。没有源配置时使用 `ask`。无人值守全访问意图映射为 `always-approve`，仍须通过原生确认。

确认超时、开关不匹配、目标身份不符、进程退出或关闭时，不发布请求的权限状态；Transport 被关闭，已打开的 Session 报告故障，后续执行须重新打开会话。原生若已部分应用配置，插件不会假装回滚成功，也不会继续按旧状态执行。旧版本或升级后缺少该日志信号的版本同样不能误报成功。

## 验证范围

- 聚焦测试覆盖三个模式及重复选择、正确扩展前缀、两个开关与会话往返的等待、受管限制、Auto 被禁用、缺失或部分确认、错误身份、进程退出、关闭与并发，以及确认后才发布状态。
- `CODEXHOST_GROK_PERMISSION_LIVE=1 npx vitest run --config tests/vitest.config.js packages/adapters/grok/test/grok-permission-live.test.ts` 使用已安装 CLI 和已有登录，在临时 GROK_HOME 与项目中验证切换及 Resume；不发送模型 Prompt，要求 `modelCalls=0`。临时凭据副本与会话在结束后清理。
- 原生基线为 macOS Grok `1.0.67`（`2fe064390d07`）。没有验证活动工具执行中切换；插件要求空闲后操作。该验证不代表真实 Desktop UI、Windows CLI 或完整委派验收。

原生依据：[扩展通知处理](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L2381-L2448)、[Session 命令处理与 Auto 开关](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs#L1263-L1290)、[权限管理器的实际值输出](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-workspace/src/permission/manager/mod.rs#L524-L543)。公开源码版本落后于发行版，运行兼容性以真实 CLI 验证为准。
