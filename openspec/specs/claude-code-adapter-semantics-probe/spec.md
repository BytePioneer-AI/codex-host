# claude-code-adapter-semantics-probe Specification

## Purpose
TBD - created by archiving change verify-claude-code-adapter-semantics. Update Purpose after archive.
## Requirements
### Requirement: Probe uses the official SDK with the user-installed Claude Code executable

The Probe SHALL use the official Claude Agent SDK as its structured integration surface and SHALL pass an explicitly resolved user-installed Claude Code executable to the SDK. The Probe MUST NOT parse TUI output, copy Paseo code, or treat raw CLI control messages as the preferred production interface when the SDK exposes the required structured operation.

#### Scenario: Installed Claude Code is available

- **WHEN** the Probe resolves an executable Claude Code command and initializes the official SDK
- **THEN** it MUST record only the command source category, SDK/CLI compatibility facts, and sanitized capability structure
- **AND** it MUST NOT persist the absolute executable path, account identity, credentials, or complete native IDs in tracked output

#### Scenario: Claude Code is missing or cannot initialize

- **WHEN** no executable can be resolved or SDK initialization fails
- **THEN** the affected scenario MUST be `BLOCKED` with an installation, launch, authentication, or protocol category
- **AND** the Probe MUST NOT fall back to TUI parsing, a bundled unknown Harness, or Paseo's implementation

### Requirement: Ordinary checks never invoke real Claude or a model

The Probe SHALL separate Hermetic, inspect/isolated, and live profiles. Ordinary repository checks MUST run only deterministic Hermetic tests and MUST NOT launch the user's Claude Code, read native account/configuration, access model/network services, or create native Sessions.

#### Scenario: Normal quality checks run

- **WHEN** a developer or CI runs ordinary formatting, lint, typecheck, test, or build commands
- **THEN** only synthetic Probe tests and reviewed Fixtures MAY run
- **AND** no local Claude process, authentication store, Session directory, or model endpoint MAY be accessed

#### Scenario: Operator explicitly runs a live profile

- **WHEN** an operator explicitly requests a live Claude scenario
- **THEN** the command MUST disclose that it may use network/model quota and native Session persistence
- **AND** it MUST confine file operations to a synthetic temporary cwd and raw evidence to a Git-ignored directory

### Requirement: Inspection and warmup do not leave an empty Native Session

The inspect profile SHALL report installation, authentication availability, catalog shape, and SDK initialization without sending a model Prompt. A warm SDK process MUST NOT leave a resumable Native Session when it is closed without a Prompt.

#### Scenario: Inspect authentication status

- **WHEN** the Probe reads the Claude authentication status
- **THEN** tracked output MUST contain only availability and enum-like authentication/provider categories
- **AND** email, organization, account ID, subscription details, Token, headers, and raw settings MUST remain absent

#### Scenario: Warm process closes unused

- **WHEN** the Probe starts and initializes an SDK warm process with a caller-generated Session UUID but sends no Prompt
- **THEN** official Session lookup MUST report no Session before, during, and after bounded close
- **AND** the Probe MUST confirm no owned process remains or report cleanup failure

#### Scenario: Native authentication requires user settings

- **WHEN** a live scenario runs in Native Mode with the user's existing OAuth/configuration
- **THEN** it MUST load at least the `user` setting source needed by the installed Harness
- **AND** an empty setting-source result MUST be treated as a Probe configuration/authentication fact rather than evidence that Claude Code is not installed

### Requirement: Multi-Turn execution has stable identity and complete terminal classification

The Probe SHALL execute at least two sequential Turns through one SDK Query and Native Session. It MUST verify Session identity, caller-generated User Message UUID persistence, event ordering, and terminal classification using the complete native result rather than `subtype` alone.

#### Scenario: Two text Turns complete in one Query

- **WHEN** two synthetic text inputs are submitted sequentially to one live Query
- **THEN** every native event MUST reference the same confirmed Native Session
- **AND** each Turn MUST have exactly one result and the second Turn MUST not create a replacement Session

#### Scenario: Caller-generated User UUIDs enter history

- **WHEN** the Probe assigns unique UUIDs to accepted SDK User Messages
- **THEN** official history reading MUST return those UUIDs unchanged, unique, and in original order
- **AND** repeated history reads and later resume MUST preserve all existing UUIDs

#### Scenario: Native result has conflicting-looking fields

- **WHEN** a result has `subtype: success` but `is_error: true`, a non-completed terminal reason, or an Assistant error enum
- **THEN** the Probe MUST classify the Turn as failed or cancelled according to the complete evidence
- **AND** it MUST NOT report success from `subtype` alone

#### Scenario: Unknown native message appears

- **WHEN** the current CLI emits a structurally valid message absent from the exported SDK message union
- **THEN** the Probe MUST record its type in local evidence and continue known lifecycle correlation
- **AND** it MUST fail only if the unknown message prevents a required identity or terminal invariant

### Requirement: Tool lifecycle and File Change use native structured evidence

The Probe SHALL correlate Tool Use and Tool Result by native Tool Use ID. Tool Progress SHALL be optional. A File Change SHALL be considered available only when a successful native Tool Result contains a reliable native patch or structured patch.

#### Scenario: Read and Edit complete

- **WHEN** Claude performs controlled Read and Edit Tools in the synthetic cwd
- **THEN** the Probe MUST associate each Tool Use with its corresponding Result
- **AND** each Tool MUST receive one completed, failed, or cancelled outcome before the Turn terminal

#### Scenario: Tool emits no Progress

- **WHEN** a running Tool produces no `tool_progress` message
- **THEN** the Probe MUST still determine lifecycle from Tool Use, Tool Result, cancel, and Turn terminal evidence
- **AND** lack of Progress MUST NOT leave the Tool pending

#### Scenario: Edit returns native structured patch

- **WHEN** a successful Edit result contains native `structuredPatch` hunks or a native patch string
- **THEN** the Probe MUST verify the structured data describes the actual successful edit
- **AND** it MAY recommend deterministic Adapter serialization without weakening native provenance

#### Scenario: Tool lacks native change data

- **WHEN** a Tool Result lacks native patch or structured-patch data
- **THEN** the capability result MUST remain Tool-only
- **AND** the Probe MUST NOT infer File Change from Tool input, `old_string/new_string`, Git, file watching, or before/after snapshots

### Requirement: Question and Approval remain distinct native semantics

The Probe SHALL exercise both ordinary permission callbacks and `AskUserQuestion`. It MUST preserve Tool Use ID and control Request ID correlation while classifying the former as Approval candidates and the latter as Question.

#### Scenario: Edit requires user permission

- **WHEN** a controlled Edit triggers `canUseTool`
- **THEN** the Probe MUST capture stable Tool Use ID, control Request ID, AbortSignal, and available permission suggestions
- **AND** the response MUST resolve only that native request

#### Scenario: AskUserQuestion blocks for an answer

- **WHEN** Claude invokes `AskUserQuestion` with structured questions and options
- **THEN** the Probe MUST classify it as Question even though it uses `canUseTool`
- **AND** the answer MUST be keyed by the complete native question text and complete the same Tool request

#### Scenario: Native permission update is offered

- **WHEN** a permission callback includes persistent or Session-scoped update suggestions
- **THEN** the Probe MUST record the native destination and behavior structurally
- **AND** it MUST NOT claim a Host action is supported until codexhost can execute that exact native scope

### Requirement: Interrupt proves native stop and same-Session recovery

The Probe SHALL cancel both startup/streaming work and an actually running Tool. Interrupt acceptance alone MUST NOT complete the scenario; the Probe MUST wait for native terminal evidence and verify owned process/side-effect cleanup.

#### Scenario: Running Tool is interrupted

- **WHEN** the synthetic Tool process has started and the Probe calls `Query.interrupt()`
- **THEN** the native result MUST indicate an aborted or failed execution within a bounded interval
- **AND** the Tool process MUST exit and its post-sleep completion side effect MUST remain absent

#### Scenario: Turn continues after cancel

- **WHEN** an interrupted Turn has reached native terminal state
- **THEN** the same Query and Native Session MUST accept and successfully complete a new text Turn
- **AND** outputs from the cancelled Turn MUST NOT be correlated to the new Turn

#### Scenario: Pending Interaction is cancelled

- **WHEN** interrupt or Session close occurs while `canUseTool` is awaiting a response
- **THEN** the callback AbortSignal MUST close that pending native request
- **AND** the Probe MUST observe no leaked callback, Tool process, or second Turn terminal

### Requirement: Official history, resume, and Fork preserve source-of-truth boundaries

The Probe SHALL use official SDK Session APIs for history, resume, and Fork. It MUST NOT scan or import unrelated Sessions, modify native transcript files, persist a normalized Host Transcript, or rewind project files.

#### Scenario: Resume continues the same Session

- **WHEN** the first SDK process closes after completed Turns and a new process resumes the captured Session ID
- **THEN** the new Turn MUST use the same Native Session and preserve all prior native message identities
- **AND** official history MUST append the new Turn without rewriting existing messages

#### Scenario: Fork at an Assistant checkpoint

- **WHEN** the Probe calls official `forkSession` with a source Assistant UUID before a later Turn
- **THEN** a distinct Native Session MUST be created with context ending at the selected checkpoint
- **AND** the source Session MUST remain unchanged

#### Scenario: Fork remaps native message identities

- **WHEN** official Fork copies source messages into the derived Session
- **THEN** the Probe MUST verify derived message UUIDs are independent from source UUIDs
- **AND** it MUST record that a source Checkpoint cannot serve as the derived Session's Native Turn Ref

#### Scenario: File rewind capability exists

- **WHEN** the SDK exposes file checkpoint or rewind operations
- **THEN** the Probe MAY record that capability as unsupported by current codexhost Fork semantics
- **AND** it MUST NOT invoke file rewind as part of conversation Fork acceptance

### Requirement: Evidence is sanitized and capability-driven

Raw native evidence SHALL remain in a dedicated ignored directory. Tracked reports and Fixtures MUST contain only fixed synthetic or reviewed sanitized values. The Probe SHALL report each scenario as `PASS`, `FAIL`, or `BLOCKED` and SHALL distinguish required Adapter semantics from optional capabilities and policy decisions.

#### Scenario: Live Capture is produced

- **WHEN** a live profile records SDK messages, stderr, native Session files, prompts, model output, Tool data, or IDs
- **THEN** all raw data MUST remain under `.codexhost/claude-code-probe/` or another dedicated ignored path
- **AND** no command MAY automatically copy it into tracked Fixtures or reports

#### Scenario: Sanitized result is committed

- **WHEN** the change records a reviewed scenario conclusion
- **THEN** it MUST contain only counts, booleans, enum-like categories, fixed synthetic values, and source citations
- **AND** it MUST omit Prompt/response text, credentials, account details, complete IDs, local paths, and native configuration values

#### Scenario: Scenario cannot run in the local environment

- **WHEN** installation, authentication, network, model quota, or platform conditions prevent a required observation
- **THEN** the scenario MUST be `BLOCKED` with a concrete解除 condition
- **AND** unexecuted behavior MUST NOT be inferred from Paseo, SDK types, or another platform

### Requirement: Probe does not create Claude Code product support

This change MUST remain development-only. It MUST NOT register Claude Code as a selectable Agent, route a Host Thread to Claude, persist a Claude mapping, or claim public support.

#### Scenario: Probe change is built and tested

- **WHEN** all Probe artifacts and tests are present
- **THEN** production HarnessAdapter, PiAdapter, Protocol Core, Host Runtime, Renderer, Mapping Store, and release composition MUST remain behaviorally unchanged
- **AND** the next production step MUST remain a separate `implement-claude-code-contract-slice` change after Tool/Cancel contract stabilization
