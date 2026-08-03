# claude-code-tool-file-change-session Specification

## Purpose
Define how ClaudeCodeAdapter projects live native Tool lifecycles and reliable Edit/Write structured patches through existing Host Items and Codex Desktop diff notifications.

## Requirements
### Requirement: Claude live Tool activity uses the existing Host Item contract
ClaudeCodeAdapter SHALL correlate complete native Tool Use and Tool Result messages by Tool Use ID and SHALL emit ordered Command Execution or Generic Tool Item lifecycles without exposing Claude SDK messages, Tool Use IDs, or native result objects outside the Adapter package.

#### Scenario: Claude executes Bash
- **WHEN** a live Claude Assistant message contains a valid Bash Tool Use and a matching Tool Result
- **THEN** ClaudeCodeAdapter SHALL emit one Command Execution Item with bounded available output and one terminal outcome
- **AND** the Item SHALL complete before the owning Turn completes

#### Scenario: Claude executes an ordinary Tool
- **WHEN** a live Claude Assistant message contains a valid non-Bash Tool Use and a matching Tool Result
- **THEN** ClaudeCodeAdapter SHALL emit one Generic Tool Item with validated JSON arguments, bounded output, and one terminal outcome

#### Scenario: Tool Progress is absent
- **WHEN** Claude emits a Tool Use and matching Tool Result without any `tool_progress` message
- **THEN** the Tool Item SHALL still complete from the Tool Result
- **AND** no synthetic progress output SHALL be manufactured

### Requirement: Claude Tool lifecycles remain correlated and terminally complete
Every valid Claude Tool Use SHALL map to one Host Item whose start precedes completion and whose completion precedes the Turn terminal. Duplicate starts, unknown completions, ambiguous result association, or successful Turn settlement with unresolved Tools MUST fail closed rather than attach output to another Tool or claim success.

#### Scenario: Several Tools interleave
- **WHEN** one Assistant response starts several native Tool Uses and their matching results arrive in another order
- **THEN** each result SHALL complete only the Item with the same native Tool Use ID

#### Scenario: Claude Turn is cancelled during a Tool
- **WHEN** an accepted Turn is cancelled while one or more Tool Items remain active
- **THEN** every active Tool Item SHALL complete as cancelled before the Turn completes as cancelled

#### Scenario: Native Tool result reports failure
- **WHEN** a matching Tool Result is marked as an error
- **THEN** its Item SHALL complete with a failed outcome and useful bounded output
- **AND** the failure SHALL NOT by itself fault the Session when the native Turn later reaches a valid terminal result

### Requirement: Only native Claude Edit and Write patches produce File Changes
ClaudeCodeAdapter SHALL emit a File Change only after a successful Edit or Write Tool Result supplies a syntactically valid non-empty native `structuredPatch`, a valid native result path, and an unambiguous add or update kind. It MUST NOT infer File Changes from Tool names alone, Tool input, Git, file watching, file reads, before/after snapshots, Bash commands, or unknown result fields.

#### Scenario: Successful Edit returns a structured patch
- **WHEN** a successful Claude Edit result contains a valid `filePath` and native `structuredPatch`
- **THEN** ClaudeCodeAdapter SHALL emit a completed update File Change Item immediately after the Edit Item
- **AND** the deterministic Unified Patch SHALL preserve the native hunk coordinates and lines

#### Scenario: Successful Write creates a file
- **WHEN** a successful Claude Write result declares `type: create` and contains a valid native structured patch
- **THEN** ClaudeCodeAdapter SHALL emit a completed add File Change Item immediately after the Write Item

#### Scenario: Native patch evidence is unusable
- **WHEN** Edit or Write fails, is cancelled, lacks a structured patch, has malformed hunks or path, or supplies ambiguous structured output
- **THEN** ClaudeCodeAdapter SHALL keep the result Tool-only
- **AND** it SHALL NOT emit a File Change or Turn Diff

### Requirement: Existing generic Codex projection renders Claude file summaries
Claude File Change Items SHALL flow through the existing Protocol Core projector so the owning Turn receives current Codex File Change patch and aggregate Diff notifications without Claude-specific Host or Renderer branches.

#### Scenario: Claude changes one file
- **WHEN** ClaudeCodeAdapter emits one reliable File Change Item
- **THEN** Protocol Core SHALL emit `item/fileChange/patchUpdated` and `turn/diff/updated`
- **AND** Codex Desktop MAY derive its native file count and added/deleted line summary from that Unified Diff

### Requirement: Existing Claude behavior remains intact
Text, visible Reasoning, Question, Approval, Permission Mode, Model, Usage, Cancel, lazy startup, Resume, and bounded close behavior SHALL remain unchanged except for the addition of ordered live Tool and File Change Items.

#### Scenario: Claude Tool requires Approval
- **WHEN** a Tool Use also causes a native permission callback
- **THEN** the existing Approval Interaction SHALL resolve only that callback
- **AND** Tool lifecycle correlation SHALL continue to use Tool Use ID independently of the control Request and Host Interaction IDs

#### Scenario: Claude Turn contains no Tool
- **WHEN** Claude completes a normal text-only Turn
- **THEN** the existing Agent Message, Reasoning, Usage, and Turn lifecycle behavior SHALL remain observable without additional Items
