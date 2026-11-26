# OmO native Harness plugin

OmO 插件把 oh-my-openagent 的官方 CLI 作为预装的 `omo` Harness 运行。插件只通过公共契约工作：发现与启动 `omo` 可执行文件、以 `omo --mode rpc` 子进程建链、把原生事件投影为公共 Item，不模拟任何 OmO 私有界面，也不捆绑或再分发 OmO 本体。能力清单与逐行证据见 [`packages/adapters/omo/CAPABILITIES.md`](../../../packages/adapters/omo/CAPABILITIES.md)，本文记录接入决策、协议门槛与用户可见边界。

## 接口选择与已验证版本

接入面是原生 CLI 的 classic stdio JSONL RPC（`omo --mode rpc`），由 senpi 引擎提供、与 Pi 的 RPC 同源但协议演进更快。启动后先做 `get_protocol_info` 能力协商，能力协商与版本门槛满足才建链：

- `protocolVersion` 必须为 `1`（适配器只支持这一个协议版本）。
- `serverVersion` 不低于 `5.1.83`。这是适配器的支持边界，不是上游兼容规则：较新的 5.x、6.x 版本只要保持协议版本 1 与既有能力位就可以通过；协议版本变化或测试边界以下版本返回类型化错误。
- 帧是 LF-only JSONL，逐行即帧；分帧器自写（`node:readline` 会把合法 JSON 字符串里的 U+2028/U+2029 拆开，不能用于行切分）。单条记录上限 16 MiB，未知事件类型忽略不断连。

实测基线：**omo 5.1.83**（`omo 5.1.83 (engine: senpi 2026.11.23; scheme nodef)`），`protocolVersion: 1`、`mode: classic`、引擎序 `[5,1,83,0,0]`、能力位 25 项（早期探针记 27，以 live 为准；见 `.omo/evidence/task-9-add-omo-harness.md`）。

**为什么只用 classic stdio**：在 Windows 上 `omo thread` 与 `omo daemon` 直接以退出码 4 失败，进程内 SDK 与共享 host 都不可用；classic stdio 子进程是三个平台上唯一可验证的原生启动面，进程模型与 Host 的所有权模型一致（每个可写 Session 一个子进程，Host 负责进程树回收），也直接复用 pi 家族的成熟模式。适配器不接 daemon 或共享 host，不把 CLI 名字相近当成协议兼容。

## 会话与 Turn 语义

- 会话文件落在 OmO 选定的 agent dir 下 `sessions/<cwd-slug>/<timestamp>_<id>.jsonl`，是 JSONL 树（entry 的 id/parentId 构成身份）。适配器只读该格式做快照投影，只投 `get_tree` 的有效分支，Turn 以用户消息 entry 为根。
- `turn.completed` 只以 `agent_settled` 为准：`agent_end` 之后还可能跟着 auto-retry 或 compaction（实测 provider 连接错误时引擎自行退避重试 5 次，期间适配器不发终态）。
- 取消走 `abort {clearQueue:true}`，非阻塞；取消终态在 aborted 回合结算后唯一发出，取消后立刻可以开始下一轮。
- close 幂等：stdin EOF 后限时等待，Windows 对进程树 `taskkill /t /f`，POSIX 走进程组 SIGTERM 再 SIGKILL；命令有 60 秒预算，outputs 流结束。进程提前退出或关闭失败一律 fault，不隐藏。
- 启动即声明 `set_client_info ["interactive_user"]`；不声明 `question`（提问走顺序 fallback 对话框），不声明 `secret_input_v1`（它需要专用安全路由）。

## 能力概览

| 面 | 状态 | 说明 |
| --- | --- | --- |
| 对话（create / turn / cancel / resume） | 支持 | 真机全链验证：流式 text_delta 与 thinking 投影、唯一终态、取消后立即下一轮、崩溃重开 resume 身份一致续写 |
| 工具、命令、文件内容 | 支持 | `commandExecution` / `toolExecution` / `fileChange`（diff）/ `contextCompaction` 投影；真实 trace 已校准字段名 |
| 审批与提问 | 支持 | 权限审批绑定 `toolCallId`，效果 allowOnce / allowAlways / deny / deny-with-feedback；提问经公共 `HostQuestionInteraction` 顺序对话框发布，无人接时按超时关闭不卡死 Turn |
| Model / Thinking 切换 | 支持 | `set_model {scope:"session"}` 与 `set_thinking_level {scope:"turn"}`，响应加 get_state 双确认后才发布（requested ≠ effective）；原生拒绝走类型化错误、状态不变 |
| 权限模式 | 支持 | 目录在真实 5.1.83 上逐候选探测后冻结：`full-access` / `workspace` / `read-only` / `ask` / `accept-edits` / `auto` 六值全部返回 `applied`；`permissionModeScope:"live"` |
| 无人值守 | 支持 | `unattended-full-access` 打开时发 `set_permission_preset full-access` 并等待原生确认，未确认即类型化拒绝；显式非 full-access 与 unattended 同出则开窗前拒绝 |
| Fork | 支持 | `--fork <source>` 启动副本 + `fork(entryId)`（不含边界）；源会话 sha256 不变，派生身份互异；`forkAcrossCwd:false` |
| 回滚最后一轮 | 支持 | 同 fork 机制；1-turn 回滚得空白会话，5.1.83 不落盘该空白，由适配器写同 id header 后 `--session` 重开持久化 |
| steer（同轮插话） | 支持（动态声明） | 只在原生 root 工具执行窗口打开期间声明 `capabilities.steer`；入队需要原生 `queued` 回执，结算按 user entry 计数对账 |
| 自主 Turn 观察 | 支持 | 无 `clientTurnId` 的 `turn_start` 投影为独立 Turn，宿主操作占用前台时缓冲补放不丢弃；`ephemeral` 回合无历史身份 |
| 会话用量 | 支持 | `get_session_stats` 锚点 + assistant message usage 增量；数字不确定时为 null，costUnknown 时不含造费用 |
| 接收委派 | 支持 | spec-delegation 验收矩阵 a-i 全过 + 一次真实委派回合；`input.environment` 直达子进程 |
| 连接页 | 支持 | 展示元数据、三平台安装指引、版本检查；更新渠道未在真机验证，`canUpdate:false` 只给 `manualUpdateUrl` |
| 原生 Subagent / 向下委派 / 请求级计量 / 会话导入 / 全局统计 / 账号额度 / 首次安装 | 首版不支持 | 原生依据与声明见 `CAPABILITIES.md` B6/B11/B14/B16/C4/C6/C7/C8，不伪造空实现 |

## 安装

安装指引来自官方分发渠道（manifest 三链接 2026-11-26 实测 HTTP 200）：

```sh
curl -fsSL https://get.omo.dev/install.sh | bash   # macOS / Linux
irm https://get.omo.dev/install.ps1 | iex          # Windows PowerShell
bun add -g omo-ai                                 # 任意平台，Node.js 24+
```

安装后请在终端运行一次 `omo` 完成配置；npm 包路线需要 Node.js 24 或更高版本。

插件不提供一键安装（`adapter.install()`）——OmO 负载按 Sustainable Use License (SUL-1.0) 许可，codexhost 不代替用户执行安装，也不捆绑其任何代码。

## 版本检查与更新

只信原生 CLI 自己的非交互检查：`omo --version` 解析已装版本，再跑 `omo update --dry-run`（帮助文本明示只检查不执行）获取最新版本。原生回报「已是最新」时以该句解析最新版本；读不懂、检查失败或该版本没有 `--dry-run` 时，`latestVersion:"Unknown"`，从不拿现值冒充最新值。已装版本的读取不碰 `~/.omo/install.json`（内容已实测 stale）。

更新编排代码路径已实现（`omo update`，300 秒上限，更新后版本回读差异校验，并发合并为一次原生运行），但 `omo update` 的自替换安装从未在真机执行过，更新渠道未证实，所以 `canUpdate:false` 保持生产默认，连接页只给 `manualUpdateUrl`（`https://omo.dev/docs/install`）。打开自动更新的条件是一次隔离环境的真机更新验收（旧版本到新版本、记录版本变化与安装路径不变）。

## 认证与数据隔离

认证、模型目录、权限设置和会话存储全部由用户自己安装的 omo CLI 与其 agent dir 决定。插件只 spawn `omo --mode rpc` 并传入调用方提供的环境与 cwd，不读 `~/.omo` 下任何配置或凭据，不写全局配置。QA 验证使用原生 `OMO_CODING_AGENT_DIR` 覆盖变量把整个 agent dir 指向隔离目录（覆盖变量经 `omo config agent-dir --json` 实测确认生效），~/.omo 前后快照 diff 无可归因写入。委派方通过 `input.environment` 注入的变量原样到达 omo 子进程（`PI_TELEMETRY:0` 恒设）；`CODEXHOST_OMO_COMMAND` 可覆盖项为可执行文件，由公共 discovery 解析。

## 已知边界

以下边界逐条映射自 `CAPABILITIES.md` 的「受限与已知缺口」，全部有实测出处：

- **classic 双开**：classic 模式不执行 `session_held` 守卫。实测是正面漂移——活进程持有者会被引擎拒绝（`Not opened: This session is open in another process (pid ...)`，exit 76 映射为 retryable `processExited`）。残余风险只剩并发打开的竞态窗口与 stale holder（进程已死、登记未清）路径，后者未实测；适配器不做 session-holders 目录硬拒。
- **POSIX 未验证**：本机为 Windows（win32 x64），macOS/Linux 上的进程组关闭、信号路径与真实二进制链路未实测，只按参照实现记录。
- **Windows Git Bash 依赖**：OmO 的 shell 工具需要 Git Bash 在 PATH 上，除非引擎 `defaultTools`/`shellPath` 选了其他 shell。适配器从不探测 Git Bash、缺省不判不可用，只在 win32 上握手失败时在诊断里附提示。
- **取消轮历史投影**：被取消的 Turn 实时终态是 cancelled，历史快照读作 succeeded（5.1.83 持久 entry 不带 aborted 标记）。实时语义不受影响，作为确定性限制记录。
- **派生中间文件**：每次成功 Fork / 回滚留下一个 `--fork` 启动副本文件（目标会话 `parentSession` 指向它，删除会让派生链悬空）；失败路径由适配器删除本次创建的文件。1-turn 回滚的空白会话由适配器写 header + `--session` 重开持久化，适配器不 invent 会话 id。
- **引擎在空白会话上不自删文件**：无对话的 create→close 后引擎保留空会话文件；由适配器负责清理（只有 create-kind 且从未受理 Turn 的会话才删，resume-kind 与有对话的会话保留）。
- **引擎侧目录残余**：senpi-memory 扩展把运行时痕迹写进全局 `~/.omo/memory/agents/<project-slug>/`，`OMO_CODING_AGENT_DIR` 不覆盖 memory 仓库根（引擎侧路径，适配器无法阻止）；引擎懒加载的 lsp-daemon 脱离进程树，close 的 taskkill 杀不到，定性为引擎基础设施进程。
- **shell 路由**：5.1.83 默认把 bash/powershell/grep 包进 eval 工具，适配器在实时与历史两处识别 eval 形状为 `commandExecution`（双路径并存）。
- **键入冲突**：settlement 窗口里引擎回合多出的 user entry 只在已被观察归属时排除；`get_entries` 应答之后才写出的 entry 仍按 fault 保守处理（归属优先于猜测）。
- **版本与平台**：所有真机 gate 覆盖 Windows x64、omo 5.1.83、classic RPC；其他 OS 与后续版本按协议门槛与原生响应为准，不以本轮观察硬编码为永久能力。

## 插件、路由与许可

插件源码在 `packages/adapters/omo`，经 `scripts/release/harness-plugins.json` 预装（Manifest、Adapter、Session、Native Ref 使用一致的身份 `harnessId:"omo"`），与所有插件共用动态 Loader 和共享 Thread 路由。构建产物只有 Manifest、入口 bundle 和图标资源，不含 OmO 的任何代码或二进制。

## License 与商标

OmO（oh-my-openagent）是独立分发的第三方产品，不属于 codexhost，也不随 codexhost 一起分发，与其无隶属关系。OmO 采用 Sustainable Use License (SUL-1.0)，对再分发和商业使用有使用限制；安装或使用前请阅读该许可证。codexhost 只负责启动你自行安装的 omo CLI。OmO 与 oh-my-openagent 是各自权利人的商标。

## 验证状态

最后验证 2026-11-26，Windows（win32 x64），omo 5.1.83，全部门梯度与套件计数见 `CAPABILITIES.md`「验证记录」：

- T2 仓库外真实 Loader 冷加载（有/无 omo 三模式、安装能力只挂 `installation`）。
- T9 真机 P0 全链：inspect / open / 真实回合 / 取消后下一轮 / 真机审批往返 / resume ×2 续写 / close 进程树双回执 / 会话落点与 ~/.omo 卫生。
- T10 预设探测 + 配置真机 gate：六档权限目录冻结、model.select 与权限切换的 `applied` 确认链、B4 无人值守、按模型不支持档位的 typed 拒绝。
- T11 steer 真机 gate：工具窗口内插话 `queued` 入队、同 Turn 续跑、结算计数对账。
- T12 派生真机 gate：`--fork` 透传、6 次派生、1-turn 空白持久化、失败清理。
- T13/T20 合成 fixture：自主回合观察、会话用量、后台工作，以及 settlement 重叠窗口的修复。
- T14 连接页与更新（fake transcript 27 例 + manifest schema 逐字段核对）。
- T15 委派验收矩阵 a-i 全过 + 一次真实委派回合（真实 provider 请求 1 次）。
- T16 预装发行接线：`npm run build:plugins`、四项发行测试、加载测试与负向断言。
- 全套件 `npx vitest run --config tests/vitest.config.js packages/adapters/omo`：266 passed / 2 skipped（live 门控文件无标记按设计跳过）。

真实模型调用合计 13 次（T9=7、T10=3、T11=2、T15=1），与 2026-11-26 用户批准的上限 13 一致。尚未完成：POSIX 实机验收、Desktop 隔离实测（计划任务 19）、`omo update` 真机自替换验收（`canUpdate` 翻真的前置条件）、真实引擎上的自主回合触发复核。