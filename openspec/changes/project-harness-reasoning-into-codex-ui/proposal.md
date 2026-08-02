## Why

Pi RPC and the Claude Agent SDK can expose structured user-visible thinking text, but the current Adapters discard it before the Host seam even though the supported Codex app-server protocol has native Reasoning Items. External Turns therefore lose useful progress during execution and omit the same content when Native Session history is reopened.

> **Implementation status:** Unblocked on Desktop `26.727.6591.0`. The synthetic Gate selected the native summary lane: explicit Reasoning text is visible while work is active, then Desktop retains its stock duration-only completed presentation. Historical projection restores the native completed Item and order without promising that completed summary text remains inspectable.

## What Changes

- Add one UI-independent Host Reasoning Item with append-only text updates and the existing ordered Item lifecycle; do not expose Pi RPC, Claude SDK, or Codex app-server payloads through HarnessAdapter.
- Map only non-empty reasoning text explicitly emitted by Pi as `thinking_delta` or persisted `thinking` content, including deterministic history Snapshot Items.
- Map only non-empty visible Claude `thinking_delta` and `thinking` text, reconcile partial and complete Assistant messages without replay, and include the same supported content in history Snapshots.
- Project Host Reasoning through the Desktop-verified Codex app-server summary lane, matching the stock live-text and duration-only completed presentation.
- Complete every started Reasoning Item before its Turn terminal under success, failure, cancellation, close, and Session fault, while preserving official Codex passthrough.
- Keep the scope limited: no private or inferred chain-of-thought, redacted/encrypted content, Thinking-level changes, Reasoning capability catalog, custom Renderer UI, new display setting, persisted Host Timeline, Mapping Store content, search, export, or Provider/Model-specific policy.

## Capabilities

### New Capabilities

- `harness-reasoning-projection`: Defines the minimal Host Reasoning Item, append and terminal semantics, honest Codex Reasoning projection, and absence/privacy behavior shared by concrete Harnesses.

### Modified Capabilities

- `harness-adapter-text-session`: Allows an accepted text Turn to expose zero or more ordered Reasoning Items in addition to its Agent Message while preserving the existing Turn and Item lifecycle invariants.
- `pi-model-routed-vertical-slice`: Maps Pi's explicit live and historical thinking text into Host Reasoning without deriving content from Thinking level, Model metadata, or Usage.
- `claude-code-text-session`: Permits explicit visible Claude thinking text across the Adapter seam, adds live/final reconciliation and historical mapping, and continues to reject all other unsupported non-text content.

## Impact

- Affected packages: `harness-adapter`, `adapters/pi`, `adapters/claude-code`, and `protocol-core`, plus their focused tests.
- Affected contracts: the internal `HostItem` union, application of the existing `text.append` update, and current Codex app-server Reasoning notification projection; no browser-safe shared schema or Host routing method is added.
- Affected history behavior: Native Session remains the only persistent Transcript source; Adapter Snapshot mapping gains Reasoning Items without changing Mapping Store records or format versions.
- Implementation must rebase onto completed or current Pi Slash Command and Claude interaction work before editing shared Adapter modules; this Change does not absorb those capabilities.
- No new runtime dependency, custom Renderer integration, official Codex behavior change, Native Session migration, or user configuration write is required.
