## MODIFIED Requirements

### Requirement: Protocol Core projects Reasoning through a proven Codex native carrier

Protocol Core SHALL convert Host Reasoning lifecycle events and historical snapshots into the current Codex app-server `reasoning` Item and one Desktop-verified native Reasoning text lane. It SHALL keep Codex wire fields out of HarnessAdapter and SHALL NOT fall back to Agent Message text or a custom Renderer when no faithful native carrier is available. A concrete Adapter whose native reasoning stream is explicitly provisional and revisable MAY defer that Reasoning lifecycle until the authoritative native Assistant message; if ordinary Agent text must remain live, the deferred live Reasoning MAY appear after already-streamed Agent text while historical projection retains deterministic native message order.

#### Scenario: Live Reasoning is projected from a stable stream

- **WHEN** an external Turn emits authoritative Reasoning text before the first Agent Message text
- **THEN** the originating Codex Thread SHALL receive one Reasoning Item lifecycle with each character represented exactly once
- **AND** the Reasoning SHALL be visibly ordered before that Agent text

#### Scenario: Modern DSH revises provisional reasoning

- **WHEN** Modern DSH emits provisional `reasoning-delta`, streams ordinary Agent text, and later publishes a different authoritative Reasoning block in `assistant/message`
- **THEN** the Adapter SHALL keep the Agent text live, emit none of the provisional reasoning, and publish the authoritative Reasoning once after validating the complete event
- **AND** live presentation MAY show that deferred Reasoning after the already-streamed Agent text while `readSnapshot()` preserves the authoritative native Reasoning-before-Agent order

#### Scenario: Historical Reasoning is projected

- **WHEN** `readSnapshot()` returns completed Reasoning Items for an external Thread
- **THEN** historical Codex Turn projection SHALL include those Items in deterministic native order
- **AND** reopening the Thread SHALL not require replaying live delta notifications
- **AND** Desktop MAY use its stock duration-only completed presentation or omit historical Reasoning UI after reopen without keeping the earlier live summary text inspectable

#### Scenario: Current Desktop has no faithful Reasoning carrier

- **WHEN** the controlled Desktop Gate cannot prove a native Reasoning lane with correct text and completion behavior
- **THEN** external Reasoning projection SHALL remain unavailable for that build
- **AND** the implementation SHALL NOT inject a custom UI or merge reasoning into the final answer
