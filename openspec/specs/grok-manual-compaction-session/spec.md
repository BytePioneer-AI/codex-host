# grok-manual-compaction-session Specification

## Purpose
TBD - created by archiving change project-grok-manual-compaction. Update Purpose after archive.
## Requirements
### Requirement: Grok exposes compact as a registered Harness command

The Grok Adapter MUST publish `grok.compact` in the Session command catalog with invocation `/compact` and argument mode `text`. The Adapter MUST reject unknown command IDs and invalid arguments. The Adapter MUST NOT send `/compact` as a Grok Prompt.

#### Scenario: Catalog lists grok.compact

- **WHEN** a Grok Session lists commands
- **THEN** the catalog contains `grok.compact`
- **AND** the command declares `/compact` and argument mode `text`

#### Scenario: Unknown command is rejected

- **WHEN** command execution references an ID other than `grok.compact`
- **THEN** the Adapter rejects the request as unsupported
- **AND** no Grok compact request is started

#### Scenario: Invalid compact argument is rejected

- **WHEN** `grok.compact` is executed with a non-string `text` argument or an unknown argument key
- **THEN** the Adapter rejects the request as invalid
- **AND** no Grok compact request is started

### Requirement: Busy Grok Sessions reject manual compact

The Grok Adapter MUST reject `grok.compact` while a Turn, compact, or other Session operation is already active.

#### Scenario: Compact is rejected during an active Turn

- **WHEN** `grok.compact` is executed while a Grok Turn is running
- **THEN** the Adapter rejects the request as session busy
- **AND** the running Turn is left unchanged

### Requirement: Manual compact uses a temporary Turn and native compact RPC

When `grok.compact` is accepted, the Grok Adapter MUST open a temporary projection Turn, MUST call Grok ACP `x.ai/compact_conversation` with the current Session identity and optional user context from argument `text`, and MUST project native compact start and terminal outcomes as the standard Context Compaction Item. The temporary Turn MUST complete without a persisted Native Turn identity.

#### Scenario: Successful compact projects the standard Item lifecycle

- **WHEN** `grok.compact` is executed with optional text `Keep implementation details`
- **THEN** the Adapter starts a temporary Turn
- **AND** Grok ACP receives `x.ai/compact_conversation` rather than a Prompt
- **AND** Codex projects `contextCompaction` started and succeeded
- **AND** the Turn completes without a Native Turn identity

#### Scenario: Failed compact completes the Item and Turn as failed

- **WHEN** native compact fails
- **THEN** the Context Compaction Item completes as failed
- **AND** the temporary Turn completes as failed
- **AND** the Session remains open

#### Scenario: Cancelled compact completes as cancelled

- **WHEN** the user cancels while Grok compact is running
- **THEN** the Adapter requests Grok Session cancel
- **AND** the Context Compaction Item and temporary Turn complete as cancelled

### Requirement: Succeeded manual compact refreshes context usage

When manual compact succeeds with token counts, the Grok Adapter MUST publish context usage from those counts on the temporary Turn.

#### Scenario: Usage updates after succeeded compact

- **WHEN** native compact succeeds with `tokens_after` and a known context window
- **THEN** the Session publishes context used and window tokens
- **AND** the usage is observed for the temporary compact Turn

