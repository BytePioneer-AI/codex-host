# harness-reasoning-projection Specification

## Purpose

Define the minimal UI-independent Host Reasoning Item, its ordered lifecycle and Native history ownership, and its faithful projection through a Desktop-verified Codex native carrier.

## Requirements

### Requirement: HarnessSession exposes a minimal UI-independent Reasoning Item

HarnessSession SHALL represent explicit user-visible native reasoning text as a `reasoning` Host Item containing only a stable Host Item ID and accumulated text. Reasoning SHALL use the existing ordered text-append update and SHALL NOT expose native Harness blocks, Codex app-server fields, Provider or Model identity, token counts, encrypted data, or inferred content.

#### Scenario: Native Harness emits visible reasoning text

- **WHEN** a concrete Adapter observes non-empty visible reasoning text from an accepted native Turn
- **THEN** it SHALL start one Reasoning Item for the owning native Assistant-message boundary and append that text in native order
- **AND** no Harness-native payload SHALL cross the HarnessAdapter seam

#### Scenario: Native Harness emits no visible reasoning text

- **WHEN** a Turn emits only empty reasoning boundaries, redacted or encrypted blocks, signatures, Thinking configuration, reasoning Token counts, or no reasoning event
- **THEN** the Adapter SHALL emit no Reasoning Item for that evidence
- **AND** it SHALL NOT infer or manufacture display text

### Requirement: Reasoning Items have complete ordered lifecycles

Every started Reasoning Item SHALL start after its owning Turn, accept only ordered appends while active, complete exactly once, and complete before the Turn terminal. A concrete Adapter SHALL preserve the order of Reasoning and later visible Agent output that the native protocol proves.

#### Scenario: Native Assistant message closes normally

- **WHEN** an active native Assistant message finishes after emitting visible reasoning
- **THEN** its Reasoning Item SHALL complete once with the exact accumulated text
- **AND** its completion SHALL NOT replay previously appended text

#### Scenario: Turn terminates with active Reasoning

- **WHEN** cancellation, failure, Session close, or Session fault terminates a Turn while a Reasoning Item remains active
- **THEN** the Adapter SHALL complete that Item with the corresponding terminal outcome before `turn.completed`
- **AND** no late reasoning update SHALL enter a later Turn

#### Scenario: Complete native reasoning conflicts with streamed text

- **WHEN** complete native reasoning cannot be reconciled as the exact streamed prefix plus an optional suffix
- **THEN** the Adapter SHALL fail the accepted Turn rather than replay or silently replace visible reasoning
- **AND** all started Item lifecycles SHALL still close exactly once

### Requirement: Protocol Core projects Reasoning through a proven Codex native carrier

Protocol Core SHALL convert Host Reasoning lifecycle events and historical snapshots into the current Codex app-server `reasoning` Item and one Desktop-verified native Reasoning text lane. It SHALL keep Codex wire fields out of HarnessAdapter and SHALL NOT fall back to Agent Message text or a custom Renderer when no faithful native carrier is available.

#### Scenario: Live Reasoning is projected

- **WHEN** an external Turn emits a Reasoning start, one or more text appends, and completion
- **THEN** the originating Codex Thread SHALL receive one Reasoning Item lifecycle with each character represented exactly once
- **AND** Reasoning that natively precedes the first Agent Message text SHALL be visibly ordered before that text

#### Scenario: Historical Reasoning is projected

- **WHEN** `readSnapshot()` returns completed Reasoning Items for an external Thread
- **THEN** historical Codex Turn projection SHALL include those Items in deterministic native order
- **AND** reopening the Thread SHALL not require replaying live delta notifications
- **AND** Desktop MAY use its stock duration-only completed presentation or omit historical Reasoning UI after reopen without keeping the earlier live summary text inspectable

#### Scenario: Current Desktop has no faithful Reasoning carrier

- **WHEN** the controlled Desktop Gate cannot prove a native Reasoning lane with correct text, ordering, and completion behavior
- **THEN** external Reasoning projection SHALL remain unavailable for that build
- **AND** the implementation SHALL NOT inject a custom UI or merge reasoning into the final answer

### Requirement: Reasoning remains presentation output owned by Native history

Reasoning content SHALL NOT determine Turn success, become a second persisted Transcript, or cross into unrelated Harness context. Native Session history SHALL remain the sole persistent content source for external Threads.

#### Scenario: Reasoning is the only displayable native content

- **WHEN** a Harness's established terminal classifier would reject or fail a Turn that has no valid final answer or Tool outcome
- **THEN** the presence of Reasoning text SHALL NOT convert that Turn to success

#### Scenario: External Thread is persisted or reopened

- **WHEN** Host persists ownership metadata or later reopens an external Thread
- **THEN** Mapping Store SHALL contain no Reasoning text and the Adapter SHALL reread supported Reasoning from Native Session history
- **AND** diagnostics and committed Gate evidence SHALL omit the Reasoning content
