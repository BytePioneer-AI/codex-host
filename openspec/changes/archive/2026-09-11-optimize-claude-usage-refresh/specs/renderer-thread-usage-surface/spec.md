## MODIFIED Requirements

### Requirement: Renderer SHALL expose detailed Usage without changing native surfaces

The Usage control SHALL provide an accessible click and keyboard interaction that opens a compact details Popover. The Popover MUST immediately display available cached context, cache read/write, input/output, cache hit rate, five-hour and seven-day plan windows, and cumulative cost fields with their data scope. Opening the Popover for an External Thread MUST request one explicit exact Usage refresh through the fixed inspection contract without blocking the cached rendering. The Popover MUST omit unavailable fields and MUST NOT claim that Session aggregate fields are per-Turn values or that estimated cost is an account billing deduction.

#### Scenario: User opens Usage details with cached data

- **WHEN** the user activates the Usage control and a validated snapshot is already cached for the current External Thread
- **THEN** Renderer MUST open a details Popover anchored to the Usage control and render that snapshot immediately
- **AND** it MUST request an exact Usage refresh for the same Thread without waiting before opening the Popover

#### Scenario: Exact refresh publishes a newer snapshot

- **WHEN** the owning Session completes the explicit exact refresh and Host publishes a newer validated Usage snapshot for the same Thread and Composer generation
- **THEN** Renderer MUST update the open Popover with the newer snapshot
- **AND** the Popover MUST continue to identify cache hit rate as the latest request value and cost as the Session cumulative estimate

#### Scenario: Claude.ai plan windows appear only in the Popover

- **WHEN** the current Usage contains `planFiveHourUsedPercent` or `planSevenDayUsedPercent`
- **THEN** the Popover MUST show only the available five-hour and seven-day limit rows with optional reset times
- **AND** those fields MUST NOT be added to the collapsed `CH <percent>% · $<amount>` summary

#### Scenario: Exact refresh is unavailable or fails

- **WHEN** the owning Harness does not support explicit refresh, the refresh is in cooldown, or the exact read fails
- **THEN** Renderer MUST retain the last valid current-Thread snapshot or hide unavailable rows
- **AND** normal Composer submission, Agent selection, Turn lifecycle, and native controls MUST remain available

#### Scenario: User closes Usage details

- **WHEN** the user presses Escape, activates the control again, or clicks outside the Popover
- **THEN** Renderer MUST close the Popover
- **AND** the native Composer controls MUST retain their existing focus and behavior

### Requirement: Renderer SHALL reject stale Usage updates

Renderer SHALL associate every Usage read, including explicit exact refreshes, with the requested Thread ID, mounted Composer identity, and a monotonically increasing request generation. A result or notification that does not match the current Composer and Thread MUST be discarded. Repeated activation while an exact refresh is pending MUST NOT cause Renderer to apply responses out of order. A failed Usage read MUST NOT change Agent routing, submission readiness, or Native Session state.

#### Scenario: Thread changes while exact Usage read is pending

- **WHEN** an exact Usage request for Thread A resolves after the Composer has been rebound to Thread B
- **THEN** Renderer MUST discard the Thread A result
- **AND** Renderer MUST NOT display Thread A values in Thread B

#### Scenario: Composer is replaced while Usage read is pending

- **WHEN** a Usage request resolves after its mounted Composer identity has been disposed or replaced
- **THEN** Renderer MUST discard the result
- **AND** it MUST NOT remount or update a Usage control for the obsolete Composer

#### Scenario: Older refresh resolves after a newer refresh

- **WHEN** two Usage generations were requested for the same Composer and the older generation resolves last
- **THEN** Renderer MUST retain the newer generation's snapshot
- **AND** it MUST discard the older result even when its Thread ID matches

#### Scenario: Usage read fails

- **WHEN** the fixed Usage inspection request rejects or returns an invalid snapshot
- **THEN** Renderer MUST retain the last valid current-thread value or hide the control
- **AND** Renderer MUST leave normal Composer behavior unchanged
