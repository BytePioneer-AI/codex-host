## ADDED Requirements

### Requirement: Capability-selected adjustment

Host SHALL choose native steering when supported and otherwise use interrupt-and-continue only when the Session explicitly declares it. Official Codex requests and the strict same-Turn Adapter steering contract MUST remain unchanged.

#### Scenario: Supported fallback
- **WHEN** an external Session declares interruptAndContinue and receives a valid adjustment
- **THEN** Host cancels the referenced active Turn, confirms termination, and starts a distinct Turn with the adjustment input

#### Scenario: Unsupported Session
- **WHEN** neither adjustment mode is declared
- **THEN** the request fails before any native mutation

### Requirement: Ordered and recoverable admission

Host MUST reserve Session execution during adjustment, deduplicate identical client identities, reject conflicting identities and concurrent distinct transactions, and release the reservation after all outstanding native cancellation work settles. A cancellation acknowledgement alone MUST NOT permit another Turn. Cancellation failure, timeout, fault, shutdown, persistence failure, or explicit stop MUST prevent automatic continuation.

#### Scenario: Delayed cancellation output
- **WHEN** native cancel acknowledges before the final output and Turn terminal
- **THEN** no continuation starts until those outputs have been projected

#### Scenario: Completion races cancellation
- **WHEN** the reserved Turn naturally completes while cancellation is being requested
- **THEN** the adjustment is started once after that successful terminal, with no fabricated cancelled outcome

#### Scenario: Repeated request
- **WHEN** the same client identity and input are retried before or after completion
- **THEN** the original result is reused without another native prompt

#### Scenario: Explicit stop
- **WHEN** the user stops a Turn while adjustment is still waiting for cancellation
- **THEN** the pending continuation is withdrawn and no new Turn starts

#### Scenario: Stop races new admission
- **WHEN** the user stops while the continuation prompt is already being admitted
- **THEN** Host waits for that admission and requests cancellation of the new Turn instead of cancelling the stale old Turn

### Requirement: Desktop and history agreement

Desktop MUST preserve the adjustment input on failure and MUST NOT requeue a successfully transferred optimistic steering message. A continued Turn SHALL emit its own user message. Runtime history and cold history SHALL retain the old Turn and the distinct new Turn without rewriting the Native Session or rolling back files.

#### Scenario: Interrupted Turn and new input
- **WHEN** an adjustment continues as a new Turn
- **THEN** the old optimistic steering item is not restored as a duplicate queued follow-up and the new Turn displays the input once

#### Scenario: Unknown Renderer binding
- **WHEN** the bridge cannot identify the optimistic item or supported conversation shape
- **THEN** it rejects cross-Turn adjustment before requesting cancellation
