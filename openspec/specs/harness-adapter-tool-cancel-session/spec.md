# harness-adapter-tool-cancel-session Specification

## Purpose
TBD - created by archiving change implement-harness-adapter-tool-cancel-slice. Update Purpose after archive.
## Requirements
### Requirement: HarnessSession exposes UI-independent Tool and Cancel semantics
The system SHALL extend the HarnessSession command and output unions with explicit active-Turn cancellation, Command Execution, Generic Tool, and reliable File Change semantics without exposing Pi RPC or Codex app-server types.

#### Scenario: Host executes a Tool-producing Pi Turn
- **WHEN** Pi emits structured Tool activity for an accepted Turn
- **THEN** PiAdapter SHALL emit Host Item lifecycle outputs through HarnessSession
- **AND** Host Runtime SHALL NOT inspect Pi-native Tool events or result fields

#### Scenario: Host requests active Turn cancellation
- **WHEN** Protocol Facade receives `turn/interrupt` for the active Turn of a Pi-owned Thread
- **THEN** it SHALL execute `turn.cancel` on that HarnessSession
- **AND** successful command completion SHALL only acknowledge that cancellation was requested

### Requirement: Tool Items have ordered, correlated, and unique lifecycles
Every accepted native Tool call SHALL map to one Host Item whose start precedes all updates and whose single terminal event precedes the Turn terminal event. Interleaved Tool calls SHALL remain correlated by native Call ID inside the Adapter.

#### Scenario: Tool emits cumulative progress
- **WHEN** Pi emits successive `tool_execution_update.partialResult` snapshots for one Tool Call ID
- **THEN** PiAdapter SHALL emit typed replacement updates containing the latest bounded output
- **AND** it SHALL NOT append duplicate content from prior cumulative snapshots

#### Scenario: Multiple Tool calls interleave
- **WHEN** Tool start, update, and end events from different native Call IDs are interleaved
- **THEN** each event SHALL update only the corresponding Host Item
- **AND** each started Item SHALL complete exactly once before the Turn completes

#### Scenario: Native Tool reports failure
- **WHEN** Pi ends a Tool with `isError=true`
- **THEN** the corresponding Host Item SHALL complete with a failed outcome and useful bounded output
- **AND** the failure SHALL NOT by itself fault the Session when the native Turn remains valid

### Requirement: Tool output is bounded and honestly typed
PiAdapter SHALL bound Tool output before publishing it to the Harness output stream and SHALL mark truncated Host output explicitly. Unknown native Tools SHALL degrade to Generic Tool rather than MCP, Command, or a native payload escape hatch.

#### Scenario: Tool output exceeds the Adapter limit
- **WHEN** a native Tool result or progress snapshot exceeds the configured output limit
- **THEN** PiAdapter SHALL publish bounded content with `truncated=true`
- **AND** lifecycle terminal events SHALL remain deliverable

#### Scenario: Unknown Tool is observed
- **WHEN** Pi emits a valid Tool name that has no dedicated Host mapping
- **THEN** PiAdapter SHALL emit a Generic Tool Item with JSON arguments and bounded native output
- **AND** no Pi-native event object SHALL cross the HarnessAdapter seam

### Requirement: Reliable native Edit Patch is the only File Change source
PiAdapter SHALL emit a File Change only for a successful Pi Edit result carrying a syntactically valid, unambiguous native Unified Patch. It MUST NOT infer File Changes from Tool names, arguments, Git, file watching, file reads, or before/after snapshots.

#### Scenario: Successful Edit has one valid Unified Patch
- **WHEN** a successful Pi `edit` Tool result contains a valid single-file Unified Patch with a usable path
- **THEN** PiAdapter SHALL emit a completed File Change Item after the Tool Item
- **AND** the File Change SHALL preserve the native patch and parsed add, update, or delete kind

#### Scenario: Tool has no reliable Patch
- **WHEN** Edit fails, Patch is missing or ambiguous, or Write, Bash, or another Tool completes without a reliable native Patch
- **THEN** PiAdapter SHALL keep the result as Tool-only
- **AND** it SHALL NOT emit a File Change or turn Diff

### Requirement: Cancellation waits for stable native stop
A successful `turn.cancel` command SHALL request Pi Abort but SHALL NOT complete the Turn until Pi reaches the proven stable settled state. Repeated cancellation SHALL be idempotent, and cancellation, close, process exit, timeout, and Tool completion races SHALL produce one Turn terminal event.

#### Scenario: Active Tool Turn is cancelled
- **WHEN** Host requests cancellation while Pi is streaming or running a Tool
- **THEN** PiAdapter SHALL request Abort and wait for stable settlement
- **AND** all started Items SHALL terminate before one `turn.completed(cancelled)`

#### Scenario: Cancellation cannot be proven
- **WHEN** Abort fails, times out, the process exits unexpectedly, or stable stop cannot be established
- **THEN** the active Turn SHALL complete once with a failed outcome
- **AND** PiAdapter SHALL NOT report the Turn as cancelled

#### Scenario: Session continues after cancellation
- **WHEN** a cancelled Turn has reached its unique terminal event and Pi remains healthy
- **THEN** the same HarnessSession SHALL accept and complete a later Turn
- **AND** late events from the cancelled Turn SHALL NOT attach to the later Turn

#### Scenario: Session closes during an active Turn
- **WHEN** `close()` starts while a Turn is active
- **THEN** it SHALL share the cancellation and finalization path, close every exposed Item and the Turn exactly once, and release the Pi process within configured bounds

### Requirement: Protocol Core projects Host Tool semantics into current Codex UI shapes
Protocol Core SHALL own conversion from Host Items and outcomes to current Codex app-server Item, update, Diff, and Turn shapes. Host Runtime SHALL own routing and response ordering but SHALL not contain Harness-native projection logic.

#### Scenario: Command Execution is projected
- **WHEN** HarnessSession emits Command Execution start, output, and completion
- **THEN** the originating Codex Thread SHALL receive `commandExecution` Item lifecycle notifications and output deltas in order

#### Scenario: Streamed Command output is not replayed at completion
- **WHEN** Command output has already been projected through one or more output deltas
- **THEN** Item and Turn completion SHALL NOT cause that output to appear a second time in the current Renderer
- **AND** a Command with no projected output delta SHALL retain its available final output in the completed Item

#### Scenario: Generic Tool is projected
- **WHEN** HarnessSession emits a Generic Tool lifecycle
- **THEN** Protocol Core SHALL project it as the current generic dynamic Tool shape or an honest generic fallback
- **AND** it SHALL NOT identify the Tool as MCP when the Harness did not do so

#### Scenario: File Change is projected
- **WHEN** HarnessSession emits a reliable File Change
- **THEN** the originating Turn SHALL receive a Codex File Change lifecycle and current in-memory Diff update
- **AND** the projected Diff SHALL not be persisted by this change

#### Scenario: Cancel output races the interrupt response
- **WHEN** Adapter cancellation outputs are queued before the Host writes the `turn/interrupt` response
- **THEN** Host Runtime SHALL write the response before forwarding those lifecycle notifications

### Requirement: Codex passthrough and existing text behavior remain intact
Codex-owned requests SHALL continue through the official app-server path, and existing lazy Pi startup, Agent Message streaming, same-Session multi-Turn behavior, and bounded shutdown SHALL remain unchanged.

#### Scenario: Codex-owned Turn is interrupted
- **WHEN** `turn/interrupt` references a Turn not owned by a Pi HarnessSession
- **THEN** Host Runtime SHALL forward the original request to the official app-server
- **AND** it SHALL NOT invoke PiAdapter

#### Scenario: Pi Turn contains only text
- **WHEN** Pi completes a normal text-only Turn
- **THEN** the existing response-before-notification and Agent Message lifecycle SHALL remain observable
