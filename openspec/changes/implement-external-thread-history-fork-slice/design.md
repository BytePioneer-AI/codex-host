## Context

The current Host keeps external Threads and projected Turns only in process memory. `thread/fork` is not in the explicit ownership route, HarnessAdapter only opens create Sessions, Mapping Store is a package placeholder, and Pi production transport does not expose Entries, Snapshot, resume, Fork, or Clone. The Renderer restores Agent state only for a conversation created through the same draft Composer, so a conversation returned by native `thread/fork` would otherwise mount as Codex.

The installed `codex-cli 0.145.0` generated protocol defines `thread/fork` with inclusive `lastTurnId`, exclusive `beforeTurnId`, optional tail Fork, and a normal `ThreadForkResponse`. Static inspection of supported Codex Desktop `26.721.41059` additionally proves that its message action does not put the selected non-tail boundary in that request: it first sends an unbounded `thread/fork`, then sends deprecated `thread/rollback { threadId: derivedId, numTurns }` and consumes the returned full Thread. Pi Gate C proves stable User Message Entry IDs, active-branch history, exact non-tail `fork(nextUserEntry)`, exact tail `clone`, inherited Model/Thinking state, source isolation, and continuation in the derived Session. Claude's official SDK also proves exact `forkSession(upToMessageId)`, but Claude remains development-gated and its production history mapper is not part of the public Pi slice.

The formal persistence design omitted `ephemeral` and `historyMode`, while current Desktop evidence proved those fields select the visible timeline path. This change adds them as required Host presentation metadata. It does not persist any conversation content.

## Goals / Non-Goals

**Goals:**

- Make the existing Codex message Fork action create an exact Pi-owned derived Thread through both the direct-boundary `thread/fork` protocol and the supported Desktop's unbounded Fork plus bounded rollback composition.
- Establish executable cross-Harness Snapshot, stable Turn identity, Checkpoint, resume, and Fork semantics.
- Persist the minimum ownership and identity metadata needed to route and recover a Fork source without storing a second Transcript.
- Rebuild source and derived Codex Turn projections from Native Session history with stable Host identity mapping.
- Preserve Codex Fork transparency and fail closed for every external resource or unsupported native boundary.
- Restore the derived conversation as the source Agent and lock it in the Renderer.

**Non-Goals:**

- Cross-Harness migration, selecting another Agent during Fork, replaying visible text into another Harness, or changing Thread Harness ownership.
- Project file rollback, snapshots, copies, Git branches, or Worktrees.
- Full external Thread list aggregation, Archive/Unarchive, Detach, search, pagination optimization, or complete one-class Thread management.
- Public Claude Code Fork support, Claude file rewind, or inferred Fork for a Harness without an exact native operation.
- A generic Renderer request API, native RPC escape hatch, persisted Host Timeline, or content cache.

## Decisions

### 1. Fork is a HarnessAdapter open mode

The executable interface adds `OpenSessionInput = create | resume | fork`. Fork is not a `HostCommand` because its result is another `HarnessSession`, not a mutation result on the source Session. A Fork input contains only the opaque source `NativeSessionRef`, exact `NativeCheckpointRef`, and cwd. The Adapter validates Harness and Session ownership and returns a Session whose `initialState.nativeRef` identifies the distinct derived Native Session.

`HarnessSession` adds stable `history.fork` capability and `readSnapshot()`. Turn terminal output adds optional `nativeTurnRef` plus optional Checkpoint on the outcome. Snapshot and terminal refs use the existing strict Shared Contracts schemas.

Alternative: add `executeNative("fork", payload)`. Rejected because it leaks Pi/Claude protocol and cannot express a new Session safely.

Alternative: copy source Host Turns and create a normal Session. Rejected because Native Session is the only history source and Claude remaps all copied native message IDs.

### 2. Snapshot is the only historical content projection

`readSnapshot()` reads the Native Session active history while idle and returns deterministic `HostTurnSnapshot` values. Every Turn has a stable `NativeTurnRef`; only exact Fork positions have a `NativeCheckpointRef`. Historical Item IDs are deterministic per Native Session and Adapter mapping format.

Protocol Core adds a stateless historical projector that maps Host input and completed Item snapshots to current Codex `Turn` values. It does not replay live notifications. Host aligns each Snapshot Turn by NativeTurnRef, reuses an existing Host Turn ID when present, allocates a new ID otherwise, and persists mappings before returning history.

A derived Snapshot always receives mappings in the derived Host Thread. Source Host Turn IDs and mappings are never copied, even if native Entry IDs happen to be equal.

### 3. Pi Checkpoint identifies a stable logical Turn boundary

For Pi, Native Turn identity is the stable User Message Entry ID in the source Native Session. The Pi Checkpoint is a distinct typed Ref whose checkpoint ID identifies that completed logical Turn boundary. At Fork execution, PiAdapter reads the current active branch and resolves the operation:

```text
selected Turn has a later active User Entry -> fork(nextUserEntryId)
selected Turn is the active tail          -> clone()
```

This keeps the Checkpoint stable when later Turns are appended. Encoding a permanent `clone-at` operation for a current tail would become wrong after append; rewriting that Anchor would violate stable Checkpoint identity. The Adapter still proves exactness by reading the derived active branch before returning success.

The first slice only returns Checkpoints for completed active-branch Turns that the Adapter can map exactly. A stale branch, missing source Entry, or ambiguous boundary returns `checkpointNotFound`.

### 4. Pi history and Fork live in focused private modules

`PiRpcSession` remains transport/process ownership and gains typed commands for `get_entries`, `fork`, and `clone`, plus resume argv. Pi-specific runtime parsing, active-branch traversal, Turn grouping, stable Item IDs, Snapshot mapping, and Fork boundary resolution live in separate Pi-owned modules.

A Pi Turn is one User Entry plus descendant message Entries until the next active User Entry. User text becomes Host input. Assistant text becomes Agent Message Items. Known Tool/Tool Result content is mapped only when stable native IDs and outcomes are present; unknown content is omitted or represented honestly without fabricating success. Historical outcome uses native Assistant stop/error evidence and `unknown` where proof is insufficient.

After a live Turn settles, PiHarnessSession performs an idle history read, finds the newly appended User Entry, and attaches its NativeTurnRef and Checkpoint to the terminal event. Failure to establish required stable identity after an accepted persisted Turn fails the Turn or faults the Session rather than exposing an unmappable success.

### 5. Mapping Store persists one strict JSON record per external Thread

The first production Store implements the documented one-file-per-Thread layout, exclusive process lock, strict V1 runtime schema, per-Thread write queues, same-filesystem temp replacement, startup temp cleanup, and backup recovery. The V1 record includes:

```text
hostThreadId, createRequestId, harnessId, state
nativeSessionRef?, cwd, title, archived
transportModelId, ephemeral, historyMode
forkSource?, turnMappings[]
revision, createdAt, updatedAt
```

It excludes Prompt, messages, Item snapshots, Tool output, Diff, approval answers, credentials, and Codex projections. In-memory indexes enforce unique Host Thread, create request, Native Session, Host Turn, and Native Turn refs.

Host creates a provisional record before opening a native Session. Native identity and Turn mappings are committed before a terminal event or Fork response that relies on them is exposed. If native Fork succeeds but persistence fails, Host closes the derived runtime, removes the provisional Host record, returns an error, and leaves the already-persisted native Session untouched.

A fixed injected Store interface keeps Host tests hermetic. Production uses `CODEXHOST_DATA_DIR` when set and otherwise a user-local `.codexhost` directory.

The supported Desktop's post-Fork rollback keeps the already allocated derived Host Thread ID. Host first creates the final exact Native Session, then atomically replaces that ready record's `nativeSessionRef`, retained Turn mappings, and `forkSource.hostTurnId` in one file update. Retained derived Host Turn IDs remain stable while their Native refs are rebuilt from the final Session Snapshot. A failed replacement leaves the temporary tail-Fork record and runtime authoritative.

### 6. Protocol Facade owns current Codex Fork semantics

Protocol Core adds a bounded decoder for the current `ThreadForkParams` fields needed by external routing. Host behavior is:

```text
source not in Mapping Store/runtime -> forward original frame to official Codex
source external                     -> handle locally, never forward
```

For external sources, a non-empty `path`, both boundary fields, active source Turn, mismatched cwd, incompatible Model carrier, missing native ref, unsupported capability, unknown Turn, or missing Checkpoint is rejected explicitly.

Boundary resolution is:

```text
lastTurnId   -> that Turn's Checkpoint
beforeTurnId -> previous mapped Turn's Checkpoint
no boundary  -> latest mapped Turn's Checkpoint
```

Fork before the first mapped Turn is not claimed in this slice because the PRD requires Fork from a completed Turn and neither current Adapter contract nor Pi Gate defines an exact pre-history native Checkpoint.

Host creates a provisional derived Thread, calls `adapter.open(fork)`, begins consuming outputs, reads its Snapshot, allocates derived Host Turn IDs, commits the mapping, then returns a normal `ThreadForkResponse`. `thread.id` is new, `forkedFromId` is the source Host Thread, `parentThreadId` remains null, `sessionId` follows current Codex Thread-tree semantics, and `model` is the derived Harness transport carrier. `excludeTurns=true` returns an empty `thread.turns` only after all mappings are still committed.

For the observed two-stage message action, Host also owns `thread/rollback` when its target is a mapped external Thread. This compatibility path is deliberately narrower than generic history editing:

```text
derived has forkSource
and derived Turn count == source prefix count through forkSource.hostTurnId
and derived and source are idle
and 0 < derived Turn count - numTurns < derived Turn count
-> select that retained ordinal in the source mappings
-> adapter.open(fork) from the source Checkpoint
-> verify the final Snapshot has exactly the retained count
-> atomically replace the derived ready record and runtime Session
```

The exact persisted lineage check, rather than request timing, proves that the derived Thread has not independently continued. Requests for an original external Thread, a diverged derived Thread, a zero-Turn result, an unknown source boundary, or a missing Checkpoint fail explicitly and never fall through to Codex. Codex-owned rollback frames remain unchanged. This reuses the existing HarnessAdapter Fork open mode; it does not add a generic rollback command or permit Native Session file rewriting.

Codex response-before-notification ordering is retained. Fork still emits the already established response and `thread/started` ordering. Rollback returns the current full `ThreadRollbackResponse.thread` for the same derived Host Thread and emits no replacement `thread/started` notification.

### 7. Persisted external read/resume is restored on demand

When `thread/read` or `thread/resume` references an external Store record not loaded in the current process, Host calls `adapter.open(resume)`, consumes outputs, reads and aligns the latest Snapshot, and returns the current Codex response. This is enough for reopening a known external Thread and Forking it after Host restart without claiming complete external list aggregation.

A creating record without NativeSessionRef is removed on startup. A ready record with a missing or unreadable native Session remains identifiable but returns a clear `sessionNotFound` error; it is not forwarded to Codex.

### 8. Renderer uses a fixed ownership inspection request

Renderer adds a browser-safe fixed method `codexhost/thread/inspect` with strict params and result. The result contains only `harnessId`, `locked`, optional effective Model, and the required transport carrier; it never exposes Native refs, paths, Transcript, or arbitrary state.

On mounting a conversation target not already bound to a logical Composer, Renderer resolves the validated Host Thread ID and performs this fixed inspection. An external result initializes that conversation Agent as locked and applies the confirmed carrier. Codex/unknown ownership initializes Codex. Request generations prevent stale responses from overwriting a newer target. Submission is blocked while an external conversation ownership query is unresolved or failed.

The Fork response carrier may provide an immediate optimistic hint, but Host inspection is authoritative. No message-button DOM hook is introduced.

### 9. Claude fails explicitly until its mapper is implemented

The shared interface is implemented by ClaudeCodeAdapter, but `open(resume|fork)` and `readSnapshot()` return `unsupported` in this change. This preserves the finite generic Host route and prevents an external Claude Thread from falling through to official Codex. A later Claude history Change can use proven `getSessionMessages` and `forkSession` without changing Host semantics.

### 10. Verification is layered

Hermetic tests cover public contract, Mapping Store recovery/failure and ready-Session replacement, Host ownership routing, exact boundary resolution, two-stage Fork/rollback truncation, derived identity allocation, Codex passthrough, Pi tree mapping, Pi Fork/Clone decisions, source isolation, and Renderer stale-state behavior.

The controlled real Gate uses temporary cwd and ignored evidence. It creates a Pi Thread with at least three completed Turns, Forks a non-tail Turn through the real Codex Desktop request, checks a new Pi Native Session and exact context cutoff, continues source and derived Threads independently, confirms `Pi / locked`, and confirms project files were not reverted. A separate tail Fork and official Codex regression are required before completion.

## Risks / Trade-offs

- [Pi historical Tool structures vary] -> Start from strict known structures, preserve stable text and identity, use `unknown` outcomes when evidence is incomplete, and never infer File Change.
- [Tail versus non-tail operation changes after append] -> Store a stable logical boundary and resolve current active-tree operation at execution time.
- [Store failure after native Fork leaves an unindexed native Session] -> Close runtime, remove provisional Host state, return failure, retain native history as required, and log only opaque diagnostics.
- [Host Runtime is already over 1,000 lines] -> Move Store integration, historical projection, and Fork parameter logic into focused modules rather than extending one switch-heavy file.
- [Supported Desktop encodes non-tail selection in deprecated `thread/rollback`] -> Handle only the exact persisted post-Fork prefix case, preserve official passthrough, and retain direct `lastTurnId`/`beforeTurnId` support for protocol callers that already send a boundary.
- [Two-stage non-tail Fork leaves the temporary tail Clone unindexed] -> Close its runtime after atomic replacement and retain its native history; do not add Harness-specific deletion semantics.
- [Renderer ownership query uses private request-manager discovery] -> Reuse the existing validated fixed-method client and fail closed when it is unavailable; do not expose generic sendRequest.
- [Claude implements the common interface but not Fork] -> Return explicit unsupported and retain the development gate.

## Migration Plan

1. Add contracts, delta specs, Fake Adapter history/Fork tests, and Mapping Store implementation without changing Host routing.
2. Add Pi history/resume/Fork private modules and hermetic tests.
3. Integrate Store, Snapshot alignment, external read/resume, direct Fork, and bounded post-Fork rollback into Host Runtime behind existing external ownership.
4. Add Renderer ownership inspection and forked-conversation restoration.
5. Run narrow tests, `npm run check`, `npm run build`, current protocol generation checks, then the controlled real Codex/Pi Gate.
6. Rollback removes the new Host methods and Fork route. Existing V1 records remain content-free; unsupported records can be left unread or moved aside without touching Native Sessions.

## Open Questions

- Does the target Windows Desktop build emit the same unbounded `thread/fork` followed by `thread/rollback` sequence observed in supported macOS Desktop `26.721.41059`, including the same `numTurns` calculation?
- Does current official `thread/fork` emit `thread/started` before or after the response on a completed Thread?
- Which Pi historical Tool result shapes are sufficiently stable for deterministic full Tool Snapshot projection beyond Agent Message text?
