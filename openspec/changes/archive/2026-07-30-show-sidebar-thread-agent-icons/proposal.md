## Why

External Threads that already appear in the Codex Desktop sidebar are visually indistinguishable from Codex-owned Threads, even though codexhost has immutable Harness ownership in the Mapping Store. Users need a compact ownership signal before opening a Thread, without causing sidebar refreshes to resume Native Sessions or inspect conversation history.

## What Changes

- Add a strict browser-safe batch request that reports only Host Thread ownership for bounded Thread IDs.
- Resolve sidebar ownership directly from Mapping Store metadata without opening a Harness Session, reading a Snapshot, or exposing Native refs.
- Resolve each supported-build sidebar row's Host Thread ID through a validated versioned DOM/Fiber association and decorate known non-Codex Agents with a compact icon before the title.
- Reuse the existing Pi and Claude Code Agent artwork, cache immutable ownership, and guard asynchronous results against virtualized row reuse.
- Keep Codex rows unchanged and fail closed when ownership lookup or the versioned sidebar shape is unavailable.
- Keep full external `thread/list` aggregation, archive/search behavior, and persisted list recovery outside this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `shared-runtime-contracts`: Add strict bounded Thread ownership batch params and browser-safe ownership result schemas.
- `registered-harness-routing`: Add a Mapping Store-only Host ownership inspection route that never restores external runtime state.
- `versioned-renderer-agent-routing`: Show enabled external Agent identity on supported-build sidebar Thread rows without changing Codex rows or row actions.

## Impact

Affected packages are `shared-contracts`, `host-runtime`, and `renderer-extension`, plus their focused tests and the current supported Desktop Renderer validation. No HarnessAdapter API, Native Session format, Mapping Store record format, stock Codex protocol payload, or external Thread list aggregation behavior changes.
