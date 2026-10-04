## Context

External Harness 的用量当前由各 Adapter 在 `HostUsage` 快照中自行上报（`harness-session-usage-telemetry`）。现行规范要求 Adapter 只发布原生事实，并禁止 Host 维护第二份 Usage 账本。结果是费用、速度、缓存命中率的覆盖和口径因 Harness 而异。

对 15 个 Adapter 源码和本机现有会话文件（仅读取数值字段）的核对结论：

| Harness | 请求级数据 | 输入含缓存 | 输出含思考 | 实际模型 | 依据 |
|---|---|---|---|---|---|
| Claude Code | 每次请求 + Turn 末 `modelUsage` | 否 | 是 | 每请求 | SDK 类型；Anthropic 口径 |
| Pi / OMP | 每条 assistant message | 否 | 是（另有 `reasoning` 子项） | 每消息 | total = input + output + cacheRead + cacheWrite |
| OpenCode v2 | 每个 step（assistant message，`session.step.ended` 带 tokens） | 否 | **否**（`reasoning` 单列） | 每消息 | total = input + output + reasoning + cache |
| DeepSeek | 流式 usage chunk | 否 | 是 | 会话 | total = input + output + cacheRead |
| Grok | 每 Turn（含多次模型调用） | **是** | 是 | 仅 Turn 主模型 | total = input + output |
| ZCode | 仅会话合计 | **是** | 待实测 | 会话 | total = input + output |
| CodeBuddy / WorkBuddy | 每消息（Turn 末读历史） | **是** | 是 | 每消息 | `prompt_tokens` = hit + miss |
| Hermes | 会话合计；本地 DB 有按模型合计 | 否 | 待实测 | 按模型 | input < cache_read |
| Kimi Code | 每请求 `usage.record` | 否（`inputOther`） | 待实测 | 每请求 | 代码 |
| Qoder / Qoder CN | 每 assistant message | 否 | 待实测 | 待实测 | 代码 |
| Antigravity | 每步 + 结果 | 待实测 | 待实测 | 会话 | 代码 |
| Cursor CLI、Kiro | 无 Token | — | — | — | 不支持 |

另一个事实：本机最近 300 个 Pi 会话中 77 个是分叉会话（文件头含 `parentSession`），分叉文件完整复制了父会话的历史消息及其用量。Pi 的“撤销上一轮”同样实现为分叉（复制除最后一轮外的历史），恢复时与用户分叉无法区分。因此会话费用定义为“该原生会话历史中全部请求的累计”，不区分继承部分。

## Goals / Non-Goals

**Goals:**

- 已接入的 Harness 用同一口径、同一价格表、同一公式得到会话累计费用、会话平均缓存命中率、最近一轮首字延迟、回合平均输出速度。
- 统计可证明完整（否则不显示会话级指标）、模型归属正确（否则不计费）、无重复（请求 ID 去重）。
- 第一批以 Pi、OMP、OpenCode v2 闭环验证；OpenCode v1 协议不接入。

**Non-Goals:** 见 proposal。

## Decisions

### D1. 统一 Token 口径（OpenAI 口径）

`usage.request` 中：`inputTokens` 包含未命中、缓存读、缓存写；`cachedInputTokens` 为缓存读；`cacheWriteInputTokens` 为缓存写；`outputTokens` 包含思考；`reasoningOutputTokens` 为其中的思考。由 Adapter 负责换算（输入不含缓存者加回缓存；输出不含思考者加入思考）。约束：`cachedInputTokens + cacheWriteInputTokens ≤ inputTokens`，`reasoningOutputTokens ≤ outputTokens`。

理由：主流服务商（OpenAI 及兼容接口）采用此口径；统一后公式只有一套实现。备选“Host 按 Adapter 声明的口径换算”会把各家细节带进 Host，否决。

### D2. 请求记录与归属

`usage.request { request: { requestId, historical?, model?, provider?, inputTokens, cachedInputTokens?, cacheWriteInputTokens?, outputTokens, reasoningOutputTokens?, startedAtMs?, completedAtMs? } }`（所属 Turn 由 Host 按到达时的活动 Turn 判定）：

- `requestId` 必填，在原生会话内稳定（如原生消息 ID）。Host 在 Thread 内按 `requestId` 去重，历史回放与实时事件重叠时只计一次。
- `model` 为原生实际模型 ID（非 UI 别名、非 `HarnessModelRef` 编码）。`provider` 仅当 Adapter 能给出标准服务商标识时填写；用户自定义的服务商别名（如 Pi 的 `codex-pi`）不填。
- 合计型 Harness 可发布合计增量；只有当 Adapter 能证明增量全部属于同一模型（例如原生按模型分别给出合计）时才带 `model`，否则省略 `model`，该记录只计 Token、使整个会话费用不可计算。
- 缓存字段：已知为零 MUST 填 `0`；缺失表示未知。未知时依赖缓存的费用与平均缓存命中率不显示，不按零处理。
- 计时：Adapter 把同一原生请求的首个输出 Token 与完成事件关联，给出 `startedAtMs`、`completedAtMs`；无法可靠关联时省略。首个输出 Token 是最早的思考、正文或工具调用块的开始或增量（Pi/OMP 的 `thinking_start`、`text_start`、`toolcall_start` 及对应 delta；OpenCode v2 由 Adapter 观测每条 assistant 消息首个 `session.reasoning/text/tool.input` 的 `started` 或 `delta` 事件，完成时间取原生 `time.completed`；原生 `time.streamed` 是流式结束时间，不能作为起点）。口径与 DeepSeek dsh 的 decode 时间一致（首个 token → 消息完成，含工具调用块），不含预填充；从请求开始计时会把预填充算入，使智能体场景下的短输出请求显著偏低。实测（Pi，2026-10-04）：GPT（`codex-pi/gpt-6-sol`）的 `thinking_start` 在后台思考开始时到达（`message_start` 后约 5 秒预填充，再约 3 秒才出现首个可见内容），因此不流式输出思考的模型也计入了思考时间；DeepSeek flash 按此口径为 219 tok/s，与 dsh 一致。
- 子代理的原生请求不作为父会话记录发布，父会话费用不包含子代理。
- 不属于对话消息、且原生不给出模型的后台请求（如 OpenCode v2 `session.usage.recorded` 的标题生成与压缩）不发布记录，不视为缺口；会话费用因此不含这部分。
- 原生失败请求：带 Token 时照常发布；原生未给出 Token 时视为没有用量，不视为缺口。

备选“Host 对 `HostUsage` 累计值做差”无法确定归属，否决。

### D3. 历史回放与完整性

每次打开会话（create、resume、fork、撤销派生），Adapter 先以 `historical: true` 回放原生历史中的请求，再发布 `usage.history { complete }`：

- 回放原生历史中的全部请求，包括分叉复制来的部分；不判定分叉边界。分叉会话因此显示“父会话已花费 + 本会话花费”，撤销上一轮后被撤销轮次自然不再计入。跨会话加总时的去重属于全局统计页，不在本变更内。
- Pi 会话可能有分支（树状历史），回放 MUST 包含全部分支上的请求，不能只取当前活动分支。
- `complete: true` 仅当 Adapter 完整读取了本会话的原生历史且每条请求都已换算发布。
- create 且尚无原生会话时，Adapter 发布空回放与 `complete: true`。
- 运行中发现某次请求用量缺失或无法换算，Adapter 再发 `complete: false`；Host 收到后、或请求记录校验失败时，视为不完整直到 Session 替换。
- 计量模式：当前 Session 发布过 `usage.history` 即为已接入，此后忽略 `session.usage.changed` 中的原生费用；不以“是否收到请求记录”判断。

Host 在收到 `complete: true` 之前，以及处于不完整状态时，不发布 `totalCostUsd` 与 `sessionCacheHitRatePercent`；首字延迟与回合速度只依赖本次观测，不受影响。

### D4. Host 计量

位于 `host-runtime`，按 External Thread 持有内存状态（请求记录、回合计时）：

- **不覆盖** Adapter 上报的 Token 累计、上下文、套餐、积分、`cacheHitRatePercent` 等字段，只写入派生字段：`totalCostUsd`、`costSource`、`sessionCacheHitRatePercent`、`timeToFirstOutputMs`、`outputTokensPerSecond`。
- 费用：每次发布时用当前价格表对全部记录重算，价格刷新或用户补价后自然更新。单条记录费用 = `(input − cacheRead − cacheWrite) × in + cacheRead × cacheReadPrice + cacheWrite × cacheWritePrice + output × out`。记录缺 `model` 或缓存字段时整个会话省略费用；模型查不到价格或缺对应缓存单价时，该请求不计入，费用作为下限发布并以 `unpricedModels` 列出这些模型，界面显示为 `≥$…`。没有任何可计价请求时省略费用。
- 缓存写入分档：`cacheWrite1hInputTokens` 为 `cacheWriteInputTokens` 中的 1 小时档，按输入单价 × 2 计价（与 Claude Code 内置价格表 `promptCacheWrite1hTokens` 一致），其余按 5 分钟档的 `cacheWrite` 单价。
- 查找补充：官方条目缺失且官方厂商只以别名列出该模型时（如 DeepSeek 以 `deepseek-flash`、`deepseek-v4-flash` 列出 `deepseek-v4.1-flash`），若这些别名价格一致则使用厂商价格。
- 会话平均缓存命中率 = Σ `cachedInputTokens` ÷ Σ `inputTokens`（分母为 0 时省略）。
- 首字延迟：Turn 开始到首个 `reasoning.delta` 或正文 `text.append` 的 Host 观测时长，仅保留最近一轮。
- 回合平均速度：速度 = Σ 输出 Token ÷ Σ (`completedAtMs` − `startedAtMs`)，只计入本 Turn 内带两个时间且时长大于零的实时记录，每计入一条记录即更新为本 Turn 至今的平均值，计入第一条前保留上一 Turn 的值。缺计时、时长为零、Turn 结束后才到达的记录和历史记录不计入速度，但照常计费。按请求关联计时，排除了工具执行时间，也不受请求交错到达的影响；不含预填充。
- 未接入的 Adapter（当前 Session 未发布 `usage.history`）：保留其原生费用，`costSource: "native"`。

状态随 Session 替换、Thread 删除、Host 关闭丢弃，不写 Mapping Store。计量错误只影响派生字段，不影响会话（沿用现有“Usage Telemetry 不得改变生命周期正确性”要求）。

### D5. 价格表

- 数据：构建脚本从 models.dev 生成快照，值为每百万 Token 的 `input`、`output`、`cacheRead`、`cacheWrite`（缺失保持缺失）。
- 查找：有 `provider` 时先按 `provider/model` 精确匹配；再按模型 ID 精确匹配，同 ID 多服务商时沿 `canonical_model_id` 链（官方条目本身可能指向更新的型号）确定官方厂商，厂商自己列出该 ID 时用厂商价格，无法确定则视为未匹配。仅大小写不同的 ID 可匹配，前提是所有能计价的写法价格一致。不做模糊或前缀匹配。
- 刷新：Host 启动时本地缓存超过 7 天则后台请求 `models.dev/api.json`，校验后原子替换；失败静默沿用。
- 用户覆盖：数据目录 `pricing.json`，条目优先于默认表；格式错误时忽略整个文件并记录诊断。

### D6. 契约与界面

`HostUsage` 与 `threadUsageSnapshotSchema` 新增 `sessionCacheHitRatePercent`（0–100）、`timeToFirstOutputMs`（非负安全整数）、`costSource`（`publicPrice` | `native`）。用量浮窗新增“平均缓存命中”“首字延迟”两行；`costSource` 只作数据字段，界面不显示说明。

## Risks / Trade-offs

- [公开价格不等于实际支出，部分 Harness 显示值与其自身界面不同] → 浮窗说明计算方式；测试中用原生费用对比偏差。
- [Host 观测时间晚于原生，且事件可能成批到达] → 只发布回合平均速度与 Host 观测首字延迟，并在界面标注。
- [没有推理/正文输出的请求（如只生成工具调用）缺少计时，不计入速度] → 速度表示“可见输出的生成速度”，文档说明。
- [父会话费用不包含子代理，子代理花费较多时会显得偏低] → 浮窗说明“不含子代理”；子代理费用随全局统计页另行提供。
- [分叉会话的费用包含父会话已花费部分，各会话费用直接相加会重复] → 浮窗只表达单会话累计；全局统计另行去重。
- [Adapter 口径换算错误] → 每个 Adapter 的换算以合成数据单测覆盖口径关系；待实测项实测前不接入。

## Migration Plan

先合入契约、价格表、计量模块与 Pi、OMP、OpenCode v2；OpenCode v1 与其余 Adapter 保持现有快照行为（`costSource: "native"`）并分批接入。回滚时移除 Host 写入的派生字段即可恢复原状。

## Open Questions

- 同一模型 ID 在多个服务商价格不同时，“官方服务商”判定规则是否足够。
