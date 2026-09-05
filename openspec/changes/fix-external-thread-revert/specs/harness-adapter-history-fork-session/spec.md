## ADDED Requirements

### Requirement: Last-Turn rollback is a distinct source-preserving derivation

Harness inspection and opened Session capabilities SHALL report `history.rollbackLastTurn=true` only when `HarnessAdapter.open(rollbackLastTurn)` derives a distinct Native Session whose active history is semantically the source Session's current history without its final Turn. A derivation MAY regenerate Native Session, message, Turn, Checkpoint, and Item IDs. It SHALL preserve retained Turn order, input, Item semantics and outcomes, Turn outcome, Model, and Checkpoint presence; cross-Session ID equality SHALL NOT be required. Sessions SHALL also report `history.replacementFence=true`, proving that Session `close()` can fence Adapter-controlled Native work, transcript writes, and workspace mutation. `replacementFence` SHALL be optional, omission SHALL mean false, and the shared schema SHALL continue accepting omission only when `rollbackLastTurn=false`; older rollback-capable producers SHALL add the explicit fence claim or fail closed. The source Session and project files SHALL remain unchanged. Host, Repository, and Mapping Store SHALL reject a replacement that reuses the source Native Session identity, and the Mapping Store commit SHALL compare the expected source identity and record revision before replacement.

#### Scenario: OpenCode derives a safe rollback Session

- **WHEN** `open(rollbackLastTurn)` targets an idle OpenCode Session with at least one completed Turn
- **THEN** OpenCode SHALL use an exclusive transcript Fork boundary to create a distinct Native Session containing the semantically equal retained prefix, allowing Native IDs to be rebuilt
- **AND** OpenCode inspection and both source and derived Sessions SHALL report `history.replacementFence=true`
- **AND** it SHALL preserve the confirmed Model, Thinking option, Permission Mode, source transcript, and project files
- **AND** retained `FileChange` validation SHALL compare absolute Native patch paths and relative diff paths using the Harness's authoritative worktree, reject paths outside that worktree, and fail closed when the source, candidate, post-fork source, or Host pre-commit candidate snapshot contains an unreliable diff entry or does not cover every file named by a Native patch
- **AND** Adapter validation or attachment failure before `open()` returns SHALL delete the derived Native Session without changing the source
- **AND** a later Host commit failure SHALL close the returned Session wrapper while keeping the source, Store, and runtime authoritative

#### Scenario: In-place-only or non-durable rollback is unavailable

- **WHEN** a Harness can remove its final Turn only by mutating the source Native Session in place or cannot durably represent every resulting prefix, including an empty prefix
- **THEN** inspection and opened Sessions SHALL report `history.rollbackLastTurn=false`
- **AND** `open(rollbackLastTurn)` SHALL return `unsupported` before invoking the in-place operation

#### Scenario: Adapter returns a candidate without the promised fence

- **WHEN** the source Session reports a replacement fence but the derived rollback or Fork candidate omits or disables it
- **THEN** Host SHALL reject the candidate before restoring configuration, reading candidate history, or writing the Mapping Store
- **AND** the source Session and stored mapping SHALL remain authoritative

#### Scenario: Adapter returns the source Session as a replacement

- **WHEN** a capable Adapter incorrectly returns the source Native Session identity from `open(rollbackLastTurn)`
- **THEN** Host SHALL reject the result without committing it or closing the authoritative source Session
- **AND** the source Thread SHALL remain available for a later Turn

#### Scenario: Adapter returns another loaded Thread as a replacement

- **WHEN** a capable Adapter incorrectly returns a Session wrapper or Native Session identity already owned by another loaded external Thread
- **THEN** Host SHALL reject it before reading, reconfiguring, or closing that Session
- **AND** both the source Thread and the unrelated Thread SHALL remain authoritative and continuable

#### Scenario: Native activity appears during derivation

- **WHEN** source Session output is observed after the idle reservation but before the replacement commit linearization point
- **THEN** the source activity SHALL invalidate the rollback
- **AND** Host SHALL preserve and project that activity without replacing the stored or runtime Session

#### Scenario: Native activity reaches the commit fence

- **WHEN** source Session output arrives after replacement validation while Host is quiescing the source for commit
- **THEN** Host SHALL invalidate the replacement and MUST NOT write it to the Mapping Store
- **AND** Host SHALL unload the quiesced source wrapper while retaining the source Native Session mapping for cold recovery

#### Scenario: Persistence fails after the source is quiesced

- **WHEN** the Mapping Store rejects the replacement after Host has closed and drained the source Session
- **THEN** Host SHALL close the candidate, retain the original stored Native Session and Turn mappings, and unload the closed source wrapper
- **AND** the next access SHALL resume and reconcile the original Native Session instead of using either closed wrapper

#### Scenario: Retained semantic content is corrupted across derived identities

- **WHEN** a derived Session retains the expected number of Turns but changes retained input, Item semantics or outcomes, Turn outcome, Model, or Checkpoint presence, regardless of whether Native IDs are preserved or regenerated
- **THEN** the Adapter SHALL reject and clean up that derived Session before Host persistence

#### Scenario: Retained OpenCode file changes cannot be projected reliably

- **WHEN** strict rollback validation cannot verify authoritative worktree paths, encounters a Native diff transport failure, sees an escaping or malformed path/diff entry, finds partial coverage of a multi-file Native patch, or observes a retained Native patch that never reconciles to reliable `FileChange` values
- **THEN** the Adapter or Host pre-commit snapshot SHALL reject the replacement without committing incomplete retained history
- **AND** the source Session and stored mapping SHALL remain authoritative

#### Scenario: Stored source changes before rollback commit

- **WHEN** the Mapping Store record revision or Native Session identity no longer equals the source observed before derivation
- **THEN** the replacement SHALL fail with a mapping conflict
- **AND** the newer stored record SHALL remain authoritative
