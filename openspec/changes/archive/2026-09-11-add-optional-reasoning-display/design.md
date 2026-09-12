## Context

Protocol Core already projects a minimal Host Reasoning Item into Codex app-server notifications:

- `item/started` for a `reasoning` Item;
- `item/reasoning/summaryTextDelta` for explicit visible text;
- `item/completed` with the accumulated `summary` array.

Claude Code's `thinking_delta` is already normalized into this lifecycle. The missing boundary is presentation: current Desktop builds may accept the Item notifications without retaining a visible text lane. Injecting final-answer text would corrupt the transcript, while reading complete native thinking blocks would cross the privacy boundary.

## Goals / Non-Goals

**Goals:**

- Provide an explicit default-off preference.
- Show exact validated summary text for the active external Thread.
- Expand during streaming, auto-scroll, and collapse after completion.
- Remain event-driven and browser-safe.
- Fail closed on unknown ownership, malformed notifications, unsupported DOM, or unavailable request bridges.

**Non-Goals:**

- Display hidden, redacted, encrypted, signed, or inferred chain-of-thought.
- Reconstruct historical reasoning from Mapping Store or a second transcript.
- Alter Claude Code, Grok, Codex, provider, login, or permission configuration.
- Replace a verified native Desktop reasoning surface or render a second panel for native Codex Threads.
- Add polling, background refresh loops, or periodic model/Harness discovery.

## Decisions

### 1. Consume only the native summary lane

The Renderer validates three notification forms and ignores every other payload. Delta notifications must identify a Thread, Turn, Item, summary index, and string delta. Start/completion notifications must carry a `reasoning` Item whose `summary` is an array of strings. Only `summary` is joined for display; `content` and unknown fields are ignored even when present on the same object.

This keeps the Renderer downstream of the existing UI-independent Host Item contract and prevents Harness-native payloads from leaking into browser code.

### 2. Gate every Thread through fixed ownership inspection

The request manager receives notifications for native and external Threads. On the first reasoning event for a Thread, the display performs one fixed `codexhost/thread/inspect` request and queues that Thread's events until ownership is known. External ownership releases the queue in order; Codex ownership or inspection failure discards it and is cached as non-displayable for the current in-memory generation.

This avoids duplicate native Codex presentation and avoids a request per delta.

### 3. Store only current in-memory presentation state

The display keeps the latest reasoning Item snapshot per Thread in a Map. A start replaces an older Item, deltas append exactly once, and completion replaces the text with the authoritative summary when present. Disabling the preference or disposing the extension removes panels, subscriptions, ownership results, queued events, and text.

No reasoning text enters localStorage. Only the boolean opt-in is persisted.

### 4. Mount beside the verified Composer contract

The panel uses the existing `data-codex-composer-root` and direct `data-above-composer-portal` identity contract. It is inserted immediately before the matching Composer, not inside React-owned transcript nodes. Unsupported or ambiguous Composer identities render nothing.

The panel uses a native `<details>` element. It is open for live output, scrolls the plain-text body to the newest content, and closes on completion while remaining manually expandable.

### 5. Observe DOM only while opted in

When disabled, the feature has no app-server reasoning subscription and no MutationObserver. Enabling attaches one notification subscription and one event-driven DOM observer; disabling tears both down. DOM writes are equality-guarded so the observer cannot self-trigger a Renderer refresh loop.

### 6. Scope state to one live Host route and bound ownership checks

The reasoning notification relay carries a monotonically increasing connection token. Replacing or losing the active Host route invalidates the old callback before source-side teardown, clears ownership decisions and visible state, and rejects late ownership results from the previous route. A Thread ID alone is never treated as identity across Hosts.

Each new desktop-control policy exposes the exact request target that was already validated when the policy was installed. A replacement-policy event therefore reconnects the relay directly to that target without repeating Composer DOM/Fiber discovery. A policy that claims this contract but returns a malformed target or a target for another Host fails closed. Policies from older desktop-control versions may still use Fiber discovery and a temporary DOM observer as a best-effort compatibility path; that observer is disconnected as soon as the route is restored, another policy event arrives, or the adapter is disposed.

The fixed ownership inspection fails closed after five seconds. While it is pending, deltas for the current Item are coalesced into a per-Thread buffer capped at 256 KiB. Timeout, cancellation, inspection failure, or buffer overflow discards the whole pending summary for that route rather than rendering an incomplete or unproven result.

## Risks / Trade-offs

- **Desktop DOM contract changes:** the panel fails closed and the Composer remains usable; no broad selector fallback is used.
- **Ownership inspection races:** events are coalesced per Thread behind one five-second request, capped at 256 KiB, and discarded on route change or failure rather than shown under the wrong owner.
- **Long summaries:** the body has a bounded height and scrolls while live; completion collapses it.
- **Historical visibility:** reopening a Thread may not reconstruct an old summary panel. Native Session history remains authoritative, and this change intentionally avoids a second transcript.
- **Native surface becomes available later:** ownership gating prevents native Codex duplication; a future Desktop contract gate can disable the fallback for external Threads when a faithful native external lane is proven.

## Migration Plan

1. Ship the preference disabled by default.
2. Validate notification decoding and in-memory state with unit tests.
3. Validate the real DOM lifecycle in Chromium, including live expansion, completion collapse, privacy-field omission, opt-out teardown, and Codex ownership exclusion.
4. Keep the existing Protocol Core projection unchanged so disabling or removing the Renderer surface is a reversible presentation-only rollback.
