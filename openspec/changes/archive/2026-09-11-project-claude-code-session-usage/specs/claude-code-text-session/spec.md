## MODIFIED Requirements

### Requirement: Claude Code publishes stable current context Usage

The Claude Code Adapter MUST read current context Usage from the active official SDK Query's stable structured context operation. It MUST map reliable current used Token and effective maximum Token values into one normalized `HostUsage` context pair after each validated complete Assistant message and after the Turn terminal. It MUST omit unavailable fields rather than publishing zeros. It MUST NOT depend on the SDK experimental Session Usage operation, MUST NOT read local credentials or call Anthropic OAuth usage HTTP endpoints, and MUST NOT interpret per-Result `usage` as a Native Session aggregate.

#### Scenario: Claude Assistant message exposes context during an active Turn

- **WHEN** an accepted Claude Turn receives a validated complete Assistant message and the active Query returns valid current context while Tool work or a later Assistant response remains pending
- **THEN** the Adapter MUST publish a `session.usage.changed` snapshot associated with the active Turn
- **AND** the Adapter MUST NOT wait for the native Result before first providing the current context pair

#### Scenario: Successful Claude Turn exposes current context

- **WHEN** an accepted Claude Turn reaches its authoritative terminal and the active Query returns valid current context used and maximum Token values
- **THEN** the Adapter MUST publish one `session.usage.changed` snapshot containing the corresponding `contextUsedTokens` and `contextWindowTokens`
- **AND** the snapshot MUST remain Session-level Telemetry associated with that observation boundary

#### Scenario: Claude context response is unavailable or malformed

- **WHEN** the stable context operation fails, returns no current context, or returns an invalid Token pair
- **THEN** the Adapter MUST omit that observation and preserve the latest still-applicable Usage or `null`
- **AND** the Turn outcome, Session health, and bounded close MUST remain unchanged

#### Scenario: Claude Session has not started a Query

- **WHEN** a create or resume Session has not accepted its first Turn
- **THEN** `initialUsage` MUST remain `null`
- **AND** the Adapter MUST NOT start Claude Code only to obtain Usage

#### Scenario: An older context read completes after a newer boundary

- **WHEN** a context read started for an earlier Turn completes after another Turn starts, Session close begins, or the Session faults
- **THEN** the Adapter MUST discard that stale result
- **AND** it MUST NOT replace Usage owned by the newer Session boundary

## ADDED Requirements

### Requirement: Claude Code publishes Session aggregate Usage and latest cache hit rate from Turn Result

When a Claude Turn Result supplies reliable Session-level totals, the Adapter MUST merge them into the current `HostUsage` snapshot together with any still-applicable context pair and plan-window fields. Session input and output MUST come from summing `modelUsage` per-model `inputTokens` and `outputTokens`. Session cost MUST come from `total_cost_usd`. Latest cache hit rate MAY be computed only from the native last-request cache and input Token fields (`cache_read_input_tokens / (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)` when every addend is present and the denominator is greater than zero). The Adapter MUST NOT write Session cache totals into `cachedInputTokens` or `cacheWriteInputTokens`, MUST NOT publish `reasoningOutputTokens`, and MUST NOT copy last-request `usage` input or output onto Session aggregate fields.

#### Scenario: Successful Result exposes Session cost and token totals

- **WHEN** an accepted Claude Turn Result includes a finite non-negative `total_cost_usd` and per-model `modelUsage` with non-negative safe-integer input and output totals
- **THEN** the Adapter MUST publish `totalCostUsd` plus summed `inputTokens` and `outputTokens` on the next `session.usage.changed` snapshot
- **AND** that snapshot MUST still include the latest still-applicable context pair when one exists

#### Scenario: Latest request exposes cache hit rate

- **WHEN** the Result last-request `usage` or the stable context `apiUsage` includes input, cache-creation, and cache-read Token counts whose sum is greater than zero
- **THEN** the Adapter MUST publish `cacheHitRatePercent` as the cache-read share of that sum, clamped to 0–100
- **AND** the Adapter MUST NOT publish `cachedInputTokens` or `cacheWriteInputTokens` from those same fields

#### Scenario: Last-request cache fields are incomplete

- **WHEN** any of the last-request input, cache-creation, or cache-read Token fields is missing
- **THEN** the Adapter MUST omit `cacheHitRatePercent`
- **AND** it MUST NOT publish `CH 0%` or any substitute percentage

#### Scenario: API-key or third-party Claude Session has no plan windows

- **WHEN** a Claude Session completes a Result without any `rate_limit_event`
- **THEN** the snapshot MAY contain context, Session I/O, cost, and cache hit rate
- **AND** the snapshot MUST omit plan-window fields rather than filling zeros

### Requirement: Claude Code publishes Claude.ai plan windows from rate-limit events

The Adapter MUST map SDK `rate_limit_event` payloads whose `rateLimitType` is `five_hour` or `seven_day` into optional `HostUsage` plan-window fields. A five-hour event MUST update only the five-hour used percent and optional reset Unix timestamp while preserving any already published seven-day window, and a seven-day event MUST do the reverse. Other `rateLimitType` values MUST be ignored. Plan-window updates MUST be merged into the latest still-applicable snapshot and MUST NOT clear context, Session aggregate, cost, or cache hit rate. The Adapter MUST NOT call the experimental SDK Session Usage operation to obtain these windows.

#### Scenario: Five-hour plan window arrives for a Claude.ai subscriber

- **WHEN** the SDK emits a `rate_limit_event` with `rateLimitType` `five_hour` and a finite utilization between 0 and 100
- **THEN** the Adapter MUST publish `planFiveHourUsedPercent` and, when present, `planFiveHourResetsAtUnix`
- **AND** the collapsed Renderer summary contract remains `CH` and cost only; these plan fields exist for the details Popover

#### Scenario: Seven-day window updates without erasing five-hour data

- **WHEN** a later `rate_limit_event` reports `seven_day` utilization and a five-hour window is already on the snapshot
- **THEN** the Adapter MUST publish the seven-day fields
- **AND** the existing five-hour fields MUST remain

#### Scenario: Plan-window event is malformed or not a tracked window

- **WHEN** utilization is missing, out of range, or `rateLimitType` is not `five_hour` or `seven_day`
- **THEN** the Adapter MUST ignore that event
- **AND** Turn outcome and the latest still-applicable Usage MUST remain unchanged
