## ADDED Requirements

### Requirement: Harness Sessions expose UI-independent Subagent observation semantics
The public Harness Session contract SHALL represent a Root Turn's delegated Subagent work as a Host Subagent Delegation Item without exposing Harness-native task messages, Tool names, parent identifiers, transcript paths, SDK objects, or Codex app-server fields. A Session SHALL advertise whether it can emit these Items through a Subagent observation capability.

#### Scenario: Supporting Harness delegates work
- **WHEN** a supporting Harness starts delegated Subagent work from an accepted Root Turn
- **THEN** its Adapter SHALL emit one ordered Host Subagent Delegation Item lifecycle
- **AND** each delegated Agent SHALL have a stable Adapter-scoped identity, bounded description, optional role, background flag, and normalized state

#### Scenario: Harness does not support Subagents
- **WHEN** a Harness cannot reliably identify delegated Agents
- **THEN** its Session SHALL report Subagent observation as unavailable
- **AND** it SHALL NOT manufacture Subagent identities or lifecycle Items

### Requirement: Subagent delegation remains distinct from internal execution
A Subagent Delegation Item SHALL represent the delegation and aggregate state only. Nested Assistant, Reasoning, Command, Generic Tool, and File Change execution SHALL NOT be emitted as Root Turn Items unless the native Harness explicitly reports that execution as Root-owned.

#### Scenario: Nested Subagent runs Tools
- **WHEN** a delegated Agent executes internal Read, Command, Edit, or other Tool activity
- **THEN** the Root Turn SHALL retain only the Subagent Delegation Item for that work
- **AND** the internal Tool activity SHALL NOT appear as sibling Root Items

#### Scenario: Root continues after delegation
- **WHEN** the Root Agent emits additional Assistant text after delegated work
- **THEN** that text SHALL append to Root Agent Message Items in native order
- **AND** no nested Assistant text SHALL be compared with, appended to, or used to close the Root Agent Message

### Requirement: Subagent delegation Items have complete ordered Turn lifecycles
Every started Subagent Delegation Item SHALL start after its owning Turn, accept only correlated normalized state replacements, complete exactly once, and complete before the Root Turn terminal event. Completion of the delegation Tool SHALL remain distinct from the delegated Agent's background lifetime.

#### Scenario: Foreground delegation completes
- **WHEN** the native delegation result returns during the Root Turn
- **THEN** the Adapter SHALL complete the correlated Subagent Delegation Item once with its final known states
- **AND** the Item terminal SHALL precede the Root Turn terminal

#### Scenario: Background delegation is launched
- **WHEN** the native Harness reports that a Subagent was launched in the background and returns control to the Root Agent
- **THEN** the Adapter SHALL complete the delegation Item when the launch operation completes
- **AND** it SHALL NOT keep the Root Turn active solely to wait for later background work

#### Scenario: Root Turn fails with active delegation
- **WHEN** cancellation, failure, Session close, or Session fault terminates a Root Turn while a Subagent Delegation Item is active
- **THEN** the Adapter SHALL complete the Item with the corresponding terminal outcome before the Turn terminal

### Requirement: Subagents expose stable read-only Child Host Threads
When a supporting Harness provides a stable native Subagent identity and transcript history, Host Runtime SHALL register a stable Child Host Thread, persist only its Parent/Child identity mapping, and use the Child Host Thread ID as the collaboration receiver. Child transcript content SHALL remain owned by the Harness.

#### Scenario: User opens Subagent detail

- **WHEN** Codex Desktop requests a receiver Child Thread from a projected Subagent delegation
- **THEN** Host Runtime SHALL return metadata with the correct Parent Thread relationship and read-only input capability
- **AND** paginated Turn and Item history SHALL be reconstructed from the Adapter's Subagent transcript operation

#### Scenario: Child Agent work starts and finishes

- **WHEN** a native Subagent starts or resumes work
- **THEN** Host Runtime SHALL publish the Child Host Thread as active
- **AND** when the Harness reports that native Subagent completed, failed, or was interrupted, Host Runtime SHALL publish the Child Host Thread as idle

#### Scenario: Host restarts before Child detail is opened

- **WHEN** a persisted Child Host Thread is opened after Host restart
- **THEN** Host Runtime SHALL recover the native Subagent identity from Mapping Store and reread current Harness history
- **AND** Mapping Store SHALL contain no Subagent transcript text

### Requirement: Harness-generated autonomous continuations have Host Turn lifecycles
A supporting Harness SHALL emit an autonomous Turn start when native work resumes and produces Root output without a new desktop Turn request. Host Runtime SHALL create and persist one normal Host Turn projection for that continuation.

#### Scenario: Background task completion resumes Root Agent

- **WHEN** a background Subagent completion notification causes the native Root Agent to generate a follow-up answer after the requested Turn completed
- **THEN** the Adapter SHALL emit the correlated Session-scoped Subagent completion before `turn.autonomous.started` and the normal Turn and Item lifecycle
- **AND** the follow-up answer SHALL appear in the Parent Thread instead of being dropped
- **AND** the correlated Child Host Thread SHALL no longer remain in a loading or active state

#### Scenario: Autonomous continuation overlaps active requested work

- **WHEN** the native Harness reports an autonomous continuation while another Host Turn is active
- **THEN** the Session SHALL fail closed rather than merge both executions into one Turn

### Requirement: Protocol Core projects Subagent delegation through Codex native collaboration Items
Protocol Core SHALL project Host Subagent Delegation Items into the current Codex app-server `collabAgentToolCall` Item lifecycle. Harness Adapter contracts SHALL remain independent of Codex field names and status enums.

#### Scenario: Subagent delegation starts
- **WHEN** a Host Subagent Delegation Item starts in an external Turn
- **THEN** Protocol Core SHALL emit an `item/started` notification containing a `collabAgentToolCall`
- **AND** the projected Item SHALL identify the parent Thread as sender and the normalized Subagents as receivers

#### Scenario: Subagent state changes before completion
- **WHEN** the Adapter replaces the normalized state of an active delegation
- **THEN** Protocol Core SHALL retain the latest state for final Item projection
- **AND** no Harness-native task payload SHALL enter the Codex wire message

#### Scenario: Historical delegation is projected
- **WHEN** a Harness history Snapshot contains a completed Subagent Delegation Item
- **THEN** historical Turn projection SHALL include the corresponding completed native collaboration Item deterministically
