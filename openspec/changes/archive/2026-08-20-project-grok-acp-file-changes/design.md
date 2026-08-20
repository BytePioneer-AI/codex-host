## Context

Grok Build 1.0.4 emits standard ACP `ToolCallContent` entries with `type: "diff"`, an absolute `path`, native `oldText`, and native `newText`. The current Transport preserves Tool content but GrokAdapter only extracts text output. Protocol Core already projects `HostFileChangeItem` into Codex file-change and aggregate Turn Diff notifications.

A structure-only inspection of Native history showed provisional edit updates may carry incomplete `oldText`; the matching `status: "completed"` update carries the authoritative result. Diff generation must therefore be tied to the successful terminal Tool event.

## Goals / Non-Goals

**Goals:**

- Project valid successful Grok ACP Diff Content as `HostFileChangeItem`.
- Produce deterministic Unified Diff without rereading files or inspecting Git.
- Reconstruct the same File Change Items from Grok Native history.
- Preserve Tool-only behavior for all unsupported or unreliable shapes.

**Non-Goals:**

- Workspace-wide `x.ai/git/diffs`, `diff_review`, hunk review actions, or Renderer changes.
- Inferring file creation or deletion from empty text.
- Persisting Diff in codexhost-owned storage.

## Decisions

### 1. Treat successful terminal ACP Diff Content as the evidence source

Only `tool_call` or `tool_call_update` with `status: "completed"` may produce a File Change. Provisional, failed, cancelled, or orphaned updates remain Tool-only. This preserves direct Tool attribution and avoids provisional Grok payloads whose original text can be incomplete.

Alternative: query `x.ai/git/diffs` after each Turn. Rejected because workspace state can include human, prior-Turn, or concurrent changes and requires Git-specific correlation.

### 2. Serialize native before/after text in a focused Grok module

A new Grok-owned parser validates ACP Diff Content, normalizes absolute paths for display, enforces a bounded combined text size, and uses `diff.createTwoFilesPatch` with three context lines. `oldText === null` maps to `add`; a string maps to `update`. ACP v1 has no unambiguous delete representation, and empty strings are not interpreted as file kinds.

Malformed, no-op, oversized, or partially invalid Diff arrays return no File Change rather than failing the Tool or Turn.

### 3. Emit a separate File Change Item after the Tool terminal

The successful Tool completes first, followed by one started/completed File Change Item containing all validated Diff entries from that terminal event. This matches existing Claude Code and DeepSeek Adapter behavior and lets Protocol Core handle Codex projection unchanged.

### 4. Reuse the parser for Native history

History reconstruction completes Tools when terminal statuses appear and appends the same File Change Item immediately afterward. Provisional Diff Content is never used as a resume fallback.

## Risks / Trade-offs

- [Full before/after text can be large] -> Enforce a conservative combined text limit and degrade to Tool-only.
- [Grok omits `oldText` or terminal content] -> Do not infer from Tool arguments, disk, or Git.
- [ACP v1 cannot prove deletion and Grok may encode creation with empty old text] -> Report only `add` when old text is explicitly null; otherwise report `update`.
- [A terminal event contains mixed valid and malformed Diff entries] -> Fail closed for the complete File Change to avoid partial summaries.
