## MODIFIED Requirements

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

The Usage control SHALL provide an accessible click and keyboard interaction that opens a compact details Popover. The Popover MUST display available context, cache read/write, input/output, cache hit rate, five-hour and seven-day plan windows, and cumulative cost fields with their data scope. It MUST omit unavailable fields and MUST NOT claim that Session aggregate fields are per-Turn values or that Session cost is a Claude.ai subscription deduction.

#### Scenario: User opens Usage details

- **WHEN** the user activates the Usage control
- **THEN** Renderer MUST open a details Popover anchored to the Usage control
- **AND** the Popover MUST identify cache hit rate as the latest request value and cost as the Session cumulative estimate

#### Scenario: Claude.ai plan windows appear only in the Popover

- **WHEN** the current Usage contains `planFiveHourUsedPercent: 45` and optional `planFiveHourResetsAtUnix`
- **THEN** the Popover MUST show a five-hour limit row with the percent and, when present, the reset time
- **AND** a seven-day row MUST appear only when seven-day fields are present

#### Scenario: API-key Claude Usage has no plan windows

- **WHEN** the current Usage contains cost and cache hit rate but no plan-window fields
- **THEN** the Popover MUST omit five-hour and seven-day rows
- **AND** it MUST still show the available context, CH, input/output, and cost rows

#### Scenario: User closes Usage details

- **WHEN** the user presses Escape, activates the control again, or clicks outside the Popover
- **THEN** Renderer MUST close the Popover
- **AND** the native Composer controls MUST retain their existing focus and behavior
