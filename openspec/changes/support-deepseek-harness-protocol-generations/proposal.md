## Why

DeepSeek Harness 在 `0.1.2-alpha.1` 删除旧 `Host ApiProxy`，改用带浏览器认证的 Connection + Typert Remote。codexhost `v0.4.4` 仍精确依赖 `0.1.1-rc.2` 的旧 Host 客户端，因此无法连接正式候选版 `0.1.2-rc.1`。直接在现有 2400 余行 Session 实现中插入版本分支，会把两套认证、传输、历史、projection、交互和生命周期混在一起，并使后续升级无法独立验证。

## What Changes

- 保留一个公开 `DeepSeekHarnessAdapter`，连接前只选择一次内部协议实现，之后不再执行代际分支。
- 将当前 `0.1.1-rc.2` Host ApiProxy 实现完整隔离为 Legacy Adapter，并保持现有 Model/Thinking、Permission、历史、Fork、命令、交互、Usage、取消和 autonomous Turn 行为。
- 为精确 `0.1.2-rc.1` 使用一个独立 Modern Adapter，由 CH 管理启动 DSH Web，并处理 token→cookie 认证、HTTP Remote、`/api/remote.mux`、`session/follow` + `session/page` journal、`session/control` projection 和 `$events` waterfall。
- 最终支持矩阵仅包含 Legacy `0.1.1-rc.2` 与 Modern `0.1.2-rc.1`。包括已经用于协议验证的 alpha.4/alpha.5 在内，其他 release 即使 semver 相邻也失败关闭，并明确推荐升级到 `dsh-v0.1.2-rc.1`。
- 首版不附着已运行的 Modern Web；没有 CH 所启动受支持 Modern 进程的启动 token provenance 时，不读取 credential store、不绕过认证，也不发送 Session 内容。
- 连接诊断只验证默认 `127.0.0.1:3080` 或用户显式配置的 endpoint 是否确为未认证 DSH Web，不扫描或发现其他端口。
- 对 CH 自己启动的 Modern DSH，在设置页提供不暴露 token 的 Web 打开动作；外部 DSH、Legacy 和远程 Host 不获得该入口。
- 保留 #71 的 `compact`、`goal`、`plan` 命令行为；两代分别调用各自原生命令 Remote，但共享相同的 CH 命令白名单和参数语义。
- 在所有 Modern wire 边界增加严格 schema、有限字节/消息/分页工作量、凭据脱敏和有界 teardown。
- 不以能力不足的 ACP/SDK 替代 Web Remote，不读取、复制或持久化 DSH Native transcript，不自动接受未来版本。
- 以 exact rc.1 compiled artifact 和隔离 `DSH_HOME` 验证公开 Adapter 的完整 Modern 行为；alpha.4/alpha.5 仅保留为协议演进证据，不进入最终支持集合。

## Capabilities

### New Capabilities

- `deepseek-harness-protocol-generations`: 定义 DSH 协议代际选择、Legacy/Modern 隔离、rc.1 Web Remote 认证、journal/control/event 映射与支持 Gate。

### Modified Capabilities

- `local-deepseek-harness-session`: 本地 DSH Web 仍是运行时和 Native Session 真相源；Legacy 可连接 exact rc.2 wire Host，Modern 只使用 CH 管理启动的 exact rc.1，并按 follow/page/control 的连续性规则恢复。
- `harness-connection-diagnostics`: DSH 不兼容、未认证、wire 超限和进程失败需要给出稳定、可操作且不泄露 token/cookie 的诊断。
- `harness-reasoning-projection`: Modern DSH 的 provisional reasoning 不进入 append-only Host Item；正文保持实时，权威 Reasoning 延迟到最终消息并明确记录 live ordering 取舍。

## Impact

- `packages/adapters/deepseek-harness`：Legacy 文件隔离、代际选择、Modern Web Remote、journal/control、Turn、命令和交互实现及测试。
- `packages/host-runtime` / `shared-contracts` / `renderer-extension` / 平台控制边界：继续只注册同一个 Adapter，并为 CH-owned Modern DSH 提供不泄密的设置页 Web 打开动作；不新增 DSH 版本分支。
- `package.json` / lockfile：仅增加 Modern Cookie WebSocket 所需的直接运行时依赖。
- OpenSpec 与 DSH 集成文档：精确支持矩阵、认证、失败策略、Gate 和升级说明。
- 不修改 Protocol Core 或 Mapping Store；公共契约只增加不含 URL/token 的可选 Web UI 能力与打开动作。
