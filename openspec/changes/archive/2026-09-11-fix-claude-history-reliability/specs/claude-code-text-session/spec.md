## ADDED Requirements

### Requirement: Native interruptions retain their human Turn

The Adapter SHALL attribute a native interruption marker to its matching human prompt using native identity and metadata rather than text alone.

#### Scenario: Cancellation precedes assistant output
- **WHEN** a recognized interruption shares the human promptId and has no promptSource
- **THEN** history contains one cancelled Turn and its checkpoint is the interruption UUID

#### Scenario: A user quotes interruption text
- **WHEN** interruption text arrives with a different promptId, an explicit promptSource, or without matching prompt evidence
- **THEN** the user input remains a separate visible Turn

### Requirement: Live completion history waits for known messages

The Adapter SHALL wait for the latest completed Turn's known user and checkpoint UUIDs before returning its history snapshot.

#### Scenario: The native transcript write lags completion
- **WHEN** a completed message is initially absent and appears within the bounded wait
- **THEN** the read returns the updated snapshot

#### Scenario: The transcript remains stale
- **WHEN** the bounded wait expires before the known messages appear
- **THEN** the read returns retryable sessionBusy and a later read can retry the same expectation
