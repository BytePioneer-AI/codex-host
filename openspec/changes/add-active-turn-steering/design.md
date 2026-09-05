## Context

The installed Codex app-server contract exposes `turn/steer` with `threadId`, `expectedTurnId`, `input`, and an optional `clientUserMessageId`. codexhost currently knows whether a Thread belongs to an external Harness, but its public `HarnessSession.execute()` union has no steering command and Host routing does not intercept this method.

OpenCode's current `session.promptAsync()` accepts a caller-supplied native message ID and can admit another user prompt while the same Session is busy. A controlled native probe confirmed both important execution shapes: an adjustment submitted during Tool execution changes the continuation, while an adjustment submitted during an indivisible model response is processed as the next assistant segment in the same native execution chain. The newer durable V2 delivery path is not used because an admitted prompt did not yet prove equivalent assistant completion in the controlled Gate.

One Desktop Turn must nevertheless remain one Host Turn. OpenCode persists each accepted adjustment as another user message, so ordinary one-user-message-per-Turn projection would otherwise split history and make edit, Fork, and rollback target the wrong boundary.

## Goals / Non-Goals

**Goals:**

- Accept Desktop steering only for the exact active external Turn.
- Negotiate support explicitly and fail closed for every unproven Adapter.
- Preserve response-before-notification ordering and exactly-once admission for identified retries.
- Serialize multiple steering admissions and cancellation.
- Prevent an idle/completion race from closing the Turn while steering is being admitted.
- Reconstruct one logical Host Turn, root Native Turn identity, and final Checkpoint after resume.
- Preserve reliable per-message File Change projection and logical Fork/rollback boundaries.

**Non-Goals:**

- Interrupt an indivisible provider response mid-token or erase already emitted output.
- Queue a new Host Turn behind the active Turn.
- Enable OpenCode V2 durable delivery, replay, or crash-continuation ownership.
- Claim steering for Claude Code, Pi, OMP, Grok, DeepSeek Harness, or Antigravity without a separate native proof.
- Add image/file steering, Renderer DOM injection, or a Mapping Store migration.

## Decisions

### 1. Negotiate one narrow public capability

`HarnessSessionCapabilities.activeTurns.steer` is optional; omission means unsupported. The new `TurnSteerCommand` carries the active Host `turnId`, ordered text inputs, and an optional client user-message ID. Success acknowledges admission to the existing Turn and never starts a second Host lifecycle.

The public seam describes the behavior rather than an OpenCode endpoint. Every existing Adapter handles the command explicitly, and only OpenCode advertises support.

### 2. Route by Thread ownership before official passthrough

Host resolves `turn/steer.threadId` exactly like Turn start and interruption. Official or unknown ownership preserves the original frame unchanged. External ownership is terminal for routing: malformed input, unsupported capability, stale Turn ID, Adapter rejection, and native failure all return local typed JSON-RPC errors and never leak the external identity to official Codex.

Host installs a per-request projection gate before calling the Adapter. Output emitted synchronously by admission waits until the steering response has been written. Requests with the same `clientUserMessageId` and identical input share one Adapter result; reusing that ID with different input is rejected.

### 3. Use the proven current OpenCode execution path

OpenCode steering calls the same current `promptAsync()` transport used for root prompts. Admissions are chained in invocation order. The root and each steering input receive caller-generated OpenCode-compatible sortable `msg_` IDs; this avoids ambiguous event correlation and preserves the native timestamp/ID ordering and tie-break behavior.

The Adapter advertises this capability only when the native health version exactly matches the independently verified `1.18.25` contract. Other versions keep ordinary OpenCode-generated root IDs and do not expose steering; a version change therefore cannot silently opt into the custom ID or grouping path. A timed-out admission aborts its client request, and any admission error is reconciled against the transcript by the caller-supplied message ID before it is reported as failed.

The 14-character opaque suffix contains a namespace marker, a per-Turn token derived from a random seed, and a monotonically increasing steering sequence. The prefix retains OpenCode's timestamp/counter ordering. This representation is transcript-local, contains no user content or secret, requires no extra native metadata write, and survives Session resume and transcript Fork.

The Adapter also keeps an in-memory map from `clientUserMessageId` to input and result. This protects callers that use the Harness or broker seam directly; Host performs the same check at its protocol boundary.

### 4. Make lifecycle changes invalidate an in-flight completion scan

An active OpenCode Turn tracks all owned native user IDs, pending steering admissions, and a lifecycle version. Idle reconciliation captures the version before reading status, transcript, and per-message Diffs, then checks it both before and after asynchronous projection work. Any new steer or cancellation invalidates that scan and schedules another reconciliation.

Completion requires:

- no pending steering admission;
- every admitted native user message present in the transcript;
- a terminal assistant parented by the latest admitted native user message;
- the lifecycle version unchanged through the final completion check.

Earlier assistant segments and each reliable per-user Diff remain Items on the same Host Turn. The Turn's `NativeTurnRef` uses the root user message; its Checkpoint uses the final assistant message.

An Assistant terminal observed while the Session remains busy may be an intermediate tool-call segment and does not close steering. Once the latest owned user has a terminal Assistant, its subsequent idle boundary has been observed, and no admission or Interaction is pending, a new steering request is too late and is rejected. An identified retry is still resolved from the idempotency map before this state check.

An upstream run-loop race can persist a steering message immediately before the previous run exits without starting another run. Only after a successfully admitted steering message is visible, a native idle boundary remains stable through a short 50 ms grace check, no Assistant exists for the latest user, and no Interaction is pending does the Adapter reserve one namespaced recovery position. The final preflight captures a lifecycle epoch and rechecks status, transcript, cancellation, fault, Interactions, and whether a newer steer superseded that position; resumed busy state, any intervening User or owned Assistant, and even an Interaction that opens and closes before the reads settle invalidate the epoch. Any failed precondition discards the reservation without a native write. An unanswered root prompt or failed steering admission never triggers recovery. Recovery is admitted at most once, is hidden from Host user input only while it remains in its intact namespaced group after resume, and still participates in ownership, Diff, final-Checkpoint, cancellation, and rollback boundaries. Failure to admit or continue after that recovery terminates the Turn as a native failure instead of waiting forever.

An unrecoverable transport stream fault uses the same convergence gate. It synchronously closes new admission, waits for the current steering chain, and retains every identity that entered native admission even if a failed response caused it to leave the normal ownership list. After aborting native execution once, bounded authoritative transcript reads restore any late-persisted identity before the Adapter reconciles per-segment Diffs and publishes the failed Turn with its root Native Turn identity. Fault finalization, Session output termination, Transport teardown, and any concurrent `close()` share one promise, so a fulfilled close can never race ahead of later output.

### 5. Serialize cancellation after already-started admission

Cancellation marks the Turn synchronously so no later steer can enter. It then waits for the current admission chain: an admission already inside the native request may settle, while queued admissions observe cancellation and fail without reaching the transport. Only then does the Adapter call native abort. Repeated cancellation shares one promise and cannot issue duplicate aborts.

Retries carrying an already-recorded client identity are resolved before cancellation or terminal-state rejection: identical input observes the original result, while conflicting input remains `invalidRequest` without a native write.

Session close uses the same ordering principle before aborting and fencing the managed native process.

### 6. Group native transcript segments at the Adapter history boundary

History recognizes only a root sequence followed immediately by increasing sequences with the same per-Turn token. Ordinary native IDs and interrupted groups remain valid standalone Turns. A grouped snapshot contains all ordered user texts except its internal recovery instruction and all assistant Items, uses the root user ID as its Native Turn key, and uses the last assistant terminal as outcome and Checkpoint. A recovery-shaped ID outside an intact root-led group is ordinary user input and remains visible.

Fork accepts only the final assistant Checkpoint of a logical group and counts logical Host Turns rather than native user messages. Last-Turn rollback starts at the group's root user message, removing the entire steered Turn. Each native user segment retains independent Diff retrieval so steering cannot hide later file changes.

## Risks / Trade-offs

- **Native ID format drift:** generation is isolated in one module, constrained to the current OpenCode-compatible six-byte timestamp/counter prefix and 14-character Base62 suffix, and covered by fixed-vector, transport, plus grouping tests. A future incompatible OpenCode contract must disable the capability until revalidated.
- **Busy-loop exit races with admission:** stable-idle reconciliation performs one bounded, namespaced recovery admission only after the original user message is durably visible and has no Assistant; the recovery input is omitted from Host history.
- **Admission response is ambiguous:** the SDK request is aborted on timeout and the Adapter checks the generated message ID in the authoritative transcript before deciding that admission failed.
- **An adjustment arrives after native completion:** once the latest terminal is followed by idle, Adapter active-state validation rejects it; busy tool-call segments remain steerable and Host never creates a second hidden Turn.
- **Duplicate client retries:** Host and Adapter both compare stable input keys and reuse the first result.
- **Completion races with slow Diff reads:** the second lifecycle-version check prevents terminal publication after a steer has entered.
- **Cancel races with prompt admission:** cancellation closes the queue synchronously and aborts only after the admitted request settles.
- **Native messages from another client:** grouping requires contiguous, namespaced IDs and live projection accepts only assistant parents owned by this Turn.
- **V2 looks more purpose-built:** it remains disabled until its full assistant lifecycle and parity are proven, rather than selecting an endpoint by name alone.

## Migration Plan

1. Add the optional capability and typed command without changing existing capability payloads.
2. Extend the broker and explicit unsupported Adapter branches.
3. Add external Host routing, duplicate suppression, and response gates.
4. Add OpenCode admission, lifecycle invalidation, cancellation serialization, and history grouping.
5. Run focused contract, broker, Host, transport, Adapter, history, format, lint, and type checks.
6. Keep the feature unadvertised for other Harnesses until each has an independent native Gate.

Rollback removes the optional command/capability and OpenCode grouping logic. Existing OpenCode messages remain ordinary valid native messages and require no data migration.
