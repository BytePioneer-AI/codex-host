# renderer-thread-usage-surface Specification

## Purpose

Define the Renderer-owned Usage surface for External Thread usage snapshots beside the native context control, or the Composer model control when that circle is absent.
## Requirements
### Requirement: Renderer SHALL place Usage immediately before the native context control when present

Renderer SHALL mount a codexhost-owned Usage control immediately before a uniquely verified native context usage control in the same Composer. If that circle is absent, Renderer SHALL place the Usage control immediately before the Composer model control: the codexhost model picker when it is already in the DOM, otherwise the verified native model trigger. The Usage control MUST be a preceding sibling and MUST NOT modify native context or model control DOM attributes, text, styles, event handlers, or state. If neither a context control nor a model control is available, Renderer MUST leave the Usage control unmounted.

#### Scenario: Usage mounts to the left of the native context circle

- **WHEN** a supported Composer contains one uniquely verified native context usage control
- **THEN** Renderer MUST insert the Usage control immediately before that native control
- **AND** the native control MUST remain unchanged

#### Scenario: Context circle is absent

- **WHEN** a Composer has no uniquely verified native context usage control
- **AND** a supported Composer contains a mounted codexhost model picker
- **THEN** Renderer MUST insert the Usage control immediately before that model picker

#### Scenario: Placement anchors are missing

- **WHEN** a Composer has neither a verified native context usage control nor a model control
- **THEN** Renderer MUST NOT guess a toolbar child position
- **AND** Renderer MUST leave the Usage control hidden or unmounted

### Requirement: Renderer SHALL display only reliable Thread Usage fields

The Usage control SHALL bind its state to the current External Thread ID and SHALL display only fields present in the latest validated Usage snapshot. Its collapsed summary MUST display the latest cache hit rate as `CH <percent>%` and the cumulative estimated cost as `$<amount>` when those fields are available. Plan-window fields MUST NOT appear in the collapsed summary. The control MUST hide when none of cache hit rate, output speed, or cost is available.

#### Scenario: Pi or Claude provides cache hit rate and cost

- **WHEN** the current Thread Usage contains `cacheHitRatePercent: 99.9` and `totalCostUsd: 0.168`
- **THEN** the collapsed control MUST display `CH 99.9% · $0.168`
- **AND** it MUST NOT change a native context control, if one is present

#### Scenario: Claude.ai subscriber also has a five-hour plan window

- **WHEN** the current Thread Usage contains `cacheHitRatePercent: 99`, `totalCostUsd: 1.373`, and `planFiveHourUsedPercent: 45`
- **THEN** the collapsed control MUST display `CH 99% · $1.373`
- **AND** the collapsed control MUST NOT include `5h`, `45%`, or a reset time

#### Scenario: Usage contains only one displayable summary field

- **WHEN** the current Usage contains a reliable cost but no cache hit rate
- **THEN** the collapsed control MUST display the cost only
- **AND** it MUST NOT display `CH 0%`, a placeholder percentage, or an inferred value

#### Scenario: Current Usage is unavailable

- **WHEN** the current Thread has no reliable Usage snapshot or the snapshot has no cache hit rate, output speed, or cost
- **THEN** the Usage control MUST be hidden
- **AND** normal Composer submission and Agent selection MUST remain available

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

#### Scenario: API-key Claude Usage has no plan windows

- **WHEN** the current Usage contains cost and cache hit rate but no plan-window fields
- **THEN** the Popover MUST omit five-hour and seven-day rows
- **AND** it MUST still show the available context, CH, input/output, and cost rows

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

