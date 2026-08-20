# grok-auto-compaction-session Specification

## Purpose
TBD - created by archiving change project-grok-auto-compaction. Update Purpose after archive.
## Requirements
### Requirement: Grok auto-compaction SHALL project a Context Compaction Item on the active Turn

GrokAdapter SHALL translate native auto-compaction start and terminal outcomes into the existing Host Context Compaction Item on the current Turn. It SHALL NOT open a separate Turn and SHALL NOT require Renderer or Protocol Core changes.

#### Scenario: Auto-compact succeeds during an active Turn
- **WHEN** Grok emits `auto_compact_started` and then `auto_compact_completed` while a Turn is active
- **THEN** GrokAdapter SHALL emit one started Context Compaction Item on that Turn
- **AND** it SHALL complete that Item as succeeded before later Assistant or Reasoning updates continue

#### Scenario: Auto-compact fails or is cancelled
- **WHEN** Grok emits `auto_compact_failed` or `auto_compact_cancelled` after a start
- **THEN** GrokAdapter SHALL complete the Context Compaction Item as failed or cancelled
- **AND** the Turn SHALL remain open for later native updates

#### Scenario: Compact notifications arrive with no active Turn
- **WHEN** Grok emits auto-compact updates while no Turn is active
- **THEN** GrokAdapter SHALL ignore them
- **AND** it SHALL NOT open a Turn or emit a Host Item

### Requirement: Grok auto-compaction projection SHALL fail closed on unknown native shapes

GrokAdapter SHALL map only validated auto-compact start and terminal updates. Internal checkpoints, unknown `sessionUpdate` values, and malformed extension notifications SHALL be ignored without failing the Turn.

#### Scenario: Compaction checkpoint is not a Host Item
- **WHEN** Grok emits `compaction_checkpoint`
- **THEN** GrokAdapter SHALL NOT emit a Host Item
- **AND** a following `auto_compact_completed` SHALL still complete the compact Item

#### Scenario: Unknown extension notification is ignored
- **WHEN** Grok emits an extension notification whose method or payload is not a validated auto-compact update
- **THEN** GrokAdapter SHALL ignore it
- **AND** the active Turn SHALL continue

### Requirement: Grok Native history SHALL preserve auto-compaction Items

Grok Native history reconstruction SHALL apply the same auto-compact mapping used by the live Session so reopening a Thread preserves Context Compaction Items inside the Turn that contained them.

#### Scenario: Reopen a Grok Thread that auto-compacted mid-Turn
- **WHEN** Native history contains a user Turn with `auto_compact_started` and a terminal auto-compact outcome before Turn completion
- **THEN** the reconstructed Turn SHALL contain a matching Context Compaction Item with that outcome
- **AND** compact events outside an open user Turn SHALL not create a Turn

### Requirement: Succeeded Grok auto-compaction SHALL refresh context usage

When auto-compact succeeds with native token counts, GrokAdapter SHALL publish context usage from those counts so Codex does not wait for a later message chunk to explain the drop.

#### Scenario: Compact reports tokens after compression
- **WHEN** `auto_compact_completed` includes `tokens_after` and a context window is known
- **THEN** GrokAdapter SHALL publish `contextUsedTokens` and `contextWindowTokens` for the active Turn
- **AND** missing token counts SHALL leave usage unchanged until a later native usage update

