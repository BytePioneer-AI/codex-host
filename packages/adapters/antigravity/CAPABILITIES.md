# Antigravity CLI 能力清单

<!--
开发开始时：把本模板复制到插件目录 `CAPABILITIES.md`（仓库内为 `packages/adapters/<id>/CAPABILITIES.md`），
不要修改「#」「功能」「必做」「优先级」四列；先填写「结论」，实现后补全「实现位置」「证据」。
结论只能是：支持 / 不支持 / 受限 / 待验证 / 不适用。
规则与每行的接口、规范见 codexhost-add-harness Skill 的 references/capability-inventory.md。
-->

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `antigravity` |
| 原生接口与传输方式 | 官方 CLI ACP Server（`agy acp`，stdio NDJSON JSON-RPC 2.0，`@agentclientprotocol/sdk`） |
| 已验证的原生版本 | `agy 1.5.9`（最低要求 `1.5.8`，含 `usage_update`、`auto` 模式及审批/取消修复） |
| 交付范围 | 预装发行 / Desktop 产品接入 / 完整委派 |
| 参考插件 | `kimi-code`（ACP stdio 传输、elicitation 与 configOptions 状态映射）；`codebuddy`（ACP 交互、子代理工具投影与只读会话导入）；`workbuddy`（附加系统提示词跨 Harness 委派） |
| 最后验证 | 历史读取：2026-11-18，macOS（darwin arm64），`agy 1.5.11` 原生 SQLite 只读；其他能力矩阵：2026-11-15 |

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | `manifest.json` | 既有校验与 `installed-harness-plugins.test.ts` | ID 为 `antigravity` |
| A2 | 工厂 | 必做 | P0 | 支持 | `src/plugin.ts` | `test/plugin.test.ts`、`installed-harness-plugins.test.ts` | 传播环境变量并默认关闭后台自更新弹窗 |
| A3 | 检查 | 必做 | P0 | 支持 | `src/antigravity-adapter.ts`、`src/model-catalog.ts` | `test/antigravity-adapter.test.ts`；实测 `agy --version` / `agy models` | 校验最低 ACP 版本（`>= 1.5.8`），不创建用户会话 |
| A4 | 创建 Session | 必做 | P0 | 支持 | `src/antigravity-adapter.ts`、`src/acp-transport.ts` | `test/antigravity-adapter.test.ts`；实测 `session/new` | 未传配置时保持原生默认；预热不产生 `session/list` 空记录 |
| A5 | 执行 Turn | 必做 | P0 | 支持 | `src/antigravity-adapter.ts`、`src/acp-transport.ts`、`src/acp-projection.ts` | `test/antigravity-adapter.test.ts`；实测 `session/prompt` | 支持文本与图片输入、流式文本与思考块 |
| A6 | 取消 | 必做 | P0 | 支持 | `src/antigravity-adapter.ts`、`src/acp-transport.ts` | `test/antigravity-adapter.test.ts`；实测 `session/cancel` | 取消关闭活动交互与工具项，保留会话继续下一轮 |
| A7 | 只读快照 | 必做 | P0 | 支持 | `src/antigravity-adapter.ts`、`src/native-replay.ts`、`src/acp-projection.ts` | `test/native-history.test.ts`、`test/antigravity-adapter.test.ts` | 直接只读 `~/.gemini/antigravity-cli/conversations/<id>.db` 的 `steps`（用户输入、planner、警告），解码为事件后交给投影器生成稳定 Turn/Item；不启动 `agy`、不走 `session/load`；活动库读取已提交的 WAL 快照并跳过仍在生成或执行的步骤；数据库不可读或格式未知时报 `Antigravity history unavailable`，无本地镜像、无降级 |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | `src/antigravity-adapter.ts`、`src/acp-transport.ts` | `test/antigravity-adapter.test.ts`；实测 `session/resume` | 恢复对象保留持久身份；普通恢复的可写 `session/resume` 延迟到首次执行或配置操作，派生会话在交付前确认可写恢复 |
| A9 | 错误与并发 | 必做 | P0 | 支持 | `src/antigravity-adapter.ts`、`src/acp-transport.ts` | `test/antigravity-adapter.test.ts`、`test/acp-transport.test.ts` | 忙碌返回 `sessionBusy`，进程异常与鉴权错误归一化脱敏 |
| A10 | 关闭 | 必做 | P0 | 支持 | `src/antigravity-adapter.ts`、`src/acp-transport.ts` | `test/acp-transport.test.ts` | `session/close` + stdin 关闭 + 超时信号清理子进程 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | `src/antigravity-adapter.ts`、`src/model-catalog.ts` | `test/antigravity-adapter.test.ts`；实测 `session/set_config_option(model)` | 等待原生 `configOptions` 确认并同步动态推理档位 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | `src/antigravity-adapter.ts`、`src/model-catalog.ts` | `test/antigravity-adapter.test.ts`；实测 `session/set_config_option(thought_level)` | 支持 `low` / `medium` / `high` / `xhigh` 按模型动态裁剪 |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | `src/permission-modes.ts`、`src/antigravity-adapter.ts` | `test/permission-modes.test.ts`、`test/antigravity-adapter.test.ts`；实测 `session/set_mode` | 原生 `default`、`accept-edits`、`auto`、`plan` 实时切换，并兼容 `dangerously-skip-permissions` |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | `src/antigravity-adapter.ts`、`src/acp-transport.ts` | `test/skip-permissions.test.ts` | `unattended-full-access` 启动 `agy acp --dangerously-skip-permissions` 并写入 `locator` 供恢复保持 |
| B5 | Fork | 原生有则必做 | P1 | 支持 | `src/fork.ts` | `test/fork.test.ts` | 按用户输入或已结算唤醒边界克隆裁剪后经 `session/resume` 打开；源运行中仅限早于活动 Turn 的已确认用户回合 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 支持 | `src/fork.ts`、`src/antigravity-adapter.ts` | `test/fork.test.ts` | 克隆会话通过 `session/resume({ cwd })` 绑定新工作目录 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 支持 | `src/rollback.ts` | `test/rollback.test.ts` | 空闲态克隆并截断最后一个用户 Turn 或已结算的唤醒 Turn，不破坏源会话 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | `src/acp-projection.ts`、`src/tool-projection.ts` | `test/acp-projection.test.ts`；实测 `tool_call` / `tool_call_update` | 映射命令、工具、思考块与原生 `{ type: "diff" }` 文件变更 |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | `src/acp-projection.ts`、`src/antigravity-adapter.ts` | `test/acp-projection.test.ts`；实测 `session/request_permission` | 精确映射原生 `allow_once` / `allow_always` / `reject_once` |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | `src/acp-projection.ts`、`src/antigravity-adapter.ts` | `test/acp-projection.test.ts`；实测 `elicitation/create` | 声明 `elicitation.form` 原生接收单选/多选与自由输入，无需外部 Hook |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 支持 | `src/subagents.ts`、`src/subagent-transcript.ts` | `test/subagents.test.ts` | 识别 `invoke_subagent` 工具调用，结合 `conversation_summaries.db` 与 `brain/<id>` 读取状态与 Transcript |
| B12 | 自主 Turn | 原生有则必做 | P1 | 支持（结算后发布） | `src/wake-observer.ts`、`src/native-replay.ts` | `test/antigravity-adapter.test.ts`、`test/acp-transport.test.ts`、`test/native-history.test.ts`；`agy 1.5.13` 原生历史只读回放 | ACP 空闲通知无 stop reason；用 SQLite 系统消息与原生运行 ID 确认边界，发布与历史一致的无输入 Turn，不占用前台执行位 |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | `src/acp-usage.ts` | `test/acp-usage.test.ts`；实测 `PromptResponse.usage` 与 `usage_update` | 合并缓存输入与推理输出口径，实时上报上下文窗口与 Token 快照 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 支持 | `src/acp-usage.ts`、`src/native-request-timing.ts` | `test/acp-usage.test.ts`、`test/native-request-timing.test.ts`；真实转录与 SQLite 只读回放 | 输出已含思考；无工具调用且计时核验通过的请求以首个可见输出至生成结束计非思考 Token（`timedOutputTokens`）；思考数无法确认、全部为思考或整块工具参数时仅保留用量、不参与 TPS 或均值；客户端回退仍限零思考单请求；Turn 内按历史与本轮已完成请求累计费用，不计正在生成的请求，缺失用量仍声明不完整；重复回放不重复计费 |
| B15 | 接收委派 | 必做（验证项） | P1 | 支持 | `src/antigravity-adapter.ts` | `test/antigravity-adapter.test.ts` | 满足 A8 可写恢复 + B4 无人值守执行 + 环境变量传播 |
| B16 | 向下委派 | 原生有则必做 | P2 | 支持 | `src/delegation.ts`、`src/antigravity-adapter.ts` | `test/antigravity-adapter.test.ts`；实测 `_meta.antigravity.systemPrompt.append` | 注入环境变量并通过原生 `systemPrompt.append` 告知变量名 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | `manifest.json`、`src/permission-modes.ts` | `test/plugin.test.ts` | 含图标、链接与中英文权限模式文案 |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | `manifest.json` | `test/plugin.test.ts` | macOS/Linux 与 Windows 官方安装脚本及登录提示 |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | `src/installation.ts` | `test/installation.test.ts` | 复用 `agy update` 与版本解析 |
| C4 | 首次安装 | 可选 | P2 | 支持 | `src/plugin.ts` | `test/plugin.test.ts` | 使用 `createHarnessInstaller` 调用官方安装脚本 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 不适用 | — | `agy` 为独立命令行工具而非桌面应用私藏二进制；另支持 `CODEXHOST_ANTIGRAVITY_COMMAND` 环境变量覆盖 | |
| C6 | 会话导入 | 可选 | P2 | 支持 | `src/session-import.ts` | `test/session-import.test.ts` | 只读扫描 `conversation_summaries.db` 与 `conversations/<id>.db`，过滤空会话与子代理 |
| C7 | 全局用量统计 | 可选 | P2 | 支持 | `src/usage-statistics.ts` | `test/usage-statistics.test.ts`；实测跨会话分叉去重 | 只读解析 `brain/<id>/.system_generated/logs/transcript.jsonl`，归一 `1.5.9` `model` 并按 Gemini/GPT 隐式零缓存写与 Claude 未知缓存写区分计价 |
| C8 | 账号额度 | 可选 | P2 | 支持 | `src/quota.ts`、`src/antigravity-adapter.ts` | `test/antigravity-adapter.test.ts`；实测 `accounts/inspect` | 通过 `agy --print=/usage` 流式读取 `command_result` 配额窗口并维护独立账号缓存 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | `tsconfig.json`、`package-lock.json` | `npm run typecheck`、`npm run build:typescript` | 已在根工程引用中注册 |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | `scripts/release/harness-plugins.json` | `npm run build:typescript`（含 `build:plugins`） | `@agentclientprotocol/sdk` 与 `diff` 已在 `runtimePackages` |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | `packages/host-runtime/test/installed-harness-plugins.test.ts` | `npx vitest run -c tests/vitest.config.js packages/host-runtime/test/installed-harness-plugins.test.ts` | 真实 Loader 加载验证通过 |
| D4 | 文档 | 预装时必做 | P1 | 支持 | `docs/harnesses/antigravity/`、`docs/harnesses/capability-boundaries.md`、`docs/architecture/`、`docs/product/`、`docs/index.md` | 文档与链接核查 | 同步 ACP 现行架构、命令目录与请求级计量口径 |
| D5 | 其他 | 可选 | P2 | 支持 | `packages/host-runtime/test/antigravity-*.real.test.ts` | `CODEXHOST_RUN_ANTIGRAVITY_QUESTION_REAL=1` 实测通过 | 真实 `elicitation/create` 问答、取消与恢复测试兼容 |

## 受限与已知缺口

- 最低 CLI 版本要求 `agy >= 1.5.8`：早期 `1.1.x–1.4.x` 无 `agy acp`，`1.5.0–1.5.7` 缺少 `usage_update` 或存在权限二次弹窗/关闭保存缺陷；低于 `1.5.8` 时 `inspect` 返回明确升级提示，连接页可直接一键更新。
- Fork 与回滚：原生 `agy acp` 1.5.9 未实现 `session/fork` RPC（返回 `-32601 Method not found`），因此克隆 SQLite，按用户输入（`step_type = 14`）或已结算唤醒边界裁剪后调用 `session/resume`。回滚在活动 Turn 期间返回 `sessionBusy`；运行中 Fork 仅当目标是当前会话已确认完成、严格早于活动 Turn 的用户检查点、没有运行中的子代理、源库为 WAL 时放行。边界定位和克隆使用同一只读快照，不占用源会话，也不复制 `brain` 目录。裁剪时 `gen_metadata`、`executor_metadata`、`parent_references`、`battle_mode_infos` 按各自 protobuf 中的原生步骤索引保留前缀（行号不是步骤号），派生摘要由保留前缀重算。
- 自主唤醒没有 ACP 停止信号。仅在 SQLite 确认独立唤醒及最终回答后实时发布；超过有界观察期才提交的回答由历史读取恢复。不逐字发布未结算的唤醒，也不把无法确认的输出拼到前一轮。
- 权限模式中的 `dangerously-skip-permissions` 对应 CLI 启动参数 `--dangerously-skip-permissions`；在会话空闲态与普通 ACP 模式互切时，Adapter 在保持同一 `nativeSessionId` 的前提下重建进程并通过 `session/resume` 无缝恢复。
- 历史由原生 SQLite 读取，包含工具调用名称、参数与配对结果文本；读取不依赖 ACP 进程，耗时为毫秒级，由 Host 分页。连续的用户输入沿用既有分组规则合并为一轮，以保持已存 Turn 身份稳定。

## 插件外改动

- 共享 `turn.autonomous.completed` 允许只观测到原生已结算结果的 Adapter 提交快照；Host 去重并增量追加，Protocol Core 对空输入省略用户气泡。
- 历史终态的通用展示：`shared-contracts` / `protocol-core` 保留 unknown 终态元数据，`web-server` / `session-runtime` 保留 unknown 原因，Web UI 中性显示“已结束”，不加入 Antigravity 专用 Host 分支。
- `package-lock.json`：`@codexhost/adapter-antigravity` 增加工作区已有的 `@agentclientprotocol/sdk@1.3.0` 与 `diff@8.0.2` 依赖声明。
- `packages/host-runtime/src/usage-statistics.ts`：提升全局用量统计文件缓存版本号（`CACHE_VERSION` 至 `8`），使升级后重建 Antigravity 模型归一与隐式缓存写入统计。
- `packages/host-runtime/test/antigravity-question.real.test.ts`：对齐原生 SQLite 历史工具快照（校验实时 `item.completed` 与快照 `ask_question` 参数/终态）并清理测试在 `conversation_summaries.db` 中产生的临时记录。
- 文档同步：`docs/harnesses/antigravity/`、`docs/harnesses/capability-boundaries.md`、`docs/architecture/harness-plugin-runtime.md`、`docs/architecture/harness-command-integration.md`、`docs/product/usage-metering.md`、`docs/product/usage-statistics.md`、`docs/index.md`。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Turn 内费用累计 | `npx vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/acp-usage.test.ts packages/adapters/antigravity/test/antigravity-adapter.test.ts` | 147 项通过；覆盖历史基线、轮内多请求累计、重复刷新去重、轮末核对与缺失用量保护；未进行真实 CLI/UI 验证 |
| SQLite 历史读取 | `npx vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/native-history.test.ts`；只读读取 69 个真实主会话 | 读取全部成功，393 个已存 Turn ID 按原顺序保留；`readSnapshot` 中位数 0.61 ms、P95 9.03 ms，不启动 ACP |
| 用量对账与计时 | 既有测试会话的原生 SQLite / 转录只读回放，经过共享 `UsageMeter` | 单请求、多请求、原生问答及重复回放通过；无新增模型调用 |
| 原生边界 | 本机 `agy 1.5.9` 隔离探针（`initialize` / `session/new` / `prompt` / `request_permission` / `elicitation` / `load` / `resume` / `list`） | 已通过前置实测 |
| 插件加载 | `npm run build:typescript && npx vitest run -c tests/vitest.config.js packages/host-runtime/test/installed-harness-plugins.test.ts` | 插件打包与真实 Cordis Loader 加载通过 |
| Host 集成 | 独立 `CODEXHOST_DATA_DIR` 下 `HostRuntime` 全链路隔离验收（预热草稿配置选择、多轮对话、文件 Diff 与审批、Host 重启冷恢复、跨目录 Fork、Rollback、会话导入、会话与全局用量计价） | 5 阶段全链路实测全部通过，退出后 `agy acp` 残留进程为 0 |
| 真实原生验收 | `CODEXHOST_RUN_ANTIGRAVITY_QUESTION_REAL=1 npx vitest run -c tests/vitest.config.js packages/host-runtime/test/antigravity-question.real.test.ts` | 1/1 通过（真实 `elicitation/create` 回答、中途取消 `interaction.closed` 顺序、`session/resume` 恢复） |
| Desktop / 委派 | 向下委派（`CODEXHOST_*` 环境变量与 `_meta.antigravity.systemPrompt.append`）与无人值守接收委派（`unattended-full-access` + `session/resume`）单测及 Host 协议投影校验 | 通过（未改动用户正在运行的 Desktop 进程） |
