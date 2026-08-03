## Context

The formal architecture already includes Reasoning in the finite Host Item set and forbids manufacturing Reasoning that a Harness did not emit. Production code has not reached that target: `HostItem` contains Agent Message, Command, Tool, and File Change only; Protocol Core projects only Agent Message text deltas; Pi ignores RPC `thinking_delta` and historical `thinking` blocks; Claude parses only `text_delta` and final `text` blocks. The Claude main spec also explicitly rejects all non-text content at the Adapter seam.

The installed Pi RPC protocol provides structured thinking start/delta/end events and persisted Assistant thinking blocks. The Claude Agent SDK can provide `thinking_delta` stream blocks and complete Assistant `thinking` blocks; redacted or signature-bearing forms do not provide displayable text. The current Codex app-server schema exposes a `reasoning` Thread Item with `summary` and `content` arrays plus summary and content delta notifications, but static schema presence does not prove the current Desktop's visible ordering and rendering behavior.

Paseo is useful comparative evidence: each provider independently converts native thinking to a provider-neutral append-only Reasoning timeline entry, reconciles streamed and complete content, and renders it separately from the final answer. Paseo is AGPL reference material and persists a normalized Timeline, so codexhost will independently implement only the compatible behavioral pattern and will not copy code or persistence semantics.

This Change overlaps source ownership with the active Pi Slash Command work and possible Claude interaction work. Its artifacts can be reviewed independently, but production implementation must begin from the then-current mainline and re-evaluate those Changes rather than merging their functionality into Reasoning.

## Goals / Non-Goals

**Goals:**

- Carry only explicit, non-empty, user-visible native reasoning text through a small UI-independent Host Item.
- Preserve native ordering, stream content once, reconcile complete messages, and restore deterministic completed Reasoning Items from Native Session history while matching Desktop's stock duration-only completed presentation.
- Use the existing Host Item lifecycle and current Codex Reasoning UI surface without adding a Renderer feature.
- Close every started Reasoning Item before its Turn terminal under success, cancellation, failure, close, and fault.
- Keep official Codex passthrough and existing Agent Message, Tool, Interaction, Usage, Model, and Thinking-control behavior unchanged.

**Non-Goals:**

- Exposing private, inferred, redacted, encrypted, or signature data; deriving text from Thinking level, Model metadata, or reasoning Token counts.
- A Reasoning capability catalog, per-Model policy, user display setting, custom Renderer component, search, export, or cross-Harness transfer.
- A persisted Host Timeline, Mapping Store content, Native Session format change, or historical content cache.
- Refactoring unrelated text, Tool, Approval, Question, Slash Command, or Agent configuration behavior.
- Batching or throttling deltas in the first slice; existing ordered transport and Desktop behavior remain the baseline.

## Decisions

### 1. Add one minimal Host Reasoning Item and reuse text append

`harness-adapter` adds only:

```text
HostReasoningItem {
  type: "reasoning"
  itemId: HostItemId
  text: string
}
```

It joins the existing `HostItem` union. Reasoning uses the existing `{ type: "text.append", text }` update because that operation already means an ordered append to textual Item state. Protocol Core chooses the notification by inspecting the active Item type. No new public update, content-part type, Provider field, summary flag, token field, native message ID, or capability flag is introduced.

An Adapter starts a Reasoning Item lazily on the first non-empty visible reasoning text. Empty native start/end markers produce no Host Item. An Adapter may emit zero or more Reasoning Items in a Turn; support for the structural Item does not claim that a particular Model or Turn will emit one.

Alternative: expose native thinking blocks or a generic payload. Rejected because it leaks Harness protocols and forces Host consumers to understand them.

Alternative: model Codex `summary[]` and `content[]` in HarnessAdapter. Rejected because Pi and Claude do not provide a stable shared distinction, and the UI carrier must not become the domain contract.

Alternative: add `supportsReasoning` to Session capabilities. Rejected because the architecture treats actual Reasoning as native output, not a duplicated dynamic Model capability.

### 2. Normalize one Reasoning Item per native Assistant message

Each concrete Adapter privately groups the visible thinking blocks belonging to one native Assistant message into one Reasoning Item, preserving block and delta order without adding separators that were not emitted. A Turn with multiple native Assistant messages, such as a Tool loop, may therefore produce multiple Reasoning Items.

Pi uses its Assistant message start/update/end boundary. It converts `thinking_delta` to private Reasoning append events and uses the final Assistant message's `thinking` blocks to reconcile a missing suffix. `thinking_start` and `thinking_end` are boundaries only.

Claude tracks the active SDK stream message identity from message-start metadata and the complete Assistant message identity where available. Only string content from `thinking_delta` and `thinking` participates. `redacted_thinking`, signatures, unknown blocks, Tool blocks, and non-string values remain private and ignored by this capability.

If a compatible runtime emits a visible reasoning delta without a start marker, the Adapter lazily opens the current message's Reasoning Item. If an end marker is missing, the Adapter closes the Item at the next proven Assistant-message boundary or during Turn finalization. This tolerance does not permit content after an Item terminal.

Alternative: one Reasoning Item for the entire Host Turn. Rejected because it can remain open across Tools and merge distinct native Assistant messages, producing misleading ordering.

Alternative: one public Item per native content-block index. Rejected because it exposes transport granularity without improving the first user-visible slice.

### 3. Reconcile streaming and complete content before the Host seam

For each native Assistant message, the Adapter records the exact Reasoning text already emitted. When a complete message arrives:

```text
complete starts with streamed -> emit only the missing suffix
no streamed content           -> emit complete content once
complete equals streamed      -> emit nothing
incompatible content          -> fail the accepted Turn; do not replay or silently replace
```

This mirrors the existing proven Claude Agent Message rule while keeping reconciliation inside the concrete Adapter. The final Item snapshot must equal the concatenation of its append updates. Final completion never replays already projected text.

Reasoning is presentation output, not Turn outcome evidence. A reasoning-only Pi message does not turn an otherwise invalid empty native Turn into success, and neither Adapter infers success from the presence of reasoning text.

Alternative: trust only partial deltas. Rejected because both Harnesses can produce complete content without partial streaming.

Alternative: replace conflicting visible text at completion. Rejected because the current Host update contract is append-only and silent replacement would diverge from what the user already saw.

### 4. Apply the existing Item lifecycle without a parallel Reasoning state machine

The Adapter owns live Reasoning Item IDs and accumulated text using the same active-Turn state that already owns Agent Message and Tool Items. A normally closed native Assistant message completes its Reasoning Item with `succeeded`. If cancellation, failure, Session close, or fault occurs while a Reasoning Item remains active, the common Turn finalizer closes it with the corresponding outcome before `turn.completed`.

Reasoning Item completion does not wait for the whole Turn when a normal native message boundary is known. Late native deltas after completion are protocol failures or ignored only after the existing idempotent Turn finalizer has made the entire Turn terminal.

The supported-Desktop Gate proved that projecting the current eager empty Agent Message start before Reasoning is not faithful: live Reasoning can appear, but completion and answer ordering become unstable. Adapters retain the established Host Agent Message lifecycle, while Protocol Core defers the external Codex `agentMessage` `item/started` notification until the first non-empty Agent Message append. A never-visible empty Agent Message is omitted from the Codex projection. This private projection rule lets native Reasoning precede later answer text without changing HarnessAdapter semantics, Approval/Question ordering, or official Codex passthrough.

### 5. Add deterministic Reasoning Items to Native history Snapshots only

Pi and Claude history mappers add Reasoning Item snapshots from explicit persisted `thinking` blocks. IDs are deterministic from the owning native Assistant message or Entry identity plus a Reasoning kind/ordinal, without changing existing Agent Message IDs or Mapping Store format. Item order preserves the supported native Reasoning versus Agent Message order within the Assistant content that the mapper can prove.

Native Session remains the sole persistent Transcript. Live projector state remains in memory, and reopening a Thread calls the existing `readSnapshot()` path. Reasoning text is not written to Mapping Store, logs, diagnostics, Gate reports, or a new cache.

Alternative: persist projected Reasoning for fast reopen. Rejected because it would create a second Transcript and require recovery, migration, and synchronization semantics unrelated to display.

### 6. Project through the Gate-proven Codex summary lane

The bounded synthetic Gate used Desktop `26.727.6591.0` with its bundled app-server `0.146.0-alpha.9.2`. It isolated the user Thread from Desktop's ephemeral title-generation Thread and tested native Reasoning shapes without calling a Model. The selected live wire sequence is:

```text
item/started {
  item: { id, type: "reasoning", summary: [], content: [] }
}
item/reasoning/summaryPartAdded { itemId, summaryIndex: 0 }
item/reasoning/summaryTextDelta { itemId, summaryIndex: 0, delta }
item/completed {
  item: { id, type: "reasoning", summary: [completeText], content: [] }
}
```

Protocol Core emits `summaryPartAdded` once immediately before the first non-empty summary delta. Additional Host appends reuse `summaryIndex: 0`. A historical completed Item uses the same final `{ summary: [text], content: [] }` shape without replaying live delta notifications.

The Gate established these version-scoped UI facts:

- The content lane was accepted by the protocol but did not visibly expose its text.
- The summary lane visibly displayed text while the Turn was active, then retained only the stock `Worked for`/`已处理` duration presentation after completion.
- Combining summary and content did not make completed text inspectable and is unnecessary.
- The supported stock Codex experience uses the same live-summary and duration-only same-session completion behavior. Completed summary text is not required to remain inspectable.
- Starting an empty external Agent Message first made completion and answer ordering unstable, so Decision 4 defers only that Codex projection.
- After a full Desktop/Fake Host restart, sidebar reopen issued real `thread/read` requests and restored the final answer, while Desktop omitted both the earlier summary text and the completed Reasoning indicator. Historical Adapter snapshots and wire Items remain deterministic, but no historical Reasoning UI is required because this product goal is live work awareness.

Using the summary lane is semantically honest because codexhost supplies only text that the native Harness explicitly designated as user-visible thinking; Protocol Core neither fabricates a summary nor claims to expose private chain-of-thought. `summary` is a private Codex UI carrier, not a HarnessAdapter claim about how Pi or Claude generated the text. The Change does not fall back to Agent Message text, custom Renderer UI, or hidden persistence.

### 7. Keep composition, routing, configuration, and load behavior unchanged

Host Runtime already routes and orders generic Host Item events, so it gains no Reasoning-specific method, registry, or Harness branch. Official Codex frames remain transparent. Renderer Extension is untouched.

Thinking selection remains a configuration operation and Usage remains telemetry; neither can create Reasoning. No coalescer is added in the first slice because existing Agent Message deltas already exercise the same ordered path. Performance optimization requires measured evidence in a later Change.

Implementation must rebase after source-overlapping active Changes and run their focused regressions. This Change does not modify their specs or claim their Gates.

## Risks / Trade-offs

- [The current Desktop schema accepts Reasoning but the UI does not render the chosen lane] -> The Gate selected the visible summary lane; re-gate on supported Desktop changes and do not add a custom UI fallback.
- [The eager Agent Message start produces visible ordering inversion] -> Defer only the external Codex Agent Message start until its first non-empty append and test omitted empty Items plus Reasoning-before-answer order.
- [Partial and complete native thinking disagree] -> Fail closed before Turn success instead of replaying or replacing visible content.
- [Native message identity or boundaries are absent] -> Permit one lazily opened current-message Item and close it only at the next proven boundary or Turn terminal; do not invent multiple blocks.
- [Reasoning contains sensitive project information] -> Display only explicit native text in the owning Thread and exclude it from Mapping Store, diagnostics, cross-Harness context, and committed evidence.
- [High-frequency deltas increase event volume] -> Reuse the existing text path initially; add measured bounded coalescing only in a separate Change.
- [Pi Slash or Claude interaction work changes the same modules] -> Rebase and reread active artifacts before implementation, preserving this Change's narrow ownership.
- [Paseo code is tempting to reuse directly] -> Use it only as behavioral evidence and independently implement due to AGPL and incompatible Timeline ownership.

## Migration Plan

1. Use the completed current-Desktop synthetic Gate baseline: summary lane, one summary part at index zero, duration-only native completion, and deferred empty Agent Message projection.
2. Add the Host Reasoning Item, reuse text append, and extend Fake Adapter and Protocol Core lifecycle tests while preserving current Approval and Question behavior.
3. Implement Protocol Core live and historical Reasoning projection, then verify `thread/read` restores the final answer from deterministic history without replaying live deltas; historical Reasoning UI is an observation, not an acceptance requirement.
4. Add Pi and Claude private event parsing, reconciliation, lifecycle, history mapping, and focused tests.
5. Run affected package checks and controlled real Harness/Desktop Gates with sanitized evidence.
6. Update architecture and implementation baselines only for behavior and evidence actually completed.

Rollback removes the union member and Adapter/projector branches. No persistent record, Native Session, user configuration, or official Codex resource requires migration or cleanup.

## Resolved Gate Questions

- The supported Desktop does not visibly render the tested content lane; Protocol Core uses the summary lane shape recorded in Decision 6.
- Live summary text followed by a duration-only same-session completed state matches stock Codex behavior and is faithful for this product goal; completed text and any Reasoning UI after reopen are not required.
- An eagerly projected empty Agent Message does not preserve stable Reasoning-before-answer completion; Protocol Core defers that external Codex Item start until the first non-empty answer append.

## Validation Status

The controlled real Pi/Desktop Gate on Desktop `26.727.6591.0` passed the complete Pi acceptance matrix: live visible Reasoning, Reasoning before Tool and final text, duration-only completion, final-answer reopen after Desktop restart, same-Thread continuation, and zero Reasoning Items when the isolated Pi Thinking level was `off`. Temporary Reasoning text, credentials, Native Sessions, profiles, and IDs were removed; the native Codex global state was restored byte-for-byte.

Official passthrough regressions and a production Host initialize handshake against bundled app-server `0.146.0-alpha.9.2` also passed. The bounded real Claude SDK/Desktop Gate remains unrun because it requires explicit quota/network authorization. Detailed sanitized evidence and remaining risks are recorded in `验证结论.md`.
