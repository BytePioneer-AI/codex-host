## Why

The current Pi vertical slice projects only Agent Message text and cannot show the Tool activity or explicit cancellation required for real development tasks. Gate C has already established Pi's structured Tool, reliable Edit Patch, and Abort behavior, so the next change can extend the proven HarnessAdapter seam without exposing Pi RPC details to Host Runtime.

## What Changes

- Extend the UI-independent HarnessSession contract with Command Execution, Generic Tool, and reliable File Change Item lifecycles.
- Add explicit active-Turn cancellation with bounded native stop confirmation and one terminal Turn outcome.
- Add shared fake-contract coverage for Tool ordering, update semantics, failure, cancellation, and terminal-event races.
- Extend the Pi private transport and PiAdapter to map structured Pi Tool events, reliable successful Edit patches, and Abort into Host semantics.
- Add a reusable Codex UI projector for Agent Message, Tool, File Change, and Turn lifecycle output so Host Runtime does not interpret Pi-native events.
- Preserve Codex-owned request passthrough, lazy Pi startup, same-Session reuse, and response-before-notification ordering.
- Keep Question, Approval, history, resume, fork, Mapping Store, Claude Code product routing, and Renderer lifecycle integration out of this slice.

## Capabilities

### New Capabilities

- `harness-adapter-tool-cancel-session`: Defines Host-semantic Tool and File Change Item lifecycles, explicit Turn cancellation, Pi native mapping, and Codex UI projection requirements.

### Modified Capabilities

None.

## Impact

- `packages/harness-adapter`: public discriminated unions, fake implementation, and contract tests.
- `packages/adapters/pi`: private RPC transport events, Abort handling, Tool/Patch mapper, lifecycle convergence, and tests.
- `packages/protocol-core`: reusable Codex UI projection for Host Items and Turn events.
- `packages/host-runtime`: resource-owned cancel routing and projector composition without Pi RPC knowledge.
- No new runtime language, external service, persisted format, or production dependency is introduced.
