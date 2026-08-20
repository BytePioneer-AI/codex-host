## Context

Grok CLI auto-compacts when the context window crosses a native threshold. A real Grok 1.0.5 session on this machine emitted:

```text
_x.ai/session/update  auto_compact_started     tokens_used=401965  context_window=500000
_x.ai/session/update  compaction_checkpoint
_x.ai/session/update  auto_compact_completed   tokens_before=401965 tokens_after=10820
session/update        agent_thought_chunk      _meta.totalTokens=10820
```

These updates are Grok extension notifications, not standard ACP `session/update`. GrokAdapter currently maps only text, thought, tool, usage, turn completion, and rewind. Auto-compact is dropped, so Codex shows usage collapsing without a Context Compaction Item.

Pi already projects native `compaction_start` / `compaction_end` as `HostContextCompactionItem` on the active Turn. Protocol Core already renders `contextCompaction`. This change copies that Host projection for Grok auto-compact only.

## Goals / Non-Goals

**Goals:**

- Project Grok auto-compact start and terminal outcomes as the standard Context Compaction Item during an active Turn.
- Reconstruct the same Item from Native `updates.jsonl`.
- Refresh context usage from compact `tokens_after` when compact succeeds.
- Ignore internal Grok checkpoints and unknown compact-adjacent updates.

**Non-Goals:**

- Manual `/compact` / `x.ai/compact_conversation`.
- Host-owned compaction, threshold configuration, or summary text rendering.
- Changing Protocol Core, Host Runtime, or Renderer contracts.
- Projecting `compaction_checkpoint` as a Host Item.

## Decisions

### 1. Reuse Pi's Context Compaction Item, not a Grok-specific UI type

Pi and Claude Code already emit `HostContextCompactionItem`. Protocol Core projects `{ type: "contextCompaction" }`. GrokAdapter must translate native auto-compact onto that item so Codex Desktop needs no Grok branch.

Alternative: show compact only as a usage drop. Rejected because the user asked for Codex projection and the Host item already exists.

### 2. Listen to `_x.ai/session/update` through ACP `extNotification`

Live auto-compact does not use standard `session/update`. The ACP TypeScript SDK routes unknown agent-to-client notifications to `Client.extNotification` when that callback is registered. GrokAcpTransport will register it and reuse the existing update mapper for params that look like `{ sessionId, update, _meta }`.

Accepted methods:

- `_x.ai/session/update` (observed wire format)
- `x.ai/session_notification` (documented alias)

Unknown methods and malformed params are ignored.

Alternative: parse only Native history and skip live. Rejected because auto-compact happens mid-Turn and must appear while the Turn is running.

### 3. Keep compact parsing inside the Grok Adapter

A focused Grok module maps:

| Native `sessionUpdate` | Transport event |
| --- | --- |
| `auto_compact_started` | `compaction.started` |
| `auto_compact_completed` | `compaction.completed` / succeeded |
| `auto_compact_failed` | `compaction.completed` / failed |
| `auto_compact_cancelled` | `compaction.completed` / cancelled |
| `compaction_checkpoint` | ignored |

The same mapper is used by live `session/update`, extension notifications, and `updates.jsonl` replay. Snake_case and camelCase token fields are both accepted. Missing optional token fields do not fail the Item.

### 4. Attach compact to the active Turn; do not open a new Turn

Auto-compact is preflight/mid-Turn. GrokAdapter will start and complete the Context Compaction Item on the current Turn, matching Pi's prompt-preflight path. Compact events without an active Turn are ignored live and ignored in history when no user Turn is open.

Open agent/reasoning Items are completed before compact starts, matching GrokAdapter's existing Tool boundary so live order and history order stay aligned.

### 5. Refresh usage from compact token counts

On succeeded compact, publish `contextUsedTokens` from `tokens_after` and `contextWindowTokens` from the started event or the current model catalog. Do not invent usage when those numbers are absent; later `_meta.totalTokens` updates remain the fallback.

## Risks / Trade-offs

- [Grok may rename the extension method] → Accept both observed and documented method names; ignore unknown methods.
- [Compact can take ~50s] → This change does not wrap `session/prompt` in the 30s command timeout; live compact stays inside the existing Prompt.
- [History may contain `started` without `completed`] → Emit a history Item only for a terminal compact outcome.
- [Duplicate `started` events] → Ignore a second start while a compact Item is already open.
- [Manual compact still invisible] → Accepted for this slice; it needs a separate command catalog change.

## Migration Plan

No persistence or protocol migration. Existing Grok Threads gain compact Items on the next history rebuild when Native `updates.jsonl` contains auto-compact records.

## Open Questions

None for this slice. Manual Grok `/compact` remains a follow-up.
