## 1. Contracts

- [x] 1.1 Extend `HostUsage` / `parseHostUsage` with optional `planFiveHourUsedPercent`, `planFiveHourResetsAtUnix`, `planSevenDayUsedPercent`, and `planSevenDayResetsAtUnix`
- [x] 1.2 Mirror those fields on `threadUsageSnapshotSchema` and reject reset-without-percent, out-of-range percent, and unknown keys
- [x] 1.3 Add harness-adapter and shared-contracts tests for valid plan windows, CH 0–100, and incomplete snapshots

## 2. Claude Adapter

- [x] 2.1 Parse Turn `result.total_cost_usd` and per-model `modelUsage` input/output into Session aggregate fields; do not map last-request `usage` onto Session I/O
- [x] 2.2 Compute `cacheHitRatePercent` only from last-request or `getContextUsage().apiUsage` cache/input fields; omit Claude `cachedInputTokens`, `cacheWriteInputTokens`, and `reasoningOutputTokens`
- [x] 2.3 Parse `rate_limit_event` for `five_hour` and `seven_day`, merge per-window, ignore other `rateLimitType` values
- [x] 2.4 Keep Adapter-side latest snapshot merge so context refresh, Result totals, and plan events replace one `HostUsage` without dropping still-applicable fields
- [x] 2.5 Preserve existing lazy Query, generation invalidation, and Usage failure isolation
- [x] 2.6 Add Fake transport / Adapter tests covering OAuth-with-plan-window, API-key-without-plan-window, incomplete cache fields, stale context read, and malformed rate-limit events

## 3. Renderer

- [x] 3.1 Add five-hour and seven-day rows to the Usage details Popover; omit each row when its fields are absent
- [x] 3.2 Keep the collapsed summary as `CH` and cost only, including when plan windows are present
- [x] 3.3 Keep control visibility tied to CH, output speed, or cost
- [x] 3.4 Extend Renderer Usage tests (and e2e coverage if present) for subscriber popover vs API-key omission vs summary text

## 4. Validation

- [x] 4.1 Confirm Host inspection still round-trips the new `HostUsage` fields through `threadUsageInspectionSchema` without writing `accountCredits`
- [x] 4.2 Confirm Protocol Core `thread/tokenUsage/updated` still uses only the context pair / existing aggregate carrier
- [x] 4.3 Run focused package tests and typecheck for harness-adapter, shared-contracts, adapter-claude-code, renderer-extension, and host-runtime as needed
- [x] 4.4 Do not add live Claude OAuth or `/api/oauth/usage` calls to ordinary checks
