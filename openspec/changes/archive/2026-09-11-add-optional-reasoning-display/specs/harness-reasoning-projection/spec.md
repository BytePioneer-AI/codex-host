## MODIFIED Requirements

### Requirement: Protocol Core projects Reasoning through a proven Codex native carrier

Protocol Core SHALL convert Host Reasoning lifecycle events and historical snapshots into the current Codex app-server `reasoning` Item and one Desktop-verified native Reasoning text lane when available. It SHALL keep Codex wire fields out of HarnessAdapter and SHALL NOT fall back to Agent Message text. When the controlled Desktop has no faithful native text lane, Renderer MAY provide the bounded opt-in summary surface defined by `renderer-reasoning-summary-surface`; that surface SHALL consume only the already-projected explicit summary lane and SHALL NOT replace or mutate Transcript Items.

#### Scenario: Live Reasoning is projected

- **WHEN** an external Turn emits a Reasoning start, one or more text appends, and completion
- **THEN** the originating Codex Thread SHALL receive one Reasoning Item lifecycle with each character represented exactly once
- **AND** Reasoning that natively precedes the first Agent Message text SHALL remain ordered before that text in the protocol lifecycle

#### Scenario: Historical Reasoning is projected

- **WHEN** `readSnapshot()` returns completed Reasoning Items for an external Thread
- **THEN** historical Codex Turn projection SHALL include those Items in deterministic native order
- **AND** reopening the Thread SHALL not require replaying live delta notifications
- **AND** the opt-in Renderer summary surface SHALL NOT create or persist a second historical Transcript

#### Scenario: Current Desktop has no faithful Reasoning carrier

- **WHEN** the controlled Desktop Gate cannot prove a native Reasoning lane with correct text, ordering, and completion behavior
- **THEN** Protocol Core SHALL preserve the native Reasoning Item projection without merging it into final Agent Message text
- **AND** Renderer MAY show explicit summary notifications only after the user opts in
- **AND** disabling that preference SHALL leave no custom reasoning panel or retained display text
