## Why

Codex Desktop now consumes the complete paginated `ThreadRevertResponse` when a user edits the latest message, but codexhost omits both required history cursors for external Threads. The native rollback succeeds while the Renderer receives an incomplete response, so the supported edit-and-resubmit workflow cannot reliably update its canonical history state.

## What Changes

- Return `turnsBackwardsCursor` and `itemsBackwardsCursor` on every successful external `thread/revert`, using the same cursor semantics as external paginated resume and history listing.
- Keep the response Thread metadata-only (`turns: []`), then emit exactly one `thread/reverted` notification after the successful response.
- Cover both non-empty and empty retained history, followed by an edited replacement `turn/start` on the same Host Thread and replacement Native Session.
- Enforce the existing `rollbackLastTurn` safety contract at Adapter, Host, Repository, and Mapping Store boundaries: the replacement Native Session must be distinct, the source Session and project files must remain unchanged, and the store write must compare the expected revision and source identity.
- Replace OpenCode's source-mutating `session.revert` implementation with an exclusive transcript Fork, and make Grok and Claude Code report rollback unsupported until each can derive a distinct, durable replacement for every retained prefix, including an empty one.
- Preserve the existing bounded latest-Turn rollback behavior and fail closed for stale, non-latest, active, legacy-history, or unsupported requests; full arbitrary-boundary revert remains a separate capability change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-thread-fork-routing`: Make the existing external latest-message revert response exactly match the current paginated Codex Desktop contract and specify edit-and-resubmit continuity.
- `harness-adapter-history-fork-session`: Reassert the distinct, source-preserving last-Turn rollback guarantee and require unsupported reporting for an in-place-only Harness.

## Impact

- `protocol-core`: exact `ThreadRevertResponse` projection.
- `host-runtime`: enforce distinct replacement identity and derive retained Turn and Item cursors from committed external history.
- `mapping-store`: compare the expected record revision and source Native Session when atomically replacing a last-Turn prefix; the persisted record format is unchanged.
- OpenCode and Grok Adapters: safe distinct transcript Fork for OpenCode; explicit unsupported capability for Grok's in-place-only Rewind.
- Focused protocol, Mapping Store, Adapter, real OpenCode, and Host regression tests plus the affected OpenSpec requirements.
- No Renderer extension, dependency, or project-file rollback behavior is introduced.
