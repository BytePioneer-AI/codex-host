# Grok 能力清单

## 基本信息

- Harness ID：`grok`；原生 ACP stdio + `x.ai/*` 扩展，每个 Host Session 使用独立 `--no-leader` 进程。
- 原生验证：Grok `1.0.67`（`2fe064390d07`），2026-10-23，macOS，本机登录，隔离 GROK_HOME 与项目；权限探针未调用模型。
- 交付范围：现有预装插件的权限切换与原生提问接入；其他能力按既有实现与测试登记。提问使用隔离 ACP wire 和 Session 测试，不代表已重新做过安装版 CLI / Desktop 真实验收。
- 参考实现：现有 Grok 模型配置的并发与状态发布流程；原生权限管理器的实际状态信号。

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | test/account-presentation.test.ts |  |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts |  |
| A3 | 检查 | 必做 | P0 | 支持 | src/grok-adapter.ts | test/grok-adapter.test.ts |  |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts |  |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/grok-adapter.ts | test/grok-adapter.test.ts |  |
| A6 | 取消 | 必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts |  |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/grok-history.ts | test/grok-history.test.ts |  |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts |  |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/grok-adapter.ts | test/grok-adapter.test.ts |  |
| A10 | 关闭 | 必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts |  |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/grok-adapter.ts、src/grok-models.ts | test/grok-adapter.test.ts |  |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/grok-adapter.ts、src/grok-models.ts | test/grok-adapter.test.ts |  |
| B3 | 权限模式 | 原生有则必做 | P1 | 受限 | src/permission-modes.ts、src/acp-transport.ts、src/grok-adapter.ts | test/grok-acp-permissions.test.ts、test/grok-permission-confirmation.test.ts、test/grok-permission-live.test.ts | 空闲时可切换；依赖原生实际状态信号 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | src/grok-adapter.ts | test/grok-adapter.test.ts | unattended-full-access 映射为 always-approve |
| B5 | Fork | 原生有则必做 | P1 | 支持 | src/grok-fork.ts、src/grok-adapter.ts | test/grok-fork.test.ts、test/grok-adapter.test.ts |  |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 支持 | src/grok-fork.ts、src/grok-adapter.ts | test/grok-adapter.test.ts |  |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 支持 | src/grok-rewind.ts、src/grok-adapter.ts | test/grok-rewind.test.ts、test/grok-adapter.test.ts |  |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/grok-tool-output.ts、src/grok-file-change.ts、src/grok-adapter.ts | test/grok-tool-output.test.ts、test/grok-file-change.test.ts |  |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts | ACP request_permission |
| B10 | 提问 | 原生有则必做 | P0 | 受限 | src/acp-transport.ts、src/grok-questions.ts、src/grok-adapter.ts | test/grok-acp-questions.test.ts、test/grok-questions.test.ts、test/grok-adapter.test.ts | 已接入原生单选、多选、自由输入、回答/取消及撤回；不提供倒计时、活动续时或 Plan 特殊动作；实机待验收 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 支持 | src/grok-subagent.ts、src/grok-subagent-lifecycle.ts | test/grok-subagent.test.ts、test/grok-adapter.test.ts |  |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | src/grok-adapter.ts | test/grok-adapter.test.ts | 当前仅在活动 Turn 中投影原生输出 |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | src/grok-usage.ts、src/grok-adapter.ts | test/grok-usage.test.ts、test/grok-acp-usage.test.ts |  |
| B14 | 请求级计量 | 原生有则必做 | P2 | 受限 | src/grok-usage.ts、src/grok-adapter.ts | test/grok-adapter.test.ts | 当前发布原生费用快照，不发布 usage.request / usage.history |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | src/grok-adapter.ts | test/grok-adapter.test.ts | 执行策略与环境有测试；真实完整委派未验收 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | — | 本次未进行真实向下委派 |  |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、src/permission-modes.ts | test/account-presentation.test.ts、test/grok-permission-modes.test.ts |  |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | test/installation.test.ts |  |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | src/installation.ts | test/installation.test.ts |  |
| C4 | 首次安装 | 可选 | P2 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts |  |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | src/command.ts、src/plugin.ts | test/grok-command.test.ts | CODEXHOST_GROK_COMMAND |
| C6 | 会话导入 | 可选 | P2 | 支持 | src/session-import.ts | test/session-import.test.ts |  |
| C7 | 全局用量统计 | 可选 | P2 | 支持 | src/usage-statistics.ts | test/usage-statistics.test.ts |  |
| C8 | 账号额度 | 可选 | P2 | 支持 | src/grok-credits.ts、src/grok-adapter.ts | test/grok-credits.test.ts |  |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | tsconfig.json、package-lock.json | 既有 Workspace 注册 |  |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json | 既有预装清单 |  |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts |  |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/harnesses/grok/ | docs/index.md |  |
| D5 | 其他 | 可选 | P2 | 不适用 | — | 无需新增插件或展示分支 |  |

## 受限与已知缺口

- B3：Grok 1.0.67 的权限扩展没有 RPC 回执，`session/info` 和 `configOptions` 不包含权限。生效确认必须取自原生权限管理器的实际状态，不能由发送结果推断。仅在无活动 Turn 或压缩操作时切换；通知作用于独立进程内的匹配会话。原生受管策略和 Auto 功能开关始终生效。
- B10：`_x.ai/ask_user_question` 经 extMethod 接入；Grok 插件负责原生答案格式和生命周期。多选复用公共卡片，纯单选/文本保留原生 Desktop 提问。Grok 自行决定超时，Host 不自动作答；不显示倒计时、不发送活动续时，不提供 Plan 特殊动作和交互式预览。详见 `docs/harnesses/grok/questions.md`。
- B12、B14、B15、B16：范围见表中备注；本次不扩展自主 Turn 或委派能力。

## 插件外改动

- `docs/harnesses/grok/permission-modes.md`、`docs/index.md`：权限接线、生效确认与验证范围。
- `docs/architecture/harness-plugin-architecture.md`：更新 Grok 当前权限语义。
- `openspec/specs/harness-permission-mode-control/spec.md`、`openspec/specs/grok-cli-acp-session/spec.md`：会话内切换与原生确认要求。
- `.agents/skills/codexhost-add-harness/references/implementations.md`、`spec-session-core.md`：移除过期的 Grok 创建时固定权限示例。
- `packages/host-runtime/test/external-thread-runtime.test.ts`：Grok 恢复夹具使用 live 能力，验证保存的权限仍经 open 传入。
- 权限接线无需修改公共契约或 Host / Renderer；提问 Adapter 亦只使用已有 `HostQuestionInteraction`，没有 Grok 专用公共分支。同 PR 的通用多选卡片与公共 RPC 见 `docs/architecture/harness-questions.md`。
- `docs/harnesses/grok/questions.md`、`docs/index.md`：提问接线、答案格式与验证边界。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| 原生边界 | 1.0.67 隔离协议探针 | 带 `_` 前缀的通知实际改变权限管理器；无前缀被拒绝；modelCalls=0 |
| Adapter 与 Transport | Grok 包测试；关闭与并发改动后增量复验 | 通过：首次全包 251 项；随后含 Host / Renderer 的 118 项及 ACP 增量 10 项均通过 |
| 类型 / 格式 | npm run typecheck；改动 TS 文件 ESLint 与 Prettier 检查；git diff --check | 通过 |
| 真实原生验收 | CODEXHOST_GROK_PERMISSION_LIVE=1 的原生测试；macOS，1.0.67，本机登录，grok-4.7，local | 切换、重复选择、同 ID Resume 均通过；modelCalls=0 |
| 插件加载 / Host | buildHarnessPlugin + 临时根 loadHarnessPlugins；external-thread-runtime.test.ts | 通过；未修改 Host / Renderer 生产代码 |
| Desktop / 委派 | 权限接线无 UI 或委派改动 | 未做真实 Desktop、SSH、Windows CLI 或完整委派验收 |
| 提问增量 | grok-questions.test.ts、grok-acp-questions.test.ts、grok-adapter.test.ts | 107 项通过（含既有 Adapter 回归）；使用隔离 ACP 子进程和 Session 夹具，不调用真实模型 |
| 提问实机 | 安装版 Grok CLI / Desktop | 未执行；不把上述历史权限探针或浏览器 fixture 当作提问实机证据 |
