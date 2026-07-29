## ADDED Requirements

### Requirement: Fork-created conversations recover immutable Agent ownership
When the supported Renderer mounts a conversation target that did not come from the current draft replacement, it SHALL query a fixed Host Thread inspection operation. A mapped external Thread SHALL initialize as that Harness and locked; an official Thread SHALL initialize as Codex without exposing Native identity.

#### Scenario: Forked Pi conversation mounts
- **WHEN** Codex Desktop navigates to the new Thread returned by an external Pi Fork
- **THEN** Renderer SHALL show Pi as selected and locked
- **AND** later submission SHALL retain Pi ownership regardless of another draft's Agent state

#### Scenario: Official Fork conversation mounts
- **WHEN** Host inspection identifies no external ownership
- **THEN** Renderer SHALL preserve Codex selection and official Model behavior

### Requirement: Forked Pi Model uses Host-confirmed state
Thread inspection SHALL return the bounded transport carrier and optional effective Harness Model for the exact Host Thread. Renderer SHALL apply only that confirmed state to the forked conversation and SHALL keep Agent and Model semantics separate.

#### Scenario: Pi Fork inherited an earlier Model
- **WHEN** the selected Checkpoint predates a later source Model change
- **THEN** the forked Composer SHALL display and carry the Model reported by the derived Pi Session rather than the source page's latest Model

### Requirement: Ownership restoration fails closed
Renderer SHALL generation-scope Thread inspection by logical Composer and target. While an unknown conversation may be external, submission SHALL remain blocked until ownership is resolved; stale, malformed, unavailable, or mismatched results SHALL not overwrite a newer target or silently select Codex.

#### Scenario: Inspection resolves after navigation
- **WHEN** a prior conversation inspection returns after another target is mounted
- **THEN** Renderer SHALL ignore that result

#### Scenario: External ownership inspection fails
- **WHEN** Host or the fixed request manager cannot safely resolve a forked external Thread
- **THEN** Renderer SHALL show an unavailable locked state and block submission rather than apply an official Model

### Requirement: Renderer does not replace the native Fork action
The external Fork feature SHALL reuse Codex Desktop's existing message action and standard `thread/fork` request. Renderer Extension MUST NOT add another Fork button, copy visible Transcript content, or correlate Fork by timing.

#### Scenario: User clicks the native message Fork action
- **WHEN** Desktop issues `thread/fork` for an external source
- **THEN** Renderer SHALL rely on the returned conversation target and fixed ownership inspection without a DOM click hook
