## Context

`AppServerHost` currently imports `PiRpcSession`, invokes `runTextTurn()`, and translates Pi callbacks directly into Codex app-server notifications. The path is proven in a real Desktop, but the Host owns Pi transport knowledge and incomplete Item/Turn failure cleanup. The target HarnessAdapter design is broader than this change; implementing every catalog, interaction, history, and fork type before a second production caller would create a shallow placeholder interface.

The existing Renderer route and Host transport token remain the Thread-to-Harness selection mechanism. This change starts at the in-process Host-to-Harness seam after routing has selected Pi.

## Goals / Non-Goals

**Goals:**

- Introduce a small, executable Adapter/Session interface for the current text path.
- Make Pi transport and lifecycle behavior local to `@codexhost/adapter-pi`.
- Give accepted Turns and started Items complete, ordered, unique terminal events.
- Preserve lazy first-Turn Pi startup, same-Thread Session reuse, Codex projection, and bounded shutdown.
- Make the same interface usable by a fake in Host tests and later concrete Adapters.

**Non-Goals:**

- `inspect()`, Model/Thinking/Command catalogs, Tool, Question, Approval, explicit cancel, steer, image input, usage, history Snapshot, resume, fork, Mapping Store, Claude Code, or ACP.
- Productizing the diagnostic Renderer injection lifecycle.
- Changing the Pi transport token or Codex app-server wire shapes.

## Decisions

### 1. Implement a coherent text subset, not the full target interface

The first public interface contains:

```text
HarnessAdapter.open(create)
HarnessAdapter.close()
HarnessSession.initialState
HarnessSession.outputs
HarnessSession.execute(turn.start)
HarnessSession.close()
```

The command and output types are discriminated unions so later changes can add operations without exposing Pi-native methods. Methods that have no implementation or caller are omitted rather than added as `unsupported` placeholders.

Alternative: publish the complete design interface immediately. Rejected because mandatory Snapshot, catalog, resume, and fork methods would be empty shells and make the module shallow.

Alternative: expose `runTextTurn(text, callback)`. Rejected because it preserves the current transport-shaped seam and cannot safely carry Session faults, Item terminal state, Tool updates, or Interactions.

### 2. Keep `PiRpcSession` private behind `PiAdapter`

`PiAdapter.open(create)` returns a lazy `PiHarnessSession` without spawning Pi. The first accepted `turn.start` starts `PiRpcSession`, publishes the available `NativeSessionRef` through `session.state.changed`, and then starts the Turn. This reconciles the target design with the proven prewarm rule: unused native `thread/start` requests do not create Pi processes.

`PiRpcSession` remains responsible for LF JSONL framing, request correlation, Pi process startup, text delta parsing, timeout, and process-tree shutdown. `PiHarnessSession` owns Host IDs, ordered outputs, active-Turn state, normalized errors, and exact terminal events.

### 3. Use one buffered, single-consumer Session output stream

A Session exposes `AsyncIterable<HarnessOutput>`. The Pi implementation buffers outputs emitted before the consumer's first read and rejects a second consumer. The first slice does not add a persistent sequence or Timeline.

The minimum event set is:

```text
session.state.changed
turn.started
item.started
item.updated(text.append)
item.completed
turn.completed
session.faulted
```

A failed accepted Turn completes its started Agent Message Item before `turn.completed(failed)`. A process/protocol fault completes the active Turn first, then emits `session.faulted`, then ends the stream.

### 4. Separate acceptance from completion

`execute(turn.start)` validates Session state, input, and single-Turn exclusivity, then ensures the Pi transport is started. Startup failure occurs before acceptance and returns `HarnessResult.error` without Turn events. After acceptance, the Session queues `turn.started`, starts the Agent Message Item, submits the Pi prompt, and returns `TurnStartAccepted`. Later success or failure is represented only by outputs.

The Host creates `HostTurnId`; the Adapter creates `HostItemId`. The first slice does not claim stable historical Item identity or emit `NativeTurnRef`.

### 5. Inject an Adapter into Host Runtime and gate Codex projection on the command response

`AppServerHost` may construct the default `PiAdapter` at the composition root, but it no longer imports or invokes `PiRpcSession`. A test can inject a fake `HarnessAdapter`.

The Host begins consuming Session outputs immediately after `open(create)`. Because Adapter outputs may be queued before `execute()` resolves, the Host holds projected events for that Turn until it has written the Codex `turn/start` response. This preserves the proven response-before-notification order without weakening the Adapter interface.

The Host continues to maintain the current process-local minimal `thread/read` projection. Native history and stable identity move in a later Snapshot change.

### 6. Normalize errors at the Adapter seam

The text slice uses the design document's `HarnessResult` and narrowed `HarnessError` shape. Pi startup, validation, native rejection, protocol failure, process exit, timeout, and internal errors are mapped without exposing Prompt text or raw frames. Unknown failures use `nativeFailure` or `internalError` rather than reporting success.

### 7. Test through the same interface used by Host

A minimal fake Adapter implements the public interface and supports deterministic queued outputs. Contract tests cover lazy open, complete success/failure lifecycle, no events before rejected acceptance, one active Turn, Session fault ordering, single-consumer outputs, idempotent close, and same-Session multi-Turn reuse. Pi private tests inject a fake RPC transport; Host tests inject the fake Adapter.

## Risks / Trade-offs

- [The partial interface will grow] -> Add only discriminated union members and methods justified by a concrete subsequent vertical slice; do not promise compatibility before the MVP contract stabilizes.
- [The output queue is process-memory only] -> Keep it single-consumer and lifecycle-correct now; add measured bounded backpressure before high-volume Tool output.
- [Pi process faults can race Turn Promise rejection] -> Centralize idempotent finalization in `PiHarnessSession` and test Turn terminal state before Session fault.
- [Host projection can observe outputs before the RPC response] -> Use a per-Turn projection gate owned by Host.
- [Process-local `thread/read` is not Native history] -> Keep the limitation explicit and defer persistence claims until `readSnapshot()` and Gate D.
