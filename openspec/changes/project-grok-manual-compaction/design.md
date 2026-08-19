## Context

Pi already owns the Host pattern for manual compact:

```text
Renderer command catalog
  -> Composer Harness Commands button
  -> Host command/execute
  -> Pi Adapter catalog id pi.compact
  -> temporary Turn (empty input, no nativeTurnRef)
  -> Pi RPC { type: "compact", customInstructions? }
  -> compaction_start / compaction_end
  -> HostContextCompactionItem
  -> usage refresh, then turn.completed
```

Grok auto-compact already maps `_x.ai/session/update` `auto_compact_*` onto the same Item during an active Prompt Turn. Manual `/compact` is still missing: Grok Session has no `commands` capability, and Transport has no compact request. Grok's native operation is ACP `x.ai/compact_conversation`, not a Prompt.

Grok 1.0.5 typeinfo shows `CompactConversationRequest` with two fields. Native compact prompts interpolate `{user_context_section}`, and telemetry records `user_context_provided`. Observed auto-compact can exceed 50s, so the 30s ACP command timeout must not wrap this request.

## Goals / Non-Goals

**Goals:**

- Copy Pi's catalog, argument validation, busy rejection, temporary Turn, and Context Compaction Item lifecycle.
- Call Grok `x.ai/compact_conversation` instead of Pi RPC `compact`.
- Deliver compact notifications that arrive during that request onto the temporary Turn.
- Refresh context usage on succeeded compact using the existing `usageFromCompact` path.

**Non-Goals:**

- Host-owned compaction or a shared compact engine.
- Sending `/compact` as Prompt text.
- Discovering Grok's full `x.ai/commands/list` catalog.
- Changing Protocol Core, Host Runtime, or Renderer contracts.
- Persisting the temporary command Turn as ordinary Thread history.

## Decisions

### 1. Copy Pi's Session catalog and execute path, not Grok slash-as-prompt

GrokHarnessSession will expose `commands` like Pi:

```ts
{
  id: "grok.compact",
  invocation: "/compact",
  label: "Compact context",
  description: "Compact the current conversation context",
  argumentMode: "text",
}
```

`#executeHarnessCommand` will reject unknown IDs, unknown argument keys, non-string `text`, and an already-busy Session. It will open a temporary `ActiveTurn` with empty input, emit `turn.started`, call Transport compact, then `#finish` without `nativeTurnRef`.

Alternative: send `/compact ...` as `session/prompt`. Rejected because Pi's guide forbids treating compact as a Prompt, and Grok would record a user message.

### 2. Keep native details in Transport; reuse live compact projection

Add `GrokAcpTransport.compact(userContext, onEvent)` parallel to Pi's `PiRpcSession.compact`. It MUST:

- install an event listener before the ACP request so `#handleUpdate` can deliver `auto_compact_*` events without an active Prompt;
- request `x.ai/compact_conversation` with `{ sessionId, ...(userContext ? { userContext } : {}) }`, and accept `_x.ai/compact_conversation` if the documented name is method-not-found;
- not use the 30s `commandTimeoutMs`;
- treat native compact notifications as the Item lifecycle, and use the request result only as the Turn outcome fallback when notifications are missing;
- honor `session/cancel` while compact is active.

Adapter `#startCompaction` / `#completeCompaction` stay as they are. Do not invent a second Item type.

Alternative: wait for the RPC result only. Rejected because Codex needs the in-progress Compaction Item, and Grok already emits start/complete notifications for compact.

### 3. Temporary Turn is Host-only

Pi's compact `#completeTurn` omits `nativeTurnRef`, so the command Turn is not ordinary history. Grok `#finish` will do the same and MUST NOT require `#settleFromHistory` to find a new Native Turn. Native `updates.jsonl` compact records outside a user Turn remain ignored by history mapping, matching the auto-compact slice.

### 4. Optional text is user context, not a Prompt

Host argument `text` maps to Grok compact `userContext`, matching `/compact [context]`. Empty or omitted text sends only `sessionId`.

## Risks / Trade-offs

- [Request field name may not be `userContext`] → Keep the mapping in one Transport helper; if Grok rejects the field, rename after a live probe without changing Host arguments.
- [Method name may be `_x.ai/compact_conversation`] → Try documented `x.ai/compact_conversation` first, then the underscored alias, matching other Grok extensions.
- [Compact can take ~50s+] → Do not wrap this request in the 30s ACP timeout; cancel still uses `session/cancel`.
- [Completed notification can race the RPC result] → Keep the compact listener until the request settles, then clear it; synthesize `compaction.started` if complete arrives first, as auto-compact already does.
- [Fake-agent burst can still drop extension notifications after the result] → Prefer correlating compact from notifications while the request is in flight; do not clear the listener in a `finally` that races remaining `extNotification`s.

## Migration Plan

No persistence or protocol migration. Existing Grok Threads gain `/compact` in the Composer Harness Commands popover once the Adapter publishes the catalog.

## Open Questions

None that block implementation. Confirm `userContext` against a live `x.ai/compact_conversation` call during Adapter tests if a real Grok agent is available; otherwise keep the field local to Transport.
