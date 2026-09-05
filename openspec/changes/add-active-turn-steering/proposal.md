## Why

Codex Desktop can submit `turn/steer` while a response is still running, but codexhost currently routes only Turn start and interruption for external Harness Threads. An external request can therefore reach the official backend with an external Thread ID, while a capable Harness has no public command through which it can accept the adjustment.

OpenCode's current Session prompt API can admit another user message while the Session is busy. Supporting that behavior requires more than forwarding a second prompt: the messages must remain one logical Host Turn, retries must not duplicate input, output must not overtake the Desktop response, and completion, cancellation, history, Fork, and rollback boundaries must remain exact.

## What Changes

- Add an optional `activeTurns.steer` Harness Session capability and a typed `turn.steer` command.
- Route Desktop `turn/steer` locally for an externally owned Thread, while preserving unchanged passthrough for official Codex Threads.
- Require the expected active Turn, text-only input, and optional bounded client message identity.
- Gate steer-triggered output behind the JSON-RPC response and deduplicate retries by client message identity.
- Implement OpenCode steering through its proven current prompt API, with serialized prompt admission and cancellation.
- Persist a recoverable grouping identity in OpenCode-compatible native message IDs so all root and steering message segments project as one Host Turn after resume.
- Recover at most once when an accepted steering message is durably persisted but an upstream busy-loop exit leaves it unanswered at stable idle.
- Keep steering disabled for Adapters without a proven native continuation path.

## Capabilities

### New Capabilities

- `harness-active-turn-steering`: capability negotiation, command semantics, Host routing, OpenCode admission, lifecycle convergence, and logical history grouping for active-Turn steering.

### Modified Capabilities

- `harness-adapter-history-fork-session`: a logical Host Turn may contain multiple native user/assistant segments created by accepted steering, while retaining one root Native Turn identity and one final Checkpoint.

## Impact

- `packages/shared-contracts`: optional Session capability.
- `packages/harness-adapter`: typed command/result and fake contract support.
- `packages/harness-broker`: schema-validated command transport, including provisional first-Turn continuation.
- `packages/host-runtime`: ownership routing, validation, idempotency, and response gating.
- `packages/adapters/opencode`: native admission, message grouping, completion/cancel races, and history boundaries.
- Other Adapters explicitly reject the new command and do not advertise the capability.
- No persisted Mapping Store schema, Renderer private binding, external service, or production dependency is added.
