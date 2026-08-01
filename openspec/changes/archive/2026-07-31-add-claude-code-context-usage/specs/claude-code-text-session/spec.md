## ADDED Requirements

### Requirement: Claude Code publishes stable current context Usage

The Claude Code Adapter MUST read current context Usage only from the active official SDK Query's stable structured context operation. It MUST map reliable current used Token and effective maximum Token values into one normalized `HostUsage` context pair after a Turn terminal, and MUST omit unavailable Session aggregate, cost, category, percentage, or Model fields rather than deriving them. It MUST NOT depend on the SDK experimental Session Usage operation or interpret per-Result Usage as a Native Session aggregate.

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
