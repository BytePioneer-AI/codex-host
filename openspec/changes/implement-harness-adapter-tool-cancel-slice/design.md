## Context

The current production path opens a lazy Pi HarnessSession, accepts one text Turn, emits one Agent Message lifecycle, and projects it directly from `AppServerHost` into Codex app-server notifications. Gate C separately proved structured Pi Tool events, cumulative Tool updates, reliable successful Edit patches, Abort convergence, and continuation after cancellation. The implementation now needs to bring those facts through the HarnessAdapter seam without restoring Pi-native knowledge in Host Runtime.

The current Desktop app-server bindings expose `turn/interrupt`, `commandExecution`, `dynamicToolCall`, `fileChange`, command output deltas, file patch updates, and turn-level diff updates. Those types belong only to Protocol Core's projector. No persisted format changes in this slice.

## Goals / Non-Goals

**Goals:**

- Add a coherent Tool/File Change/Cancel subset to the existing HarnessAdapter interface.
- Preserve one ordered Session output stream and unique Item/Turn terminal events under Tool, Cancel, Close, Exit, and Timeout races.
- Keep Pi Tool call correlation, native cumulative snapshots, Patch parsing, and Abort details private to PiAdapter.
- Move reusable Host Item to Codex app-server conversion into Protocol Core.
- Preserve lazy Pi startup, response-before-notification ordering, same-Session continuation, and Codex passthrough.

**Non-Goals:**

- Question, Approval, Permission Mode, inspect/catalog, image input, steer, history, resume, fork, Mapping Store, or stable historical Item identity.
- Claude Code implementation or product routing; the later Claude Probe consumes the public contract produced here.
- A persistent Timeline, inferred Git/file-system Diff, arbitrary native escape hatch, or complete app-server Schema generation pipeline.
- Renderer injection, packaging, or cross-restart Thread recovery.

## Decisions

### 1. Extend the existing discriminated unions only for this vertical slice

`HostCommand` adds `turn.cancel`. `HostItem` adds `commandExecution`, `toolExecution`, and `fileChange`. Updates distinguish text/output append from cumulative output replacement and file-change replacement. Command success only acknowledges that cancellation was requested; the ordered `turn.completed` event remains the sole Turn terminal fact.

Alternative: publish the complete target HarnessAdapter now. Rejected because Interaction, Snapshot, catalogs, resume, and fork would remain placeholder methods.

Alternative: add `executeNative(method, payload)`. Rejected because it would expose Pi RPC and prevent the next real Adapter from validating the seam.

### 2. Give Pi's private transport a typed Turn event sink

`PiRpcSession` changes from a text-only callback to a private `runTurn()` event sink that reports text deltas and validated Tool start/update/end events. It continues to own JSONL framing, command correlation, stable Agent settlement, timeouts, and process cleanup. `PiHarnessSession` owns Host IDs, Tool-call maps, output ordering, outcomes, and exact lifecycle finalization.

Pi `partialResult` is cumulative, so PiAdapter emits `output.replace`; it never treats that value as an append delta. Native Tool arguments and output are runtime-checked JSON before first formal consumption. Known malformed Tool lifecycle events fault the Session; unknown future event types remain isolated.

Alternative: send Pi events directly to Host and map them there. Rejected because Host would again own Pi transport semantics.

### 3. Map native Tool calls to finite Host semantics

Pi `bash` maps to `commandExecution`; other Tools map to `toolExecution`. A Tool start creates one Host Item keyed internally by native Tool Call ID. Updates and completion reuse that Item ID, and interleaved calls remain independent.

Tool text is bounded inside PiAdapter before entering Host output. Truncation is represented explicitly by `HostToolOutput.truncated`; the size and buffering mechanism remain Adapter implementation details.

A successful Pi `edit` may additionally produce a `fileChange` only when `result.details.patch` is a syntactically valid, single-file Unified Patch with a usable path in its headers. The Adapter uses the structured `diff` parser and does not read Git, watch files, compare snapshots, or derive a change from Tool arguments. Failed Edit, Write, Bash, unknown Tool, absent Patch, and ambiguous multi-file Patch remain Tool-only.

### 4. Centralize Turn finalization in PiHarnessSession

An active Pi Turn tracks its optional Agent Message, active Tool Items, cancellation request, and one completion promise. Normal settlement closes remaining Items before the Turn. Cancellation marks the active Turn before issuing Abort so Tool-end events can receive cancelled outcomes. Pi's Abort response only acknowledges the request; `agent_settled` is still required before `turn.completed(cancelled)`.

If Abort is rejected, times out, the process exits, or stable cancellation cannot be proven, the Turn completes failed. `close()` shares the same cancellation/finalization path and only ends outputs after all exposed lifecycles terminate. Idempotent guards discard late native events.

### 5. Put the Codex UI projector in Protocol Core

A stateful per-Turn projector in `protocol-core` accepts Host Item lifecycle events and produces current Codex app-server notifications and the final Turn snapshot. It owns Codex-specific status names and shapes:

- Agent Message to `agentMessage` plus delta notifications.
- Command to `commandExecution` plus output deltas.
- Generic Tool to `dynamicToolCall`, with cumulative output in the final snapshot when no safe progress notification exists.
- File Change to `fileChange`, patch update, and in-memory `turn/diff/updated` aggregation.

The current Codex wire contract carries Command, Generic Tool, and File Change completion through standalone Item notifications; the final Turn snapshot contains Agent Message Items only. The current Renderer also appends `item/completed.aggregatedOutput` after an earlier Command output delta. Therefore a streamed Command completes with `aggregatedOutput: null`, while a Command that emitted no delta retains its final aggregate in `item/completed`; Tool Items are not repeated in `turn/completed`.

Host Runtime owns resource routing, JSON-RPC response gates, writer ordering, and Session composition. It does not inspect Pi Tool names, native Call IDs, result details, or Patch fields.

### 6. Route Desktop interruption by external resource ownership

For an active Pi-owned Turn, `turn/interrupt` becomes `execute({ type: "turn.cancel", turnId })`; an accepted command returns an empty app-server response. A per-Turn response gate prevents cancellation-triggered lifecycle notifications from overtaking that response. Unknown or Codex-owned Turn interruption continues to the official app-server unchanged.

## Risks / Trade-offs

- [Current Codex `dynamicToolCall` has no generic progress notification] -> Retain the latest cumulative output in the final Item snapshot; do not mislabel a generic Tool as MCP or Command solely to obtain progress UI.
- [Pi may emit malformed or late Tool events] -> Validate known events, correlate by Call ID, fault on broken lifecycle order, and ignore output after terminal finalization.
- [Abort response and Agent settlement can race] -> Track cancellation request state separately and make one finalizer authoritative for Item and Turn outcomes.
- [A native Patch can be present but ambiguous] -> Require a valid single-file Unified Patch and omit File Change when confidence is insufficient.
- [Host Runtime is already large] -> Move Codex Item/Turn projection into Protocol Core rather than adding more switch branches to the composition root.
- [Real Desktop shapes can drift] -> Test the current generated bindings and perform a controlled real Desktop/Pi Gate after hermetic checks.

## Migration Plan

1. Extend public unions and fake contract tests while preserving existing text callers.
2. Add Protocol Core projector and migrate current text projection without changing visible behavior.
3. Extend Pi private transport and PiAdapter Tool/Cancel mapping.
4. Add Host `turn/interrupt` routing and response ordering tests.
5. Run package tests, repository checks/build, then a controlled real Desktop/Pi Tool and Cancel Gate.

Rollback removes the new command/item variants, projector module, and Pi event mapping. No persisted data migration or user cleanup is required.

## Open Questions

- The exact quality of `dynamicToolCall` rendering and turn-level Diff rendering must be confirmed in the controlled Desktop Gate.
- Automatic Retry and large-context Compaction remain outside this slice unless they appear during the real Gate and invalidate the existing stable settlement rule.
