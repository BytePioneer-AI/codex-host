# grok-acp-file-change-session Specification

## Purpose
TBD - created by archiving change project-grok-acp-file-changes. Update Purpose after archive.
## Requirements
### Requirement: Grok successful Tools SHALL project reliable ACP Diff Content

GrokAdapter SHALL treat only valid ACP Diff Content attached to the successful terminal update of its owning Tool as File Change evidence. It SHALL deterministically serialize the native before/after text as Unified Diff and emit the File Change after the Tool terminal through the existing Host contract.

#### Scenario: Successful Grok edit provides terminal Diff Content
- **WHEN** an active Grok Tool reaches `completed` with valid absolute path, explicit original text, and new text in ACP Diff Content
- **THEN** GrokAdapter SHALL complete the Tool and emit one succeeded File Change Item with normalized path, conservative change kind, and Unified Diff
- **AND** Protocol Core SHALL project the existing Codex file-change and Turn Diff notifications without Grok-specific Host or Renderer behavior

#### Scenario: Grok reports a native new file
- **WHEN** successful terminal ACP Diff Content explicitly reports `oldText: null`
- **THEN** GrokAdapter SHALL project change kind `add`
- **AND** an empty string SHALL NOT by itself be interpreted as add or delete

### Requirement: Grok Diff projection SHALL fail closed

GrokAdapter SHALL NOT infer File Changes from provisional updates, Tool arguments, Tool names, output prose, filesystem reads, Git state, `x.ai/git/diffs`, or `diff_review`. Failed, cancelled, malformed, ambiguous, no-op, oversized, or unsupported Diff data SHALL remain Tool-only and SHALL NOT fail an otherwise valid Turn.

#### Scenario: Provisional Diff differs from successful terminal Diff
- **WHEN** Grok emits provisional Diff Content and later emits a successful terminal Diff for the same Tool
- **THEN** GrokAdapter SHALL use only the successful terminal Diff
- **AND** it SHALL emit exactly one File Change Item

#### Scenario: Tool does not provide reliable terminal Diff
- **WHEN** the Tool fails or its successful terminal update has missing, malformed, no-op, oversized, or unsupported Diff Content
- **THEN** GrokAdapter SHALL expose the Tool lifecycle without a File Change Item

### Requirement: Grok Native history SHALL preserve reliable File Changes

Grok Native history reconstruction SHALL apply the same successful-terminal validation and deterministic serialization used by the live Session so reopening a Thread preserves reliable File Change Items without codexhost persisting Diff content.

#### Scenario: Reopen a Grok Thread containing a successful edit
- **WHEN** Native history contains a Tool and a valid successful terminal ACP Diff update
- **THEN** the reconstructed Turn SHALL contain the Tool followed by the matching succeeded File Change Item
- **AND** provisional or unsuccessful Diff updates SHALL not appear in the Snapshot

