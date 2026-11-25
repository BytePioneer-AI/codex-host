## ADDED Requirements

### Requirement: Empty edited Claude Sessions are durably recoverable

The Adapter SHALL persist an empty replacement identity and configuration before reporting it usable, and SHALL distinguish an unstarted reservation from a missing started transcript.

#### Scenario: Exit before resend

- **WHEN** the sole Turn is edited and the Session closes before sending replacement input
- **THEN** another Adapter resumes the same empty identity and current configuration

#### Scenario: Competing native starts

- **WHEN** two wrappers attempt to start the same reservation
- **THEN** exactly one acquires the creation claim

#### Scenario: Startup fails before input

- **WHEN** startup fails and owned resources close successfully before input submission
- **THEN** the claim can be released for retry

#### Scenario: Started transcript disappears

- **WHEN** a claimed Session has no native transcript
- **THEN** recovery fails instead of creating an empty Session

### Requirement: Claude shutdown reports unconfirmed resource termination

The Adapter SHALL await owned process termination and output drain, and SHALL report failure when shutdown cannot be confirmed.

#### Scenario: The Wrapper root exits first

- **WHEN** an owned Unix child remains after the Wrapper exits
- **THEN** close stops the process group before resolving

#### Scenario: A background stop receipt lacks a terminal

- **WHEN** a native background task acknowledges stop without a terminal notification
- **THEN** close fails within its bounded timeout

### Requirement: Rollback preserves configuration before native startup

The Host SHALL pass current Model, Thinking and Permission Mode in optional rollback input fields, and the Claude Adapter SHALL persist these for empty recovery.

#### Scenario: Brokered rollback

- **WHEN** the Host requests rollback with current settings through the Broker
- **THEN** the same optional settings reach the Adapter

### Requirement: Lazy resume retains saved selection

The Host SHALL provide saved Model and Thinking hints on resume, and Claude SHALL apply them before a later configuration command can publish defaults.

#### Scenario: Cold resume followed by edit

- **WHEN** a native Claude Session resumes without eagerly reporting Model and Thinking
- **THEN** restoring Permission Mode retains the saved Model and Thinking

#### Scenario: Pending metadata differs from a hint

- **WHEN** durable empty Session configuration differs from stale resume hints
- **THEN** the durable configuration remains authoritative

### Requirement: Escalated cancellation retains shutdown ownership

The Adapter SHALL retain the active Turn and its Transport until escalated cancellation confirms native shutdown.

#### Scenario: Native close is delayed or fails

- **WHEN** interrupt escalation starts Transport close and close has not succeeded
- **THEN** another Turn and history reads remain unavailable, a late native terminal cannot publish successful cancellation, and Session close cannot report successful shutdown
- **AND** failed close faults the Session while retaining the Transport for explicit cleanup
