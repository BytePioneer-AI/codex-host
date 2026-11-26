# oh-my-openagent（omo）能力清单

<!--
模板：.agents/skills/codexhost-add-harness/references/capabilities-template.md（未改「#」「功能」「必做」「优先级」四列）。
本文件在计划任务 1 建立，结论先按原生接口实测与 `.omo/drafts/add-omo-harness.md` 的 Findings 判定；
「实现位置」当前指向计划任务分配的模块路径，「证据」指向原生依据与对应验证任务，
实现完成后在计划任务 17 补入测试文件与隔离实测记录。
结论只能是：支持 / 不支持 / 受限 / 待验证 / 不适用。
-->

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `omo` |
| 原生接口与传输方式 | 原生 CLI `omo --mode rpc` 子进程，classic stdio LF-only JSONL RPC（senpi 引擎，pi RPC 超集）；先 `get_protocol_info` 能力协商。无 ACP，SDK 内嵌与 daemon/thread 网关均被排除（Windows 上 `omo thread`/`omo daemon` 直接 exit 4） |
| 已验证的原生版本 | omo 5.1.83（`omo --version` = `omo 5.1.83 (engine: senpi 2026.11.23)`）；协议 `protocolVersion: 1`，`mode: classic`，能力位 27 项 |
| 交付范围 | 预装发行（用户 2026-11-26 确认） |
| 参考插件 | `pi`：RPC 会话进程生命周期、历史/快照投影、工厂与发现；`omp`：权限模式恢复、审批/提问交互、自主 Turn、`signalProcessTree`；`qwen-code`：inspect 按 cwd 缓存 |
| 最后验证 | 2026-11-26，Windows（win32 x64），本机 `omo.exe` 已有 `~/.omo` 登录态；探针只发 RPC 控制命令（get_protocol_info / get_state / get_commands / get_available_models），未发起模型调用 |

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | `packages/adapters/omo/manifest.json` | 计划任务 2；manifest schema `packages/shared-contracts/src/harness-plugins.ts:133-142`，id 正则 `:11-24`，`adapterApiVersion` 必须为 1（`:5`）；`omo` 符合正则且非保留字 `codex` | 含 icon/links/notice 与三平台安装指引，见 C1/C2 |
| A2 | 工厂 | 必做 | P0 | 支持 | `packages/adapters/omo/src/plugin.ts` | 计划任务 2；`HarnessPluginContext` 字段见 `packages/harness-adapter/src/plugin.ts:30-40`；工厂模式参照 `packages/adapters/pi/src/plugin.ts`；`.omo/drafts/add-omo-harness.md`「codexhost 集成面」加载链 8 道门 | 只挂 `installation`，不挂 `install`（见 C4） |
| A3 | 检查 | 必做 | P0 | 支持 | `packages/adapters/omo/src/omo-adapter.ts`（轻路径 `src/command.ts`、`src/installation.ts`） | 实测探针：`omo --mode rpc --no-session` 下 get_protocol_info、get_state、get_commands、get_available_models 四条命令全部响应；`PI_OFFLINE=1` 握手 stdin EOF 干净退出；`omo --help` 暴露 `--mode <json\|rpc>`、`--session <file>` | 未安装→`notInstalled`；缺 Git Bash（win32）→`unavailable`；`purpose:"availability"` 只解析可执行+版本 |
| A4 | 创建 Session | 必做 | P0 | 支持 | `packages/adapters/omo/src/omo-adapter.ts`、`src/omo-rpc-session.ts` | 实测探针：spawn `omo --mode rpc` 后 get_state 返回 `currentTurnId/isStreaming/permissionPreset/pendingDialogs/lifecycle`；`--no-session` 不落盘、`--session <file>` 指定会话文件 | 省略 Model/Thinking 由原生决定；`omo.jsonc model_profile` 启动生效（实测 `omo-model-profile:applied` entry），故 initialState 以 get_state 为准（requested≠effective） |
| A5 | 执行 Turn | 必做 | P0 | 支持 | `packages/adapters/omo/src/omo-session.ts`、`src/omo-rpc-session.ts` | 实测探针 + `docs/rpc.md`：`prompt {message, clientTurnId}` 受理即返回 `disposition:"started", turnId`；事件 `turn_start` / `message_update`（text_delta、thinking_delta）/ `agent_settled`；`durable_client_message_id` 能力使断线重试安全 | `agent_end` 可能后随 auto-retry/compaction，turn.completed 只以 `agent_settled` 为准 |
| A6 | 取消 | 必做 | P0 | 支持 | `packages/adapters/omo/src/omo-session.ts` | `docs/rpc.md`：`abort {effectId, awaitIdle:true, graceMs, clearQueue:true}`；aborted run 的 `agent_end` 带 `aborted:true`/`abortSource` | abort 非阻塞，`idle:false` 不悬挂 execute；取消终态在 aborted 的 settlement 后唯一发出 |
| A7 | 只读快照 | 必做 | P0 | 支持 | `packages/adapters/omo/src/omo-history.ts` | 实测探针 method_classes 含 `get_entries`、`get_tree`、`find_session`；会话为 JSONL 树（entry id/parentId，`docs/session-format.md`）；分页 `since/limit/maxBytes/tail` 与 `response_too_large` 守卫 | 只投有效分支（`get_tree` 的 leafId 路径）；entry id 为身份源 |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | `packages/adapters/omo/src/omo-history.ts`、`src/omo-adapter.ts` | `omo --help` 确认 `--session <file>`；会话文件落在 `~/.omo/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`（本机确认）；resume 时以 get_state 的 sessionId/sessionFile 对齐 nativeRef | classic 模式不执行 `session_held` 守卫（`docs/rpc.md:4364`，仅 daemon 族 host 执行）→ 与用户自己的 TUI 同开会双写文件，残余风险与 POSIX 未验证见「受限与已知缺口」 |
| A9 | 错误与并发 | 必做 | P0 | 支持 | `packages/adapters/omo/src/omo-session.ts`、`src/omo-rpc-session.ts` | 实测/文档错误码：streaming 中再 prompt → `errorCode:"streaming"`（映射 retryable `sessionBusy`）；`provider_credentials_missing`/`expired` → `authenticationRequired`；`no_model_selected` → `configurationRequired`；`docs/rpc.md:4364` 错误码表 | close/fault 之后 `invalidState`；stderr 走 `sanitizeDiagnosticTail` |
| A10 | 关闭 | 必做 | P0 | 支持 | `packages/adapters/omo/src/omo-rpc-session.ts` | 实测探针：stdin EOF 后 omo 干净退出；Windows 进程树清理参照 `packages/adapters/omp/src/omp-rpc-session.ts:462`（`taskkill /t /f`），POSIX 用进程组 SIGTERM→SIGKILL | 幂等、结束 outputs、60s 预算、进程退出一律 fault 不隐藏 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | `packages/adapters/omo/src/omo-configuration.ts` | `docs/rpc.md:5228` `set_model`；实测 `get_available_models` 返回 `{provider, id, name, reasoning, contextWindow, maxTokens, cost}`；`model_changed` 事件 + effect receipt 为确认 | 必须带 `scope:"session"`（否则改写设备默认）；模型 ref 用 `{provider,id}` 复合（`packages/harness-adapter/src/composite-model-ref.ts`）；拒绝 `model_not_found`/`context_budget` 不改状态 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | `packages/adapters/omo/src/omo-configuration.ts` | `docs/rpc.md:5310-5327` `set_thinking_level`；thinking 枚举 off/minimal/low/medium/high/xhigh/max（`docs/json.md` 增量规则）；`reasoning` 字段决定可选性 | scope 必须是 `"turn"`，省略会改写全局记忆级别 |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | `packages/adapters/omo/src/omo-configuration.ts` + `inspect.permissionModes` | 实测能力位 `set_permission_preset_v1`；`docs/rpc.md:5549-5562` 响应 `permissionPresetStatus:"applied"`；get_state 含 `permissionPreset/Source/Status/effective`；`permissionModeScope:"live"` | 预设集在计划任务 10 以 get_state + 逐个 `set_permission_preset` 实测后冻结（不凭文档写常量） |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | `packages/adapters/omo/src/omo-adapter.ts`、`src/omo-configuration.ts` | 同上：`set_permission_preset full-access` + `applied` 原生确认；OMO 默认即 full-access 但仍需确认 | 显式非 full-access 的 permissionModeId + unattended 同时出现 → 类型化拒绝（`docs/` spec-session-core 冲突语义） |
| B5 | Fork | 原生有则必做 | P1 | 待验证 | `packages/adapters/omo/src/omo-history.ts`、`src/omo-adapter.ts`（计划任务 12） | `docs/rpc.md:5862-5885` `fork`（entryId 不含边界）、`:6054` `clone`；计划任务 12 以 `omo --mode rpc --fork <path>` 真机 gate 验证透传 | P1；由计划任务 12 的真机 gate 决定，任务 17 定稿（届时改为支持或类型化 unsupported） |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 不支持 | 声明 `history.forkAcrossCwd = false` | 会话文件按 cwd slug 落在 `~/.omo/agent/sessions/<cwd-slug>/`；classic fork 只复制会话文件内容，跨目录重绑定未验证（本机只验证了单目录会话） | 首版不做（计划 D-3）；声明 false 且不提供该能力 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 待验证 | `packages/adapters/omo/src/omo-history.ts`、`src/omo-adapter.ts`（计划任务 12） | `docs/rpc.md:5862-5885` `fork` + `:6054` `clone`；1-turn 会话无 parent entry，需派生新会话（不得就地 `navigate_tree`，`:5890-5923`） | P1；由计划任务 12 的真机 gate 决定，任务 17 定稿 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | `packages/adapters/omo/src/omo-session.ts` | 实测探针事件表：`tool_execution_start/update/end`、`message_update` 的 `toolcall_*`；`edit` 工具带 diff/patch；`compaction_start/end` | 映射 commandExecution(bash) / toolExecution / mcpToolCall(`mcp__` 前缀) / fileChange / contextCompaction；字段名以计划任务 9 采集的真实 trace fixture 校准 |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | `packages/adapters/omo/src/omo-session.ts` | 实测/文档 `extension_ui_request` method `select`：标题 `Permission required: <permission>`，options Allow once / Allow always / Deny / Deny with feedback，绑 `toolCallId`；回复 `{value}` / `{confirmed}` / `{cancelled:true}` | 效果仅 allowOnce/allowAlways/deny（OMO 无 allowForSession）；deny-with-feedback = deny + 同 toolCallId 的后续 input 对话框 |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | `packages/adapters/omo/src/omo-session.ts` | 同上：`input`/`confirm`/`editor` 对话框 + `question_resolved` 广播；get_state 的 `pendingDialogs` 供重连对账；`ui_answer_ledger` 能力位 | 不声明 `question` 能力，走顺序 fallback 对话框；超时 → `interaction.closed(expired)` 不卡死 Turn |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 不支持 | 不声明 `capabilities.subagents` | 原生 task children 只在 `session_lifecycle.waitingOn.children` 暴露计数；可读子代理 transcript 的原生面未验证（mass-ulw DAG 需 `extension_events`，Windows 无 task host） | 首版不做（计划 A-4）；不声明能力、不产生 subagentDelegation Item |
| B12 | 自主 Turn | 原生有则必做 | P1 | 支持 | `packages/adapters/omo/src/omo-session.ts` | `docs/rpc.md:4461-4521`（client IDs）、`:151-280`（`session_lifecycle.waitingOn`）；无 `clientTurnId` 的 `turn_start` 来自引擎自主回合 | 映射 `turn.autonomous.started` + 终态；`waitingOn.background` → `hasBackgroundWork()`，`interrupt {background:"stop"}` → `stopBackgroundWork()` |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | `packages/adapters/omo/src/omo-session.ts` | 实测探针：每条 assistant message 带 `Usage{input, output, cacheRead, cacheWrite, cost}`；get_state/get_session_stats 提供会话快照 | input 含 cache read/write、output 含 reasoning；数字不确定时为 null（宁缺勿错） |
| B14 | 请求级计量 | 原生有则必做 | P2 | 不支持 | 不发送 `usage.request` / `usage.history` | `get_protocol_info` 的 27 项能力位无请求级计量；原生 usage 只挂在 assistant message 与 get_session_stats 快照上，无单请求 ID 与逐请求事件 | 首版不做（计划 D-3）；不伪造请求级数据 |
| B15 | 接收委派 | 必做（验证项） | P1 | 支持 | 公共委派路径 + `packages/adapters/omo/src/omo-session.ts` | `packages/host-runtime/src/harness-delegation-coordinator.ts`（只读，无新接口）；A8/A9/B4 成立后委派只是验证项，计划任务 15 执行验收矩阵 | 忙时 `sessionBusy` 不排队；cancel 保留身份；`input.environment` 直达 omo 进程 |
| B16 | 向下委派 | 原生有则必做 | P2 | 不支持 | 不注入委派发现信息 | codexhost 的三种发现方式（Host skill 装 `~/.agents/skills`、`--append-system-prompt`、进程内 skill）在 omo 上均未实测；`--tools`/`--append-system-prompt` 是否被 omo 包装层透传未验证（计划 A-4） | 首版不做；如实报告「不能向下委派」 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | `packages/adapters/omo/manifest.json` | 计划任务 2/14；manifest schema `packages/shared-contracts/src/harness-plugins.ts:133-142`；`notice`（en + zh-CN）披露 omo 是独立第三方产品、SUL-1.0 使用限制与商标归属（计划 D-8） | 图标自绘，不复制 OMO 资产；links 三 URL 已验证 HTTP 200 |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | `packages/adapters/omo/manifest.json` → `installation.commands` | 官方分发事实（`.omo/drafts/add-omo-harness.md`「oh-my-openagent/senpi」分发节）：`curl -fsSL https://get.omo.dev/install.sh \| bash`、`irm https://get.omo.dev/install.ps1 \| iex`、npm 备选 `bun add -g omo-ai`（Node≥24） | before/after 说明两渠道；只展示指引，不自动安装 |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | `packages/adapters/omo/src/installation.ts` | `omo --version` 实测 = `omo 5.1.83 (engine: senpi 2026.11.23)`；本机 `install.json` 显示 5.1.33 而实际 5.1.83（stale 实证）；`omo update` 为官方更新命令（`omo --help`） | 版本只信 `omo --version`，不读 install.json；无稳定 latest 源 → `latestVersion:"Unknown"` + `latestVersionKind:"unknown"`，渠道未证实 → `canUpdate:false` |
| C4 | 首次安装 | 可选 | P2 | 不支持 | 不提供 `adapter.install()` | 计划 D-8：OMO 负载 SUL-1.0，适配器不自动安装该软件，只提供安装指引（C2），且不捆绑任何 OMO 代码或二进制 | 首版不做；连接页不出现一键安装 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 不适用 | — | 条件不成立：omo 是独立 CLI，装在 PATH 与安装根（`~/.local/bin` 等）即可发现，不随桌面应用私藏（`omo --help` 实测） | 仍支持 `CODEXHOST_OMO_COMMAND` 环境覆盖（`HarnessDiscoverySpec.commandEnvironmentVariable`） |
| C6 | 会话导入 | 可选 | P2 | 不支持 | 不提供 `adapter.sessionImport` | 原生会话文件 `~/.omo/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl` 可读，但导入面首版不做（计划 D-3） | 首版不做；不向导入页投射候选 |
| C7 | 全局用量统计 | 可选 | P2 | 不支持 | 不提供 `adapter.usageStatistics` | 原生 `omo --help` 无全局用量命令；跨会话统计只能只读扫描 `~/.omo/agent/sessions/` 的 JSONL，成本面未验证（计划 D-3） | 首版不做；统计页无 OMO 行 |
| C8 | 账号额度 | 可选 | P2 | 不支持 | 不提供 `inspectAccount()`/`credits()` | `.omo/drafts/add-omo-harness.md`「接口映射咨询」C8 项：`get_subscription_limits` 只覆盖 Claude/ChatGPT 订阅窗口；API-key 账号无额度面，不提供 balance() | 首版不做；不伪造额度 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | 根 `tsconfig.json` references、`package-lock.json` | 计划任务 16；构建器 `packages/harness-adapter/scripts/build-plugin.mjs:23`（esbuild ESM node22 → plugin.mjs）；无新增运行依赖（纯 Node stdio + `@codexhost/*` 公共导出），不改 `runtimePackages` | 与 `scripts/release/harness-plugins.mjs:19` 的路径约束 `^packages/adapters/[a-z0-9-]+$` 一致 |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | `scripts/release/harness-plugins.json` → `plugins` | 计划任务 16；现有 20 个适配器全部预装的惯例（`scripts/release/harness-plugins.json:2-23`） | 无 `runtimePackages` 新增 |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | `packages/host-runtime/test/installed-harness-plugins.test.ts` | 计划任务 16：classes 表加 `omo`，commands 表加 `["omo","CODEXHOST_OMO_COMMAND"]`（现有结构 `:16-36`、`:80-97`）；另有仓库外临时根真实 Loader 冷加载 | 冷加载验证不能由直接 `new Adapter()` 代替 |
| D4 | 文档 | 预装时必做 | P1 | 支持 | `docs/harnesses/omo/omo-harness-integration.md`、`docs/index.md`、`docs/harnesses/capability-boundaries.md`、三份 README 能力表、`docs/architecture/harness-plugin-runtime.md` 安装/更新表 | 计划任务 17（GAP-3）；既有先例 `docs/harnesses/codebuddy/`、`docs/harnesses/workbuddy/` | 集成文档须含 classic 双开残余风险、Windows Git Bash 依赖、SUL-1.0 许可与商标披露 |
| D5 | 其他 | 可选 | P2 | 不适用 | — | 不预设 `agent-group-preference.ts` 排序，不改 `tools/renderer-binding` 诊断名单（计划 Scope OUT：不加按 ID 分支） | 首版不做 |

## 受限与已知缺口

- **B5 Fork（待验证，P1）**：原生有 `fork`（`docs/rpc.md:5862-5885`，`fork(entryId)` 不含边界 entry）与 `clone`（`:6054`），但 `omo` 包装层是否透传 `--fork` 未验证。计划任务 12 在隔离环境做真机 gate：验证派生后身份独立、前缀保留；不通过则 `capabilities.history.fork = false` 且 fork 返回类型化 `unsupported`。计划任务 17 定稿本行。
- **B7 回滚最后一轮（待验证，P1）**：同上 gate。回滚必须派生新会话文件（`fork(nextUserEntryId)`），不得就地 `navigate_tree`（`:5890-5923` 会破坏调用方源会话，且 1-turn 会话无 parent entry）。不通过则 `history.rollbackLastTurn = false` + 类型化 `unsupported`，任务 17 定稿。
- **steer（插话，模板无独立行）**：原生有 `steer`（`docs/rpc.md:4722`，带 `expectedTurnId`/`turn_conflict` 守卫）与 `steer_when_idle` 能力位；本清单不单列行，其支持与否由计划任务 11 的真机 gate 决定（仅原生 root 工具窗口开放期间声明 `capabilities.steer`；投递不确定时抛错不重发）。gate 未过即不声明并返回 `unsupported`，随任务 17 定稿。
- **A8 classic 模式双开残余风险**：classic 模式不执行 `session_held` 守卫（`docs/rpc.md:4364`，仅 daemon 族 host 执行）。用户自己的 OmO TUI 正打开同一会话文件时，codexhost 的 classic resume 可能同时写入；适配器不做 `session-holders` 目录硬拒（会用 stale holder 卡死崩溃恢复），只在文档与本清单记录风险。
- **A8 POSIX 未验证**：本机为 Windows（win32 x64）。macOS/Linux 上的进程组关闭、POSIX 信号路径与真实 omo 二进制链路尚未实测，只按参照实现记录；计划任务 9 的真机验收同样只在 Windows 完成，POSIX 结论须由远端/其他平台补验。
- **B3 预设集探测前置**：`permissionModes` 目录必须在计划任务 10 以真实 `set_permission_preset` 探测后冻结（文档提到 `accept-edits`/`auto`，未实测前不写入常量）；探测完成前 inspect 不提供 `permissionModes`。

## 插件外改动

- 根 `tsconfig.json` references 增加 `packages/adapters/omo`（预装类型/构建接线）。
- `package-lock.json` 增加 `@codexhost/adapter-omo` 工作区条目。
- `scripts/release/harness-plugins.json` 的 `plugins` 追加 `packages/adapters/omo`（预装清单；无 `runtimePackages` 新增）。
- `packages/host-runtime/test/installed-harness-plugins.test.ts` 增加 `omo` 的 classes 与 commands 两处断言。
- 文档：`docs/harnesses/omo/omo-harness-integration.md`、`docs/index.md`、`docs/harnesses/capability-boundaries.md`、`README.md` / `docs/project/README.zh-CN.md` / `README.ko.md` 能力表、`docs/architecture/harness-plugin-runtime.md` 安装/更新表。

以上均为「插件外文件清单」允许的发行与文档接线，不含任何 Harness 专用的 Host 或 Renderer 分支。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 | `npx vitest run --config tests/vitest.config.js packages/adapters/omo/test/`（计划任务 3-8、10-14） | 待实现（本任务仅建立清单） |
| 原生边界 | 本机探针：临时目录 spawn `omo --mode rpc`，发 get_protocol_info / get_state / get_commands / get_available_models；`PI_OFFLINE=1 omo --mode rpc --no-session` 握手 | 通过：四命令全部响应，`protocolVersion:1`、`serverVersion:5.1.83`、能力 27 项；stdin EOF 干净退出（2026-11-26，Windows） |
| 插件加载 | 仓库外临时隔离根 `discoverHarnessPlugins` + `loadHarnessPlugins` 冷加载（计划任务 2、16） | 待实现 |
| Host 集成 | `packages/host-runtime/test/installed-harness-plugins.test.ts`、`npm run build:plugins`、`tests/release/{host-bundle,payload,npm-package,lockfile-registry}.test.mjs`（计划任务 16、18） | 待实现 |
| 真实原生验收 | 计划任务 9/15：隔离 agent dir（`omo config agent-dir --json` 确认覆盖变量）、真实 omo 5.1.83、Windows、真实模型调用 ≤10 次 | 待执行 |
| Desktop / 委派 | 计划任务 19（Desktop 隔离实测）与任务 15（委派验收矩阵） | 待执行 |
