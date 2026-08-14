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

The Usage control SHALL bind its state to the current External Thread ID and SHALL display only fields present in the latest validated Usage snapshot. Its collapsed summary MUST display the latest cache hit rate as `CH <percent>%` and the cumulative estimated cost as `$<amount>` when those fields are available. The control MUST hide when no displayable Usage field is available.

#### Scenario: Pi provides cache hit rate and cost

- **WHEN** the current Thread Usage contains `cacheHitRatePercent: 99.9` and `totalCostUsd: 0.168`
- **THEN** the collapsed control MUST display `CH 99.9% · $0.168`
- **AND** it MUST NOT change a native context control, if one is present

#### Scenario: Usage contains only one displayable field

- **WHEN** the current Usage contains a reliable cost but no cache hit rate
- **THEN** the collapsed control MUST display the cost only
- **AND** it MUST NOT display `CH 0%`, a placeholder percentage, or an inferred value

#### Scenario: Current Usage is unavailable

- **WHEN** the current Thread has no reliable Usage snapshot or the snapshot has no displayable fields
- **THEN** the Usage control MUST be hidden
- **AND** normal Composer submission and Agent selection MUST remain available

### Requirement: Renderer SHALL expose detailed Usage without changing native surfaces

The Usage control SHALL provide an accessible click and keyboard interaction that opens a compact details Popover. The Popover MUST display available context, cache read/write, input/output, cache hit rate, and cumulative cost fields with their data scope. It MUST omit unavailable fields and MUST NOT claim that Session aggregate fields are per-Turn values.

#### Scenario: User opens Usage details

- **WHEN** the user activates the Usage control
- **THEN** Renderer MUST open a details Popover anchored to the Usage control
- **AND** the Popover MUST identify cache hit rate as the latest request value and cost as the Session cumulative estimate

#### Scenario: User closes Usage details

- **WHEN** the user presses Escape, activates the control again, or clicks outside the Popover
- **THEN** Renderer MUST close the Popover
- **AND** the native Composer controls MUST retain their existing focus and behavior

### Requirement: Renderer SHALL reject stale Usage updates

Renderer SHALL associate every Usage read with the requested Thread ID, mounted Composer identity, and a monotonically increasing request generation. A result that does not match the current Composer and Thread MUST be discarded. A failed Usage read MUST NOT change Agent routing, submission readiness, or Native Session state.

#### Scenario: Thread changes while Usage read is pending

- **WHEN** a Usage request for Thread A resolves after the Composer has been rebound to Thread B
- **THEN** Renderer MUST discard the Thread A result
- **AND** Renderer MUST NOT display Thread A values in Thread B

#### Scenario: Usage read fails

- **WHEN** the fixed Usage inspection request rejects or returns an invalid snapshot
- **THEN** Renderer MUST retain the last valid current-thread value or hide the control
- **AND** Renderer MUST leave normal Composer behavior unchanged
