## Why

Claude Code Thread 目前只把稳定的当前上下文 used/max 投影到 `HostUsage`，所以原生圆圈可以更新，但 Composer 旁的 Usage 控件几乎为空。官方 Agent SDK 已经在 Turn `result` 和 `rate_limit_event` 上提供 Session 累计 token/成本、最近一次缓存命中，以及 Claude.ai 订阅的 5 小时/7 天额度。这些数据对用户判断「窗口满不满、缓存有没有生效、会不会撞套餐或烧钱」是有意义的，不必再接实验 `/usage` API，也不必展示难算或易误导的 Reasoning 累计和 Cache k 明细。

## What Changes

- Claude Code Adapter 在现有 context pair 之外，发布 Session 累计 input/output、Session 成本估算、最近一次 cache hit rate，以及（仅当 SDK 推送时）5 小时/7 天套餐窗口。
- 官方订阅和 API Key / Bedrock / Vertex 共用同一套 Usage 控件：折叠摘要始终是 `CH <percent>% · $<amount>`（有字段才显示），5h/7d 只出现在详情浮窗。
- 不发布 Session 累计 cache read/write、Reasoning token；不调用实验 Session Usage API；不读取 OAuth 凭据去打 `/api/oauth/usage`。
- Renderer 详情 Popover 在现有 Context / CH / I/O / cost 之外增加可选的 5-hour / 7-day limit 行；折叠摘要和控件可见性规则不变。
- 保持 Usage 为可选 Telemetry：读取失败不影响 Turn、Session 或 close。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `claude-code-text-session`: 把 Turn Result 的 Session 累计用量、最近一次 CH，以及 `rate_limit_event` 套餐窗口纳入 `HostUsage`。
- `harness-session-usage-telemetry`: 允许 `HostUsage` 携带可选的 Claude.ai 套餐窗口字段；允许从原生最近一次 cache/input token 计算 `cacheHitRatePercent`。
- `renderer-thread-usage-surface`: 详情浮窗展示可选 5h/7d 额度；折叠摘要仍只显示 CH 与成本。

## Impact

- `packages/adapters/claude-code`：native message / transport 事件、Adapter 快照合并与发布、Hermetic 测试。
- `packages/harness-adapter` 与 `packages/shared-contracts`：`HostUsage` / `threadUsageSnapshotSchema` 增加套餐窗口字段并保持对齐。
- `packages/renderer-extension`：Usage Popover 增加 5h/7d 行；折叠摘要不改。
- Host Runtime 继续把 `latestUsage` 原样交给 inspection；Protocol Core 的原生上下文圆圈 carrier 不变。
- Mapping Store、凭据存储、实验 SDK Usage API、Grok `accountCredits` 控件均不改。
