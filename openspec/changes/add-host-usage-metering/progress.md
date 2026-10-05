# Host 用量计量：进展与交接

更新于 2026-10-05。本文写给接手的智能体：读完即可继续，不需要翻聊天记录。规范见同目录的 `proposal.md`、`design.md`、`specs/harness-session-usage-telemetry/spec.md`、`tasks.md`；面向用户的说明见 `docs/product/usage-metering.md`。

## 0. 先做这几件事

1. 工作区：`/Users/chongwen.zhang/work/study/codex-host-main`，分支 `feat/host-usage-metering`，草稿 PR [#493](https://github.com/BytePioneer-AI/codex-host/pull/493)（base `main`，远端 `origin` = `BytePioneer-AI/codex-host`）。`gh` 在 `/opt/homebrew/bin/gh`，不在 PATH 中。
2. 已变基到 `main`（含 `1d3b6c27` OpenCode v2 条目 ID 修复，冲突仅为测试文件的 import）。继续前先 `git fetch origin main` 看是否又有新提交。
3. 用户会在全部完成后统一验收。用户要求：**每个 Harness 都必须先用本机真实数据确认原生数据结构再实现，不得参照其他 Harness 猜测**；一次做一个，做完一个提交一个；用中文沟通。

## 1. 目标与原则

外部 Harness 会话的用量浮窗中，费用、平均缓存命中、首 token、输出速度由 Host 统一计算，不同 Harness 可以直接比较。

- 统一口径：`inputTokens` 含未命中输入 + 缓存读 + 缓存写；`outputTokens` 含思考。
- 宁可不显示，也不显示错的数字；字段含义未经真实数据验证时不计价、不猜测。
- Host 只在内存中计量，不持久化；每次打开会话回放原生历史，重启后结果相同。
- 只覆盖 Host 派生字段；Token 累计、上下文、套餐等原生字段仍由 Adapter 上报。

## 2. 架构（已实现）

### 2.1 契约

- `packages/harness-adapter/src/usage.ts`
  - `HostUsageRequest`：`requestId`（会话内稳定，用于去重）、`historical?`、`model?`（原生实际模型 ID）、`provider?`（仅标准 models.dev 服务商 ID）、`inputTokens`、`cachedInputTokens?`、`cacheWriteInputTokens?`、`cacheWrite1hInputTokens?`（缓存写中 1 小时档的部分）、`outputTokens`、`reasoningOutputTokens?`、`startedAtMs?`/`completedAtMs?`（首个输出 token 与完成时间，成对出现）。`parseHostUsageRequest` 负责校验。
  - `HostUsage` 新增 Host 派生字段：`sessionCacheHitRatePercent`、`timeToFirstOutputMs`、`costSource`（`publicPrice` | `native`）、`unpricedModels`（仅与 `publicPrice` 费用同时出现，表示费用是下限）。`hostDerivedUsageFields` 列出 Adapter 不得发布的字段。
- `packages/harness-adapter/src/text-session.ts`：输出事件 `usage.request { request }`、`usage.history { complete }`。`harness-broker/src/validation.ts` 已加入事件白名单。
- `packages/shared-contracts/src/thread-usage.ts`：快照 schema 加入上述派生字段及约束。

Adapter 约定：打开会话时先发布全部历史请求（`historical: true`），再发布一次 `usage.history { complete }`；新建会话发布 `{ complete: true }`；运行中每完成一次请求发布一条 `usage.request`；某次请求用量缺失时发布 `usage.history { complete: false }`。

### 2.2 Host 计量

- `packages/host-runtime/src/usage-metering.ts`（`UsageMeter`）：按 `requestId` 去重（先到者生效，所以历史回放与实时重复不会重复计数）。首个 `usage.history` 进入计量模式，此后忽略原生 `totalCostUsd`/`outputTokensPerSecond`。
  - 费用：Σ 每次请求 `(输入−缓存读−缓存写)×输入价 + 缓存读×读价 + 5 分钟写×写价 + 1 小时写×1h 价 + 输出×输出价`，按请求自己的模型计价，换模型、重新打开历史都正确（历史请求用原生记录里当时的模型）。缺 `model` 或缓存字段 → 整体不显示；某模型无价格或缺对应缓存单价 → 该请求不计入，费用为下限并列入 `unpricedModels`；没有任何可计价请求 → 不显示。历史不完整或有无效记录 → 费用与平均缓存都不显示。
  - 平均缓存命中 = Σ 缓存读 ÷ Σ 输入（按 token 加权，与 sub2api 一致）。
  - 输出速度（TPS）= 本轮 Σ 输出 token ÷ Σ（完成 − 首个输出 token），每计入一条带计时的实时记录即更新；新一轮在第一条计时记录前保留上一轮的值；整轮无计时记录则轮末不显示。口径与 DeepSeek dsh 的 decode 时间一致（首个思考、正文或工具调用 token 起算，不含预填充与工具执行）。
  - 首 token（TTFT）：Host 观测本轮开始到首个思考或正文输出，所有 Harness 都有。
- `packages/host-runtime/src/app-server-host.ts`：External Thread 事件处理中接入计量；`#threadUsage()` = `usageMeter.derive(native, prices)`；计量异常只诊断不影响会话。`external-thread-runtime.ts` 每个 Thread 持有 `usageMeter`，Session 替换时丢弃。

### 2.3 价格表

- `packages/host-runtime/src/model-prices.ts`；快照 `model-prices.generated.ts` 由 `scripts/update-model-prices.mjs` 从 models.dev 生成（`npm run build:typescript && node packages/host-runtime/scripts/update-model-prices.mjs`）。启动时本地表超过 7 天后台刷新到 `<数据目录>/pricing/models-dev.json`，失败静默。用户覆盖：`<数据目录>/pricing.json`（`input`/`output`/`cacheRead`/`cacheWrite`/`cacheWrite1h`，美元/百万 token），数据目录默认 `~/.codexhost`。
- 查找顺序（不做模糊或前缀匹配）：用户覆盖 → `provider/model` 精确 → 模型 ID 唯一列出 → 多服务商时：所有 `canonical_model_id`（沿链解析到最终官方 ID）属于同一厂商且厂商自己列出该 ID 时用厂商价 → 官方条目价 → 官方条目缺失时用厂商以别名列出且价格一致的条目（如 DeepSeek 以 `deepseek-flash`、`deepseek-v4-flash` 列出 `deepseek-v4.1-flash`）→ 仅大小写不同时，所有能计价的写法价格一致才采用（如 `Deepseek-v4-flash`）。
- 1 小时档缓存写入单价 = 输入价 × 2（`cacheWrite1hPrice`），取自 Claude Code 内置价格表 `promptCacheWrite1hTokens`；models.dev 只有 5 分钟档价格。

### 2.4 界面（`packages/renderer-extension/src/renderer-usage-control.ts`）

- 输入框下方按钮：`CH 99.6% · 232 tok/s · $12.23`（最近缓存命中 · 速度 · 费用），最大宽度 `min(240px, 30vw)`。部分计价显示 `≥$12.23`。
- 浮窗：上下文（带进度条，≥90% 变橙）；会话组：费用估算（部分计价时下方注明“未计价：模型 ID”）、平均缓存命中、最近缓存命中（CH）；本轮组：输出速度（TPS）、首 token（TTFT）；Token 组：输入/输出、缓存读取（有写入时为“缓存读取 / 写入”）、推理、总数。
- 格式：速度 ≥100 取整，否则一位小数，单位 `tok/s`；费用 ≥$1 两位小数，否则三位；数量用 K/M/B；时间中文“2.6 秒/840 毫秒”，英文 `2.6s/840ms`。只支持 `en`、`zh-CN`。
- 用户明确删除的内容：费用来源说明（“按公开 API 价格计算，不含子代理”“Harness 上报”）不要再加回。
- Desktop 会把 `codexhost/thread/usage/updated` 送到 Renderer 窗口，但原生通知分发器会过滤它。已在 `renderer-host-clients.ts` 沿用手动压缩通知的窗口消息路径，按 Host/source 校验后交给既有用量订阅，连接替换或退订时移除监听。首个输出和每条新请求可直接触发刷新；保留 `thread/tokenUsage/updated`、`turn/completed` 和浮窗刷新入口。不伪造 Token/上下文，不增加轮询。

## 3. 各 Harness 状态

| Harness | 状态 | 数据来源（已用本机真实数据确认） | 本机验证结果 |
| --- | --- | --- | --- |
| Pi | 完成 | RPC `message_update` 首个 `thinking/text/toolcall_(start\|delta)` → `message_end`；历史 `getEntries()` 全部 assistant 消息（所有分支）。`usage.input` 不含缓存；`responseId` 或 `t<timestamp>` 作 ID | 300 会话中大多数费用与 Pi 记录精确一致；差异来自 Pi 本地单价与 models.dev 不同（`gpt-5.6-sol`、`deepseek-flash` Pi 价是 2 倍）。GPT 实测：`thinking_start` 在后台思考开始时到达，速度不偏高 |
| OMP | 完成（仅单测 + 数据完整性） | 同 Pi（`omp-usage.ts`、`omp-rpc-session.ts`），`reasoningTokens` | 1246 条消息都有用量；**未在 CodexHost 界面实测，未核对费用** |
| OpenCode v2 | 完成 | assistant 消息 `tokens`（input 不含缓存，output 不含思考）；**`time.streamed` 是流式结束时间，不能作起点**，改为 Adapter 观测首个 `session.reasoning/text/tool.input` 的 started/delta，结束用 `time.streamed`，排除工具执行；缺少流结束时间时不计速度 | MiniMax 费用与原生完全一致；用户实测发现过 8 万 tok/s 的 bug，已修 |
| Claude Code | 完成 | 实时：`stream_event` `message_start`（ID、模型、输入与缓存）、首个 `content_block_start`、`message_delta`（最终输出与 `thinking_tokens`）、`message_stop`；**`assistant` 消息里的 usage 是起始值（`output_tokens: 1`），不能用**。历史：转录文件 `~/.claude/projects/<proj>/<id>.jsonl`，按 `message.id` 去重，跳过 `<synthetic>`。`cache_creation.ephemeral_1h_input_tokens` 为 1 小时档 | 实时与回放逐字段一致；费用与 `costUSD` 的差额 = 流和转录中都没有的后台请求（约 4%）。192 会话、11952 请求全部可回放可计价。空闲时（无活动轮次）的请求也计量 |
| DeepSeek Harness（dsh） | 完成 | 日志（`openModernJournal`）中 `assistant/message`（`surfaceOp: append`）：`message.id`、`message.source.model`（`provider` 是 dsh 路由名如 `deepseek-official`，不发布）、`stream` 中最后一个 `usage` 块（`inputTokens` 不含缓存，`totalTokens`=输入+输出+缓存读+缓存写）；中断消息无 usage，视为无用量。计时用 `expandAssistantStream` 展开后首个非空 reasoning/text delta 或带名字的 tool-call delta → 事件时间 | 23 会话速度与输出 token 与 dsh 自身 `sessionStats` 的 `decodeTokens/decodeMs` 完全一致 |
| CodeBuddy / WorkBuddy | 完成（无速度） | ACP 不上报逐次用量；打开会话、原生用量通知、浮窗请求刷新与每轮结束时读原生历史（`~/.codebuddy/projects`、`~/.workbuddy-ai/projects`），全部原生分支上按 `providerData.messageId` 去重的 `rawUsage`（原生 Token 快照仍沿用活动分支）：`prompt_tokens` 含缓存（= hit + miss + `prompt_cache_write_tokens`，368 行全部成立），缓存读 = `prompt_tokens_details.cached_tokens`，`completion_tokens` 含 `completion_thinking_tokens`；`cache_read_input_tokens`/`cache_creation_input_tokens` 恒为 0，非 0 时视为含义未知不计量；跳过 `isSubAgent` | 65 会话 token 合计与原生汇总零差异；原生快照的缓存字段已改为同一组字段。WorkBuddy 自动路由的 `default-model` 无法计价 |
| Qoder / Qoder CN | **暂缓** | 本机无会话、无登录凭证、无运行时（首次使用从 download.qoder.com 下载）；现有 `qoder-usage.ts` 对字段理解自相矛盾 | 需用户登录 Qoder 跑会话后再做 |
| Grok | 原生费用 + TTFT + 实时客户端观测生成 TPS | Adapter 按首思考/正文至工具调用/审批或 prompt 返回分段，成功轮末以本轮输出除以总生成时长；保留原生费用、不使用 API 耗时、不补造历史速度 | Grok 1.0.46 + 隔离模拟 Provider 验证两次请求、1.2s 工具等待、1.2s 审批等待及 stream_tool_calls=true：约21tok/s，API平均约17.7tok/s；缺首输出的工具专用请求不发布速度。单测覆盖计时完整性、隐藏思考、重试、并行工具、取消、旧值清除、历史及结算 I/O；22文件223测试、typecheck、定向lint/格式、边界与严格OpenSpec校验通过。生产改动限 Grok 两个文件，无新增公共契约；未重启 Desktop 或进行新 GUI 验收 |
| Hermes | 暂缓 | `~/.hermes/state.db` 表 `session_model_usage`：仅会话 × 模型合计，本机只有 2 行（其一为标题生成），该行缓存读远大于输入 | 数据不足以确认字段含义 |
| ZCode | 已接入（GUI 待验收） | **更正旧判断**：3.14.4 `session/resume` / `session/read` 每条 assistant 的 `info.tokens` 有缓存、思考与实际模型；输入含缓存，输出含思考。主请求的 `model_request_started` / `model.streaming.assistantMessageId` / `model_request_completed` 可关联实时计量，轮末快照补齐 | 本机 9 会话、26 条有效历史请求与原生消息逐字段一致；已装 CLI + 隔离 Provider 验证两步工具请求、实时/恢复一致。明确含思考 Token 时不计速度，流缺缓存字段时等轮末 |
| Antigravity | 未做 | 按步 input/output/thinking，无缓存字段 | 同上 |
| Kiro | 不接入 | 只有积分 | 继续显示积分 |
| Cursor | 不接入 | ACP 无用量 | — |
| Kimi | 未调查完 | ACP `usage_update`（按轮），本机未找到数据目录 | — |

### ZCode 本次接入与证据

- 代码：`packages/adapters/zcode/src/usage.ts`，接线仅在 `session.ts`；`protocol.ts` 保留 `info.tokens` 为 unknown，让计量独立校验，坏记录不破坏聊天。没有新增 Host 专属分支、公共契约或依赖。
- 原生依据：通过 Adapter 自己的 `CliTransport` 对 ZCode 3.14.4 执行 resume/read；9 个真实本机会话共有 26 条可计量消息（含原生历史继承部分），与只读数据库中的消息模型、input/output/cache 逐字段核对一致。没有把 `model_usage` 表的 24 行当成回放范围：该表与消息历史的继承/保留语义不同。
- 示例：12 请求的 GLM 会话总输入为 256777、缓存读为 236160，平均缓存 91.970854%；`v4/conversation/usage` 的输入仅 22921，是上下文增量累计，不可作计费输入。原生 Token 展示保留原来的增量口径。当前打包价格表将 `GLM-5.3-Flash` 匹配为零价，这是查价结果，不代表验证了实际账单。
- 实时协议：只关联同 Session、同 native Turn 的 `main_turn` 请求，requestId 起止一致、期间只有一个 assistantMessageId、模型一致才发布；交错/不明归属退回最终消息，不按当前选中模型猜。流缓存字段不全时先不发布，轮末补齐，避免 Host first-wins 去重把未知字段锁死。原生最终计数与已发布记录冲突时标记不完整。
- 速度：用首个原生思考/正文 delta 或工具输入开始到原生请求完成事件，不使用可能覆盖工具执行的消息落盘时间。ZCode 过滤 reasoning_start，`reasoningTokens > 0` 时不能证明隐藏思考起点，因此不发布计时。只有最终快照能补齐的请求可在轮末计速度；历史无计时。
- 本机验证没有调用收费模型：真实历史是只读核对；实时验证运行已安装 CLI，HOME 和数据目录隔离，Provider 是本地合成服务。聚焦测试 13 文件 / 164 用例通过，包括 Adapter、Host 计量/价格表、真实 Loader → Host → ZCode 路由测试。尚未在 Desktop GUI 验收，也没有重启用户的开发实例。

## 4. 已知限制（不是缺陷）

- Claude Code 费用比其 `costUSD` 低约 4%：后台请求不在流与转录中；未计网页搜索按次费（$0.01/次）与美国地域推理 1.1 倍系数。
- Claude Code 中途取消/失败的请求若没有 `message_stop`，会声明历史不完整，不显示漏计的会话费用与平均缓存；重新打开后由原生历史重建。找不到转录文件也标记不完整，不当作空会话。
- OMP 历史读取跳过损坏记录时保留可读消息，但标记不完整，计量不再把缺少记录的结果作为完整总量发布。
- CodeBuddy/WorkBuddy 没有输出速度（无逐次计时）。
- ZCode 明确包含思考 Token 的请求暂不计速度；流缓存明细缺失时等轮末原生快照补齐。失败/取消只有原生零占位、没有 Provider 用量时跳过，不能表示实际扣费为零。已计入 Host 的指标通过共用用量通知刷新，不再依赖原生 Token 通知。
- 已修复 OpenCode v2 轮内派生指标和各 Harness 首 token 的通知丢失：Renderer 直接接收 Host 自定义用量通知，即使没有原生上下文也能刷新。原生 Token 快照仍按 Adapter 原有时机更新；ZCode 流中没有的明细不会提前出现。回归覆盖无 Context/无轮末通知、Host 隔离、退订和连接替换；Desktop GUI 待验收。
- 已接入的 Pi 会话会覆盖 #489 `pi-token-speed` 插件上报的原生速度（未决）。
- OpenCode 自定义服务商仍作为 `provider` 传入（查不到时退回模型 ID），与 spec“不传自定义别名”措辞需统一（未决）。
- OpenCode v2 一轮结束时原生会话总数可能尚未汇总，浮窗 Token 组可能显示 0/0（原有读取时机问题，未修）。

## 5. 待决事项（需用户）

1. Grok 已接入实时客户端观测生成 TPS，保留原生费用与 Host TTFT，不恢复 API 平均速度。`streamStartMs` 仅作请求标识，空角色帧会触发它，不能直接用于时长。未完整观测的请求、工具专用无首输出、隐藏思考、重试边界缺失、压缩或取消时仍省略速度；历史不补造 TPS。实现与隔离原生验证已完成，当前 Desktop 尚未加载此改动。
2. Qoder：需用户登录并产生会话数据。
3. #489 Pi 插件速度与 Host 速度的取舍。
4. OpenCode 自定义服务商 `provider` 的处理与 spec 措辞。
5. 共用轮内用量刷新已修复，Desktop GUI 待验收（见第 4 节）。
6. 按钮显示最近缓存命中（当前做法，理由：所有 Harness 都有、能及时反映缓存失效）还是平均缓存命中——用户问过，当前保持最近值。

## 6. 接入新 Harness 的步骤（每个都要做）

1. 找到本机真实数据（会话文件、数据库或实时流），打印原始字段；必要时用 Harness 本身或 Adapter 自己的读取代码拉取（例：dsh 日志是自定义压缩格式，只能通过 Adapter 的 `ModernRemoteConnection` + `openModernJournal` 读取）。
2. 用数据证明口径：输入是否含缓存（找 `total = …` 或 `prompt = hit + miss + write` 之类的恒等式）、输出是否含思考、请求 ID、模型 ID、计时字段。只在数据证明后才映射；未验证的字段遇到非零值时标为缺口（`complete: false`），不要猜。
3. 实现：`<adapter>/src/...usage...ts` 中的映射函数（返回 request / missing / none）+ 历史回放 + 实时发布；在会话构造或打开时发布历史与 `usage.history`，新建会话发布 `{ complete: true }`。
4. 测试：用真实数据的字段形状写单测；Adapter 现有测试会因输出流开头多出计量事件而失败，统一给读取输出的测试辅助函数加过滤（见 Pi/OMP/Claude/DSH 测试中的 `isUsageMetering`/`nextOutput`/`lifecycleOutputs`）。
5. 本机验证：对全部本机会话回放，核对 token 合计与原生汇总、费用与原生费用（若有）、速度与 Harness 自身统计（若有），统计可计价比例与未计价模型。
6. 同步 `docs/product/usage-metering.md`（已接入列表与特殊行为）、`design.md`/`spec.md`（如有口径或规则变化），`openspec validate add-host-usage-metering --strict`。
7. 提交、推送；必要时 `npm start` 重启开发版。

## 7. 常用命令与坑

- 构建/检查：`npm run build:typescript`、`npm run typecheck`、`npm run lint`、`npx prettier --check .`、`npx -y @fission-ai/openspec@latest validate add-host-usage-metering --strict`。
- 测试：`npx vitest run --config tests/vitest.config.js <路径>`；全量 `npm run test:typescript`（需 `PATH=$HOME/.cargo/bin:$PATH`，否则 release 测试因找不到 cargo 失败）。界面：`npx playwright test --config tests/e2e/playwright.config.js tests/e2e/renderer-usage.spec.ts`。
- 已知与本变更无关的失败：`renderer-usage.spec.ts` 中 `keeps Usage in place…`（断言按钮 180px，main 上即失败）；全量负载下偶发超时：Antigravity `emits turn.completed with cancelled outcome…`、Cursor `redacts failed CLI output…`，单独运行通过。
- 启动开发版：`PATH=$HOME/.cargo/bin:$PATH npm start`（会先停掉正在运行的 Codex Desktop）。读取界面状态可用 ChatGPT 应用的 CDP 端口（`lsof -iTCP -sTCP:LISTEN | grep ChatGPT`，页面 `app://-/index.html`），通过 `window.__codexhostHostRoutingV1.forHost("local").manager.sendRequest("codexhost/thread/usage/inspect", { threadId })` 查看 Host 返回的用量。
- 坑：Prettier 会重排代码，用字符串替换修改前先确认当前文本；ESLint 禁止非空断言 `!` 与动态 `delete`；测试中写死的时间断言要考虑事件异步处理（OpenCode 用例曾因此偶发失败）。
- 本机参考数据位置：Pi `~/.pi/agent/sessions`、Claude Code `~/.claude/projects`、OpenCode `~/.local/share/opencode/opencode.db`（`session_message`）、dsh 通过 Adapter 读取、CodeBuddy `~/.codebuddy/projects`、WorkBuddy `~/.workbuddy-ai/projects`、Grok `~/.grok/sessions`、Hermes `~/.hermes/state.db`、OMP `~/.omp/agent/sessions`。models.dev 原始数据：`https://models.dev/api.json`。Claude Code 计价逻辑可从 `claude.exe` 的字符串中检索 `promptCacheWrite1hTokens`、`function UQe`。

## 8. 参考的外部实现

- sub2api（Wei-Shaw/sub2api）：缓存命中 = cache_read ÷ (input + cache_read + cache_creation)；请求时长从开始到结束（网关口径，含预填充，不适合作为“输出速度”）。
- DeepSeek dsh：`dsh-session-stats` 的 TPS = Σ decodeTokens ÷ Σ decodeMs，decode = 首个 token → 消息组装完成；本实现与之对齐。
- Claude Code：内置价格表与 `UQe` 计费公式（1 小时档写入 = 2 × 输入价；`inference_geo: us` × 1.1；网页搜索 $0.01/次）。
