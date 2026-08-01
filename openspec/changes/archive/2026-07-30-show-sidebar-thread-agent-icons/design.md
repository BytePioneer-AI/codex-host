## Context

External Thread ownership is now persisted in the Mapping Store and the active history/Fork change exposes `codexhost/thread/inspect` to restore an opened conversation Composer. That operation deliberately resolves the full external runtime: an unloaded mapped Thread may call `HarnessAdapter.open(resume)`, read a Snapshot, and align history. Reusing it for every mounted sidebar row would make passive list rendering start Native Sessions and perform unrelated history I/O.

Supported Codex Desktop builds render mounted local sidebar rows with `data-app-action-sidebar-thread-row`, `data-app-action-sidebar-thread-id`, `data-app-action-sidebar-thread-host-id`, `data-thread-title-trigger`, and `data-thread-title`. Controlled validation proved that `data-app-action-sidebar-thread-id` is an opaque task key, not the Host Thread ID. The owning row Fiber has repeated but equal `conversationId` props whose `dataAttributes` exactly match the row attributes. Current rows are virtualized and may be replaced or reused. The row component already has title-prefix layout, while right-side space is owned by runtime status and hover actions. Existing Renderer Agent controls already own reviewed Pi and development-gated Claude Code artwork.

The active history/Fork change explicitly excludes complete external `thread/list` aggregation. This change decorates external rows that Desktop has already mounted; it does not make a missing persisted Thread appear after restart.

## Goals / Non-Goals

**Goals:**

- Show a compact, accurate Pi or Claude Code ownership icon on mounted external sidebar Thread rows.
- Resolve ownership from Mapping Store metadata without opening, resuming, or reading a Harness Session.
- Keep fixed control methods browser-safe, strict, bounded, and free of Native refs or conversation content.
- Survive sidebar virtualization, row replacement, late request completion, and Renderer disposal.
- Preserve native row selection, rename, status, pin, archive, hover, and accessibility behavior.

**Non-Goals:**

- Full external `thread/list` aggregation, pagination, search, Archive/Unarchive, or Detach.
- Adding Harness identity to Codex protocol Thread payloads or overloading Model Provider/Subagent fields.
- Showing Models, Providers, accounts, billing sources, Native Session state, or unsupported arbitrary Harness artwork.
- Making sidebar ownership lookup a generic Renderer request API.

## Decisions

### 1. Add a fixed bounded ownership-list control

Shared Contracts adds strict params containing one to 100 unique Host Thread IDs and a strict result containing one ordered ownership entry per requested ID. An entry is either `owner: "codex"` or `owner: "external"` with a bounded Harness ID. Renderer validates that the response contains exactly the requested IDs once each.

The fixed method is `codexhost/thread/ownership/list`. A batch avoids one request per row while the bound prevents an unbounded Mapping Store query. The response excludes transport Models, cwd, title, Native refs, runtime status, and history.

Alternative: reuse `codexhost/thread/inspect`. Rejected because it restores unloaded external runtime state and needs effective Model data for Composer restoration.

Alternative: encode Harness in `modelProvider`, `agentNickname`, `agentRole`, or `extra`. Rejected because Provider and Harness are distinct domains, Agent fields describe Codex Subagents, and private payload preservation is not a stable Renderer contract.

### 2. Resolve only persisted ownership

Host handles the fixed method before normal routing. For each validated ID it calls `ExternalThreadRepository.find()` directly. A stored record is external regardless of creating/ready runtime state; no record is classified as Codex. Any Store read failure fails the whole request, preventing a partial result from silently mislabeling an external Thread.

The handler never calls `ExternalThreadRuntime.resolve()`, `HarnessAdapter.open()`, `readSnapshot()`, or the official app-server. Harness ownership is immutable after Thread creation, so the Renderer may cache successful results for its lifetime.

### 3. Keep sidebar behavior in a focused versioned module

A new Renderer sidebar module scans only mounted `[data-app-action-sidebar-thread-row]` elements. For each row, the versioned DOM adapter requires one React Fiber property, walks a bounded parent chain, and accepts only `conversationId` candidates whose sibling `dataAttributes` exactly match that row's task-key, host, and row-marker attributes. Repeated equal candidates collapse to one Host Thread ID; missing, invalid, or conflicting candidates fail closed. The module never parses the opaque task key or records the recovered ID.

The controller batches uncached Host Thread IDs through the fixed client and applies a result only when the same connected row still resolves to that ID. Mutation scanning removes stale decoration when a row is recycled and reapplies decoration after React replaces title DOM. Known external Agents receive a small non-interactive prefix inside `[data-thread-title-trigger]`, before `[data-thread-title]`. Codex rows remain unchanged. Unknown Harness IDs, unavailable request manager, malformed results, and unsupported row/Fiber shapes remain undecorated. The module does not block navigation because the icon is informative, unlike Composer ownership restoration which controls execution routing.

The Renderer Binding Probe owns installation/disposal and triggers a refresh when the versioned Adapter client becomes available. It does not discover a second request manager or expose raw `sendRequest`.

### 4. Share reviewed Agent artwork

The existing Agent labels and icon factory move from the picker into a browser-safe Renderer-owned module used by both Composer controls and sidebar decoration. Sidebar icons use a fixed 14px box, `pointer-events: none`, an accessible Agent label, and a tooltip. No new image dependency is introduced.

### 5. Verification remains layered

Hermetic tests cover strict/unique/bounded contracts, exact response matching, Mapping Store-only Host handling, no Adapter resume, row decoration, Codex omission, stale row reuse, request failure, React replacement, and disposal. A controlled Desktop check confirms the current supported build exposes the expected attributes and that the icon does not overlap title, status, or hover actions.

## Risks / Trade-offs

- [Desktop private sidebar attributes change] -> Keep selectors and behavior in the versioned Renderer module, fail closed, and require a new build Gate.
- [Request manager is temporarily unavailable] -> Leave rows undecorated and refresh when Adapter state or sidebar DOM changes; never infer ownership.
- [Virtualized row is reused while lookup is pending] -> Re-resolve the validated row/Fiber association and exact Host Thread ID before applying each result.
- [Renderer mutation triggers its own observer] -> Mark owned icon nodes, cache immutable results, and coalesce scans in a microtask.
- [Persisted external Thread is absent from Desktop list] -> Keep `thread/list` aggregation as a separate required product slice; this change only decorates mounted rows.

## Migration Plan

1. Add Shared Contracts and Host ownership-list handling with hermetic tests.
2. Extract the shared Agent icon renderer and add sidebar decoration tests.
3. Integrate decoration with the existing Renderer Binding Probe and run focused checks/build.
4. Run a controlled supported-build Desktop visual check; rollback removes the fixed method and Renderer decorator with no Store or Native Session migration.

## Open Questions

- The current macOS build exposes the same row attributes as the previously validated build; the target Windows build still requires a visual Gate before claiming cross-platform sidebar support.
