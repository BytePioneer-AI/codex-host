## Why

The current Host Runtime calls `PiRpcSession` directly and owns Pi-specific text lifecycle projection. This proved the vertical slice, but adding Tool, Interaction, cancellation, history, or another Harness on that path would duplicate protocol and lifecycle logic inside the Host.

## What Changes

- Introduce the smallest executable `HarnessAdapter` and `HarnessSession` contract needed by the proven text path.
- Add typed create-session, text Turn command, ordered output, Agent Message Item, Turn outcome, Session state, and normalized error types.
- Implement `PiAdapter` and a Pi-backed `HarnessSession` over the existing private `PiRpcSession` transport.
- Move Pi text lifecycle ownership behind the Adapter interface; the Host consumes Host-semantic outputs and no longer imports `PiRpcSession`.
- Add a reusable contract test suite and a minimal fake Adapter for Host Runtime tests.
- Preserve Pi first-Turn lazy process startup, same-Thread Session reuse, text streaming, Codex transparency, and bounded shutdown.
- Defer inspect/catalog, Tool, Interaction, explicit cancel, history, resume, fork, and persistence capabilities to later changes.

## Capabilities

### New Capabilities

- `harness-adapter-text-session`: Minimal UI-independent Adapter and Session contract for lazy create, text Turn execution, ordered lifecycle outputs, normalized failure, and bounded close.

### Modified Capabilities

## Impact

- `packages/harness-adapter`: public text-session types, contract helpers, and test fake.
- `packages/adapters/pi`: concrete `PiAdapter`/Session implementation over `PiRpcSession`.
- `packages/host-runtime`: Adapter injection, Session ownership, and Host-output-to-Codex projection.
- Existing Pi transport routing and Renderer Agent selection remain behaviorally unchanged.
