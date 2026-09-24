## MODIFIED Requirements

### Requirement: Reasoning Items have complete ordered lifecycles

Every started Reasoning Item SHALL start after its owning Turn, accept only ordered appends while active, complete exactly once, and complete before the Turn terminal. A concrete Adapter SHALL preserve the order of Reasoning and later visible Agent output that the native protocol proves. An Adapter MAY expose explicitly provisional native reasoning only when it can cancel a revised or abandoned Item without replaying its text as authoritative.

#### Scenario: Native Assistant message closes normally

- **WHEN** an active native Assistant message finishes after emitting visible reasoning
- **THEN** its Reasoning Item SHALL complete once with the exact accumulated text
- **AND** its completion SHALL NOT replay previously appended text

#### Scenario: Turn terminates with active Reasoning

- **WHEN** cancellation, failure, Session close, or Session fault terminates a Turn while a Reasoning Item remains active
- **THEN** the Adapter SHALL complete that Item with the corresponding terminal outcome before `turn.completed`
- **AND** no late reasoning update SHALL enter a later Turn

#### Scenario: Complete native reasoning conflicts with a stable stream

- **WHEN** complete native reasoning from a stable, authoritative stream cannot be reconciled as the exact streamed prefix plus an optional suffix
- **THEN** the Adapter SHALL fail the accepted Turn rather than replay or silently replace visible reasoning
- **AND** all started Item lifecycles SHALL still close exactly once

#### Scenario: Provisional reasoning is revised

- **WHEN** a native Harness explicitly marks streamed reasoning as provisional and its final message revises or removes that text
- **THEN** the Adapter SHALL cancel the provisional Item once and, when final visible text exists, start a separate authoritative Reasoning Item
- **AND** the final Item SHALL contain only the native final text, without duplicating the provisional text

#### Scenario: Native step ends without settling provisional reasoning

- **WHEN** a native step ends after provisional reasoning without an authoritative Assistant message
- **THEN** the Adapter SHALL cancel that Reasoning Item before a later step starts
- **AND** a later step SHALL use a distinct Item identity

### Requirement: Protocol Core projects Reasoning through a proven Codex native carrier

Protocol Core SHALL convert Host Reasoning lifecycle events and historical snapshots into the current Codex app-server `reasoning` Item and one Desktop-verified native Reasoning text lane when available. It SHALL keep Codex wire fields out of HarnessAdapter and SHALL NOT fall back to Agent Message text. When the controlled Desktop has no faithful native text lane, Renderer MAY provide the bounded opt-in summary surface defined by `renderer-reasoning-summary-surface`; that surface SHALL consume only the already-projected explicit summary lane and SHALL NOT replace or mutate Transcript Items. A concrete Adapter whose native reasoning stream is explicitly provisional and revisable MAY publish provisional Reasoning Items if it cancels revised or abandoned Items and keeps durable history authoritative.

#### Scenario: Live Reasoning is projected from a stable stream

- **WHEN** an external Turn emits authoritative Reasoning text before the first Agent Message text
- **THEN** the originating Codex Thread SHALL receive one Reasoning Item lifecycle with each character represented exactly once
- **AND** the Reasoning SHALL remain ordered before that Agent text in the protocol lifecycle

#### Scenario: Modern DSH streams and later confirms reasoning

- **WHEN** Modern DSH emits visible `reasoning-delta` in an accepted Turn and later commits a matching Reasoning block in `assistant/message`
- **THEN** the Adapter SHALL append each native delta while the Turn runs, append any final suffix exactly once, and complete one Reasoning Item
- **AND** ordinary Agent text SHALL remain live

#### Scenario: Modern DSH revises provisional reasoning

- **WHEN** Modern DSH emits provisional `reasoning-delta` and later commits different or no Reasoning text
- **THEN** the Adapter SHALL cancel the provisional Reasoning Item before publishing any different final Reasoning Item
- **AND** `readSnapshot()` SHALL contain only the authoritative native Reasoning-before-Agent order

#### Scenario: Modern DSH abandons an attempt or reconnects

- **WHEN** DSH abandons an Assistant attempt or reconnects with a different active attempt or a durable settlement
- **THEN** the Adapter SHALL cancel orphaned provisional Reasoning once, avoid duplicate replayed deltas, and use durable settlement as the final authority

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
