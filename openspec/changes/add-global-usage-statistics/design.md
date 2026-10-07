## Context

单会话用量（`add-host-usage-metering`）的数据流是：打开外部 Thread → Adapter 回放原生历史并发布 `usage.request` → Host `UsageMeter` 按请求 ID 去重 → 读时按价格目录计价。它只覆盖“在 CodexHost 中打开的会话”，只在内存中计量，不持久化。

全局统计要回答“这台机器上所有 Harness、所有会话一共用了多少、相当于官方价多少钱”，数据源必须是各 Harness 的本地会话存储，而不是“已打开的 Thread”。

本文记录调研事实、设计取舍、架构与已确认的决策。所有本机数据都是 2026-10-05 只读扫描所得，未修改任何原生文件。

## 设计取舍

| 方面 | 采用 | 不采用及原因 |
| --- | --- | --- |
| 数据源 | 只读各 Agent 本地会话存储（文件与数据库），从不启动原生进程 | 代理/网关逐请求日志：我们不是网关 |
| 分叉去重 | 各解析器按原生分叉规则“只在最初写入处计一次”（分叉时刻、seed 边界、前缀副本） | 跨数据源指纹去重：只有一种数据源 |
| 增量 | 按“路径 + 大小 + 修改时间”缓存解析结果，只增长的文件接着读；缓存落盘、带版本号、可从源重建 | 剪掉明细 + 日汇总：需要防重复补偿 |
| 计价 | 读时按生效价格计算，补价即更正历史 | 入库时存费用再回填 |
| 刷新 | 启动后后台预热；页面先拿缓存结果，超过 10 秒在后台重读；首次读取有进度 | 定时全量扫描 |
| 子代理 | 计入并归属父会话与其目录，不单独显示 | — |
| 官方 Codex | 统计 | — |

## 调研：本机数据与现有能力

### 各 Harness 的会话规模（本机）

| 存储 | 文件数 | 大小 |
| --- | --- | --- |
| `~/.pi/agent/sessions` | 2079 | 2.7 GB |
| `~/.codex/sessions`（官方 Codex） | 698 | 1.6 GB |
| `~/.grok` | 3909 | 1.3 GB |
| `~/.hermes` | 1723 | 677 MB |
| `~/.claude/projects` | 244 | 551 MB |
| `~/.zcode` | 170 | 371 MB |
| `~/.omp` | 819 | 203 MB |
| `~/.local/share/opencode`（`opencode.db`） | 5 | 105 MB |
| `~/.dsh` | 135 | 12 MB |
| `~/.workbuddy-ai/projects` / `~/.codebuddy/projects` | 146 / 53 | 7.2 MB / 2.6 MB |

### 跨会话重复的实测

按请求 ID 去重前后的输出 Token：

| Harness | 去重前 | 去重后 | 虚增 | 说明 |
| --- | --- | --- | --- | --- |
| Pi | 148261 条 / 7626 万 | 60527 条 / 3131 万 | 143.6% | 682/1924 个文件是分叉（头部 `parentSession`）；2198 条没有 `responseId`，用 `t<timestamp>` 兜底，副本保留时间戳所以仍能去重 |
| OMP | 1403 条 | 833 条 | 107.0% | 也是分叉：OMP 在会话头前多一行定宽标题，`parentSession` 不在第一行；重复集中在带 `parentSession` 的文件组 |
| Claude Code | 1046 万 | 781 万 | 34% | 按 `message.id` 去重；子代理 9 个文件、83 次请求 |

结论：全局统计 MUST 以请求为单位去重，不能把会话结果相加。去重键的稳定性（分叉、恢复、压缩后请求 ID 是否保持）需要每个 Harness 用真实数据确认。

### 现有代码能复用什么

- **会话枚举**：`HarnessAdapter.sessionImport.listCandidates()` 服务于“导入”，会过滤不可导入的会话，也不给文件指纹，不适合全局统计；统计由各读取器自己遍历存储目录。
- **用量解析**：各 Adapter 已有把原生历史转成 `HostUsageRequest` 的纯函数，口径已用真实数据验证：

| Harness | 现有解析函数 | 现在的输入来源 | 全局统计的读法 |
| --- | --- | --- | --- |
| Claude Code | `claudeUsageHistory(entries)` | 转录文件 | 读 `projects/*/<id>.jsonl` 与 `<id>/subagents/`（含 workflows），复用解析函数 |
| Pi / OMP | `piUsageHistory` / `ompUsageHistory` | 运行时经 RPC `getEntries()` | 读会话文件；头部 `parentSession` 的时间为分叉时刻，之前的条目不计；OMP 头部前有标题行，子代理与 advisor 在 artifacts 目录 |
| CodeBuddy / WorkBuddy | `historyUsageRequests(contents)` | 原生历史文件 | 同现有读法 |
| DeepSeek Harness | `deepSeekUsageHistory(events)` | 经 dsh 进程打开日志 | 直接读 `~/.dsh/sessions/*/session[.vN].jsonl[.zstd]`，只读最新格式；分叉按 `seedLength` 或 `session/end-seed` 截断 |
| OpenCode | `v2UsageRequest(message)` | 托管服务器 `message.list` | 只读 `opencode.db`（V1 表与 V2 `session_v2`/`session_message`，识别迁移进度）；子代理是带 `parent_id` 的会话 |
| ZCode | `zcodeUsageRecord(message)` | CLI `session/resume` / `session/read` | 只读 `~/.zcode/cli/db/db.sqlite`（OpenCode 表结构，输入含缓存、输出含思考） |
| Grok | 只有原生费用 | 原生 | 读 `~/.grok/sessions/<cwd>/<id>/updates.jsonl` 中 `turn_completed` 的按模型用量；分叉只计创建之后的事件；子代理看 `summary.json` 的 `session_kind` |
| Hermes | 暂缓 | — | 读 `state.db` 的“会话 × 模型”合计表（非逐请求） |
| 官方 Codex | 独立 `codex-usage` 插件 | 原生 rollout | 只读配置的 `CODEX_HOME` 下 `sessions/` 与 `archived_sessions/`（含 `.zst`），见下文 |
| Qoder / Qoder CN | `readQoderUsage`（全局读取器） | 两套原生 SDK 的 Anthropic-shaped JSONL | 两个发行版各自的 `projects/`；按 `message.id` 合并内容块，跳过带 `forkedFrom` 的复制行。两套 SDK 隔离分叉测试已验证最后复制行会改写时间；尚缺本机真实会话对账 |
| Kimi Code | `extractKimiUsageFromWireLog`（单会话累计） | `wire.jsonl` 的 `usage.record` | 已知 Token 桶，但本机无日志可核对每请求身份、时间、模型与分叉；暂不暴露能力 |
| Antigravity | 运行时用量投影 | 运行时事件 | 本机原生 conversations 目录为空；Host 历史镜像不能代替全部原生会话用量，暂不暴露能力 |
| Kiro CLI | credits、上下文比例 | 本机 23 份 `messages.jsonl` | 未发现可靠 Token 桶，不用 credits 换算 |
| Cursor CLI | 会话消息（非 Token） | 本机 21 个 `store.db` | JSON 消息无用量字段；未知 protobuf 字段不作推测 |

- **计价**：`ModelPriceCatalog`（models.dev 快照 + 每日刷新 + `pricing.json`）与按模型 ID 的自定义价格编辑器已完成，可直接复用。
- **Qoder 读取边界**：不调用 SDK 的会话视图枚举（它会过滤当前分支），只读主会话与子代理原始 JSONL；配置根目录遵循各自 SDK 的 `*_CONFIG_DIR`、`*_CLI_HOME`。原生分叉改写行 UUID，且可能改写最后一行时间，因此只计原始请求而跳过 `forkedFrom` 副本；父文件删除后不保证恢复这些请求的归日。缺必要 Token 桶、ID 或时间不估算，缺模型保留 Token 但不猜模型。此变化不修改公共契约、Host 汇总或页面。
- **数据缺口**：`HostUsageRequest` 只有成对的 `startedAtMs`/`completedAtMs`，且仅在有可靠计时时出现；历史请求多数没有。按日统计改用每条原生记录自带的时间戳，由读取器返回，不改单会话契约。

### 官方 Codex rollout 的规则

- 每轮 `turn_context` 给出当时的模型；`token_count` 同时给累计总量与最近一次请求用量。按累计计数器的检查点求差得到每次请求，处理计数器重置。
- `input_tokens` 含缓存读与缓存写，计价前扣除。
- 恢复后可能续写到同一 thread id 的另一文件，需要合并分段。
- `sessions/` 与 `archived_sessions/` 可能有副本：只有能逐字证明一份是另一份前缀时才视为重复，取较长者；比较结果按文件身份缓存。
- 压缩请求只计一次，即使用量同时出现在嵌入快照与顶层记录；子代理分页历史以“恢复的压缩”开头，不重复累加。
- 新旧计数器口径不同（新的含压缩请求），配对比较时不混用。

## Goals / Non-Goals

**Goals**

- 本机全部原生会话（含官方 Codex 与全部受支持 Harness，不区分是否经 CodexHost）的 Token（输入/输出/缓存读/缓存写/推理）、缓存命中、按官方价的费用估算。
- 分叉复制的历史只计一次；子代理计入父会话；读时计价，补价即生效。
- 增量与预热：首次读取有进度，之后打开页面直接显示缓存结果并在后台更新。
- 未计价模型可见，并能直接补价。

**Non-Goals**：见 proposal。

## 架构

```text
设置页（Console / Desktop）
   │ codexhost/usage/statistics/{get,overview,progress}
   ▼
Host Runtime: UsageStatistics（新模块）
   ├─ 启动后延迟预热；结果按范围缓存，超过 10 秒在后台重读
   ├─ 插件读取器：会话 Adapter 的可选能力 + 仅统计插件（如 codex-usage）
   │     listSources() → [{ sourceId, fingerprint }]
   │     read(sourceId, continuation?) → 记录[]（已排除分叉副本；含时间、模型、Token、会话、目录、是否子代理）
   ├─ 解析缓存：<数据目录>/usage-statistics/（带版本号，损坏或版本变化即重建）
   ├─ 兜底去重：(来源, 记录 ID) 先到者生效
   ├─ 聚合：按筛选条件（范围、Harness、模型、项目、日期）一次遍历算出各分面
   └─ 读时计价：ModelPriceCatalog.lookup()，未计价模型单独列出
```

- **所有权**：所有原生存储位置、格式、分叉与子代理统计规则只在所属插件；官方 Codex 也不例外，独立包为 `packages/adapters/codex-usage`。Host 只见统一记录，不拥有 Codex 私有解析。用户已确认不重做 Codex 聊天、分叉和恢复操作，仅新增 Token 与费用统计能力。
- **仅统计插件**：Manifest 的 `kind: "usage"` 选择 `createUsageStatisticsAdapter` 工厂，返回 `harnessId`、`usageStatistics`、`close`，不要求 `inspect/open`，不调用会话预取。复用同一 Loader、启用文件、超时与关闭机制；Registry 区分可创建 Session 的 Adapter 与纯统计源，后者不进入聊天路由。`codex-usage` 是插件身份，官方 `codex` 路由保留；没有 Codex 专用 Host 分支。
- **原生接口原则的例外**：为统计而只读原生文件与数据库（不启动进程、不写入），由用户确认；仅限读取器，不影响会话接入方式。读取数据库时必须只读打开，容忍对方正在写入。
- **插件式可选能力**（用户 2026-10-05 确认）：与 `sessionImport`、`subagents`、`webUi` 一样是可选字段。实现了，Host 就把该 Harness 并入统计；未实现或读取失败，只是缺这一部分，不影响其他 Harness。只统计已启用的插件（有意的边界，不扫描未启用的 Agent）。读取器可逐个上线，公共层与页面无需改动。
- **新增可选 Adapter 能力**：`listSources()` 给出不读内容即可得到的指纹；`read()` 支持从上次位置继续（只增长的文件），MUST NOT 启动进程或模型 Turn、MUST NOT 修改原生存储，资源有上限。
- **页面**：设置页“用量统计”，控制台与 Desktop 共用。时间范围（今天 / 7 天 / 30 天 / 90 天 / 全部），可按 Harness、模型、项目与某一天筛选，由 Host 按筛选条件聚合；总览（费用、Token（不含缓存读写）、缓存读取、请求、项目、会话，含与上一周期对比）；趋势（按日/周/月，按 Harness 堆叠）；按时段；按 Harness、模型、项目分解；最耗会话；未计价时提示并可补价；导出 CSV。不做工具、技能、活跃时长与会话管理。

## 已决策（2026-10-05）

- **D1 官方 Codex**：统计。由独立可加载的 `codex-usage` 插件按上文规则实现；不在 Host 中实现，也不接管原生会话操作。
- **D2 范围**：本机全部原生会话，不区分是否经 CodexHost。
- **D3 发生时间**：用原生记录自带时间戳，由读取器返回；不改单会话契约。
- **D4 覆盖与读法**：直接只读各 Harness 本地存储（含 OpenCode/ZCode 数据库、dsh、Grok、Hermes），不启动原生进程。
- **进程约束**（用户 2026-10-05 强调）：全局统计不为此专门启动任何进程——既不启动 Harness 原生进程或其托管服务器，也不另起独立的扫描进程；读取与汇总都在已运行的 Host Runtime 内完成。为避免大文件解析阻塞 Host 的事件循环，解析分批让出或放在 Host 内的工作线程中执行，并限制并发与内存。
- **D5 刷新**：启动后预热；先给缓存、过期后台重读；首次读取显示进度；不做定时扫描。
- **D6 展示**：最初只做时间范围、总览、按日趋势、按 Harness、按模型（含未计价补价）。2026-10-07 用户决定扩展：读取器返回原生会话 ID 与工作目录，增加按项目、最耗会话、按时段、上一周期对比与 CSV 导出，聚合移到 Host 按筛选条件计算。工具、技能、活跃时长与会话管理仍不做。
- **去重方式（实现时调整）**：原设想按“分叉时刻”截断副本；第一期 5 个 Harness 的副本都保留原请求 ID 与时间（本机数据已验证），因此改为读取器原样返回、Host 按（Harness, 记录 ID）去重。这样父会话文件被删除后，副本里的请求仍计入一次；分叉时刻截断在这种情况下会丢失用量。ID 不稳定的 Harness 仍须按原生分叉规则截断。
- **D7 子代理**：计入其父会话所属 Harness 的用量，不单独显示占比。

## Risks / Trade-offs

- [请求 ID 在分叉、恢复、压缩后不稳定会导致漏去重或误去重] → 每个 Harness 上线前用本机真实数据核对“去重后合计 = 原生自身统计”（与单会话验收一致）。
- [首次全量解析耗时长（Pi 2.7 GB）] → 后台增量构建、可显示进度与部分结果；解析有并发与内存上限；结果缓存落盘。
- [缓存与原生数据不一致] → 缓存只是派生数据，带格式版本号；版本变化或损坏时丢弃重建。
- [读时计价改变历史数字] → 与单会话口径一致，是预期行为；页面标注“按官方公开价估算”。
- [未计价比例高时总费用偏低] → 总费用显示为下限（`≥$`），并列出未计价模型及其 Token 量，引导补价。
- [持久化与单会话“只在内存计量”原则不同] → 全局缓存是可删除、可重建的派生数据，不是账本；不影响单会话计量。

## 工作量与分期

按预估代码量（统计核心约 2400 行；读取器 50–530 行；官方 Codex 约 1300 行，不含测试）粗估，一人全职约 3–4 周：

| 期 | 内容 | 估计 |
| --- | --- | --- |
| 一 | 契约、Host 汇总与缓存与预热、页面（含手写 SVG 趋势图）、Claude Code / Pi / OMP / CodeBuddy / WorkBuddy 读取器与真实数据核对 | 约 1.5 周 |
| 二 | 官方 Codex 读取器（风险最高） | 4–6 天 |
| 三 | OpenCode、ZCode、DeepSeek Harness、Grok、Hermes（Hermes 需先确认字段含义） | 约 1–1.5 周 |

## Open Questions

- Pi、OMP 各自的会话文件条目是否与其 RPC `getEntries()` 一致：开发阶段一次性核对，决定能否直接复用 `piUsageHistory` / `ompUsageHistory`；不影响方案。
- 各 Adapter 实例化与调用读取能力是否完全不触发进程或连接，需逐个确认。
