## Context

Claude Code Adapter 已经通过官方 `@anthropic-ai/claude-agent-sdk` `Query.getContextUsage()` 在 Assistant 完成和 Turn 终态后发布 `contextUsedTokens` / `contextWindowTokens`。Protocol Core 用这对字段驱动 Codex 原生上下文圆圈；Renderer Usage 控件通过 `codexhost/thread/usage/inspect` 读同一份 `HostUsage`。

当前 Claude 快照只有 context pair。Renderer 折叠摘要只在有 `cacheHitRatePercent`、`outputTokensPerSecond` 或 `totalCostUsd` 时才显示控件，因此 Claude Thread 通常看不到 Usage 摘要，详情里也不会出现 CH、I/O、成本。

产品范围（已确认）：

| 展示 | 位置 | 来源 |
|---|---|---|
| Context `50.1% / 500k` | 原生圆圈 + 浮窗 | 已有 `getContextUsage()` |
| Latest cache hit `CH 99%` | 折叠摘要 + 浮窗 | 最近一次请求的 cache/input token |
| Input / output 累计 | 浮窗 | Turn `result.modelUsage` 按模型加总 |
| Session cost estimate | 折叠摘要 + 浮窗 | Turn `result.total_cost_usd` |
| 5-hour / 7-day limit | **仅浮窗** | SDK `rate_limit_event`（Claude.ai 订阅） |
| Cache read / write k | 不展示 | 不写入 `cachedInputTokens` / `cacheWriteInputTokens` |
| Reasoning 累计 | 不展示 | SDK 没有 Session 累计 thinking |

折叠摘要对官方订阅和 API 接入都是 `CH 99% · $1.37`。有 5h/7d 时只加在浮窗，不进摘要，也不走 Grok 的 `accountCredits` 控件。

认证差异由字段有无表达：API Key / Bedrock / Vertex 不会收到套餐窗口；Adapter 省略这些字段，Renderer 藏行。成本对订阅用户仍是客户端按 API 价目表估的，文案保持 `Session cost estimate`。

## Goals / Non-Goals

**Goals:**

- 让 Claude Thread 在现有 Usage 控件上显示对用户有意义的 CH、Session I/O、Session 成本，以及订阅用户的 5h/7d 浮窗行。
- 从稳定 SDK 消息和 `getContextUsage()` 采集；Adapter 内合并为一份完整替换快照。
- 官方订阅与 API 接入共用同一投影；缺字段省略，不用零值占位。
- 保持 lazy Query、Turn outcome、Session health、bounded close 和原生上下文圆圈 carrier 不变。

**Non-Goals:**

- 不调用 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`。
- 不读取 Keychain / `.credentials.json`，不请求 `https://api.anthropic.com/api/oauth/usage`。
- 不扫描 Claude JSONL 自己加总 token 或成本。
- 不把 `result.usage`（最近一次请求）当成 Session 累计 I/O。
- 不发布 Reasoning 累计、Session cache k、output tok/s、改行数、墙钟时长。
- 不把 5h/7d 放进折叠摘要，不复用 Grok `accountCredits`。
- 不展示 Opus/Sonnet 分模型周窗口、extra/overage、behavior 归因。
- 不修改 `thread/tokenUsage/updated` 的 Codex carrier 形状。

## Decisions

### 1. 三路原生事实，Adapter 内存合并后整份替换

`session.usage.changed` 仍是完整替换，不是 patch。Claude Session 持有上一份已发布快照，按来源更新对应字段后再 `parseHostUsage` 发布：

1. **当前上下文** — 继续 `Query.getContextUsage()` 的 `totalTokens` / `maxTokens`。失败或 malformed 时保留上一份 context pair，不清空其它字段。
2. **Session 累计与最近一次 CH** — 权威 Turn `result`：
   - `total_cost_usd` → `totalCostUsd`
   - 各模型 `modelUsage` 的 `inputTokens` / `outputTokens` 分别求和 → `inputTokens` / `outputTokens`
   - 最近一次 CH 优先用 `result.usage` 的 `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`；若缺，再用 `getContextUsage().apiUsage` 同样三个字段。`prompt = input + cache_write + cache_read`，`prompt > 0` 时 `cacheHitRatePercent = cache_read / prompt * 100`（有限、0–100）。任一加数缺失则省略 CH，不写成 0。
3. **套餐窗口** — SDK `type: "rate_limit_event"` 的 `rate_limit_info`。`rateLimitType === "five_hour"` 更新 5h 字段并保留已有 7d；`seven_day` 反之。其它 `rateLimitType` 忽略。`utilization` 映射为 0–100 的 used percent；`resetsAt` 为 Unix 秒。没有 `utilization` 则整段省略。API 接入收不到该事件，字段保持缺失。

`result.usage` 与 `apiUsage` 只用于 CH，不得写入 Session `inputTokens` / `outputTokens`。`modelUsage` 的 cache 字段只用于确认原生值存在，不得写入 `cachedInputTokens` / `cacheWriteInputTokens`，否则 Pi/Grok 的 Cache read/write 行会在 Claude 上出现大额 k 数。

合并必须经过 `parseHostUsage`。新 Turn、close、fault 仍使进行中的 context 读取 generation 失效。`rate_limit_event` 可在 Turn 外到达：无关联 Turn ID 时仍发布 Session 级 `session.usage.changed`，Host 按现有规则选择通知用的 Turn。

### 2. `HostUsage` 增加套餐窗口字段，并与浏览器快照对齐

在 `HostUsage` 和 `threadUsageSnapshotSchema` 增加同名可选字段：

```ts
planFiveHourUsedPercent?: number;   // 有限，0–100
planFiveHourResetsAtUnix?: number;  // 非负 safe integer，Unix 秒
planSevenDayUsedPercent?: number;
planSevenDayResetsAtUnix?: number;
```

`resetsAt` 不能单独存在：没有对应 used percent 时必须省略。used percent 可以没有 reset。

`parseHostUsage` 与 `threadUsageSnapshotSchema` 必须同步；Host inspection 把 `latestUsage` 交给 `threadUsageInspectionSchema.parse`，字段不对齐会让查询失败。这些字段不进入 Codex `thread/tokenUsage/updated`。

不把套餐窗口塞进 `accountCreditsSnapshot`：那是 Grok 周/月额度控件，`periodType` 没有 5 小时，且用户要求额度出现在 Usage 浮窗。

### 3. 允许从原生最近一次 cache/input 计算 CH，禁止从 transcript 估算

Pi 已经从原生 assistant `usage` 算 `cacheHitRatePercent`。Claude 采用同一含义：最近一次请求，不是 Session 累计。这不是从 Host Transcript 文本、Model 名或本地重新分词推导。缺少原生 cache/input 字段时省略 CH。

修订 `claude-code-text-session` 中「省略 percentage、不把 Result Usage 当 Session 累计」的过时约束：允许 CH 和 `result.modelUsage` / `total_cost_usd` 的 Session 累计映射，仍禁止把 `result.usage` 单次 breakdown 写成 Session I/O。

### 4. Renderer：摘要不变，浮窗加 5h/7d

折叠摘要和控件可见性保持现状：只由 CH、output speed、cost 决定。套餐窗口和 context pair 单独不能拉开摘要。

详情浮窗在现有行之后、成本之前（或成本之后，保持稳定顺序）增加：

- `5-hour limit`：`45%`，若有 reset 则同列附加本地化时间
- `7-day limit`：同上

没有对应字段则整行不渲染。官方订阅因此摘要仍是 `CH 99% · $1.37`，点开才看到 5h。API 接入浮窗没有这两行。

Pi/Grok/DeepSeek 不发布套餐字段，浮窗行为与现在一致。Claude 不发布 cache k 和 Reasoning，这两行对 Claude 保持隐藏。

### 5. Transport 只把规范化用量事件送出 Adapter 包

在 Claude 私有 transport 事件中增加最小结构，例如 `usage.result`（成本、按模型累计、最近一次 usage 对象）和 `plan.limit`（type + utilization + optional resetsAt）。`native-message` 解析 `result` 与 `rate_limit_event`，SDK payload、账号 email、subscriptionType、OAuth token 不得离开 Adapter 包。

`ClaudeTurnTransport.getContextUsage()` 保持现有 context pair。不要为套餐或成本新增 Query 控制请求。

## Risks / Trade-offs

- [`modelUsage` 被误当成单 Turn] → 契约与测试固定：Session I/O 只来自 `modelUsage` 求和，CH 只来自最近一次 `usage`/`apiUsage`；禁止用单次 `usage.input_tokens` 覆盖 Session input。
- [订阅用户把 `$1.37` 理解成套餐扣费] → 文案保持 `Session cost estimate`；5h 放在浮窗而不是摘要，避免和美元抢主信息。
- [`rate_limit_event` 一次只带一个窗口] → Adapter 按 type 合并，未更新的窗口保留；只有 5h 时不编造 7d。
- [中转 API 不回 cache 字段] → CH 省略；控件仍可只显示成本。
- [套餐字段未加入 shared snapshot 导致 inspection 抛错] → HostUsage 与 `threadUsageSnapshotSchema` 同一 Change 对齐，并加 unknown-field / 缺 percent 有 reset 的拒绝测试。
- [Usage 刷新拖垮 Turn] → 保持现有失败隔离和 generation 失效；plan 事件解析失败则丢该事件。

## Migration Plan

1. 扩展 `HostUsage` / `parseHostUsage` / `threadUsageSnapshotSchema` 及契约测试。
2. Claude native/transport 解析 `result` 用量与 `rate_limit_event`；Adapter 合并发布。
3. Renderer Popover 增加 5h/7d 行；摘要测试锁定不含 5h。
4. 聚焦测试：Claude Adapter/transport、shared-contracts、Renderer Usage、必要时 Host inspection 透传新字段。
5. 不默认跑全量测试套件；不把真实 Claude 登录或 OAuth 网络调用纳入普通检查。

回滚时停止发布新字段并去掉 Popover 两行即可；context pair 与原生圆圈保持可用。

## Implementer notes

权威 SDK 类型（依赖版本保持 `0.3.220`，不要升级来「顺便」拿实验 API）：

- `SDKResultSuccess.total_cost_usd` / `modelUsage` / `usage` — `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- `SDKRateLimitEvent` / `SDKRateLimitInfo`
- `SDKControlGetContextUsageResponse.apiUsage`
- `ModelUsage`

主要改动位置：

- `packages/harness-adapter/src/usage.ts`
- `packages/shared-contracts/src/thread-usage.ts`
- `packages/adapters/claude-code/src/native-message.ts`
- `packages/adapters/claude-code/src/transport.ts`
- `packages/adapters/claude-code/src/sdk-transport.ts`（只转发事件，不直接调实验 API）
- `packages/adapters/claude-code/src/claude-code-adapter.ts`（`#refreshUsage` 与快照合并）
- `packages/renderer-extension/src/renderer-usage-control.ts`
- 对应 `test/` 与 `tests/e2e/renderer-usage.spec.ts`

现有 Claude 发布点：Turn 终态和 Assistant `message.completed` 后 `#refreshUsage` → `getContextUsage()`。本 Change 要在 Result 到达时合并累计字段，在 `rate_limit_event` 时合并套餐字段，context 刷新不得抹掉已有 CH/cost/plan。
