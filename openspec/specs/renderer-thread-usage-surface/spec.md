# renderer-thread-usage-surface Specification

## Purpose

Define the shared native Context surface for External Thread usage snapshots. codexhost must preserve Desktop's native Context indicator and add its detailed usage rows to Desktop's own Context tooltip.

## Requirements

### Requirement: Renderer SHALL preserve Desktop's native Context control

Renderer SHALL resolve the uniquely verified native Context control in the same Composer and leave it mounted and visible for both Codex and supported external Agents. Renderer MUST NOT mount a replacement ring, pill, fallback indicator, or other renderer-owned Usage control, and MUST NOT alter the native control's accessible label, SVG, event handlers, or routing state.

#### Scenario: Native Context control is present

- **WHEN** a supported Composer contains a visible native Context control
- **THEN** Renderer MUST keep that control visible
- **AND** Renderer MUST NOT add a codexhost-owned Usage sibling

#### Scenario: Native Context control is not yet present

- **WHEN** the native control is absent during one DOM scan
- **THEN** Renderer MUST wait for the native control to appear
- **AND** Renderer MUST NOT create a visually similar replacement

### Requirement: Renderer SHALL project only reliable Thread Usage fields

Renderer SHALL bind the current External Thread ID to the latest validated Usage snapshot and project only fields that are present. The native Context percentage MUST continue to come from Desktop's native token-usage carrier; codexhost MUST NOT infer a percentage from cache hit rate, input/output, or cost. If no reliable Context carrier exists, codexhost MUST not fabricate a ring.

#### Scenario: Pi provides cache hit rate and cost

- **WHEN** the current Thread Usage contains `cacheHitRatePercent: 99.9` and `totalCostUsd: 0.168`
- **THEN** the native Context tooltip MUST include `Latest cache hit: CH 99.9%` and `Session cost: $0.168`
- **AND** the native Context percentage and indicator MUST remain Desktop-owned

#### Scenario: Usage contains only one displayable field

- **WHEN** the current Usage contains a reliable cost but no cache hit rate
- **THEN** the native Context tooltip MUST display the cost only
- **AND** it MUST NOT display a placeholder percentage or an inferred value

#### Scenario: Current Usage is unavailable

- **WHEN** the current Thread has no reliable Usage snapshot or the snapshot has no displayable fields
- **THEN** the native Context control MUST remain unchanged
- **AND** normal Composer submission and Agent selection MUST remain available

### Requirement: Renderer SHALL expose detailed Usage through Desktop's native tooltip

When Desktop opens the native Context tooltip, Renderer SHALL append one codexhost-owned detail container containing available context, cache read/write, input/output, reasoning, throughput, cache hit rate, and cumulative cost fields with their data scope. Renderer MUST preserve Desktop's native rows and MUST NOT mutate the native accessible label or replace the tooltip.

#### Scenario: User opens Usage details

- **WHEN** the user hovers or focuses Desktop's native Context control
- **THEN** Renderer MUST append the available codexhost detail rows to Desktop's open native tooltip
- **AND** the rows MUST identify cache hit rate as the latest request value and cost as the Session cumulative estimate

#### Scenario: User closes Usage details

- **WHEN** Desktop closes or replaces the native tooltip
- **THEN** Renderer MUST remove the codexhost detail container from the detached tooltip
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
