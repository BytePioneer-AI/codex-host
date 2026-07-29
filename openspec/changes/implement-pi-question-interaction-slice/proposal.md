## Why

Pi in RPC mode can emit structured blocking `extension_ui_request` callbacks from user-installed Extensions, but the production Adapter and Host currently cannot surface them in Codex Desktop or return the user's answer. This leaves an original Pi Extension capability blocked. Pi itself has no default model-facing Question Tool, so codexhost must bridge emitted requests without adding such a Tool.

## What Changes

- Extend the UI-independent `HarnessAdapter` Session contract with Question interactions, `interaction.respond`, ordered interaction closure, and complete cancel/fault/close convergence.
- Map Pi `select`, `confirm`, `input`, and `editor` Extension UI requests into Host Question semantics without exposing Pi request IDs or RPC payloads outside the Pi Adapter.
- Project pending Host Questions as Codex app-server `item/tool/requestUserInput` server requests and correlate Desktop responses back to the owning Pi Session and native callback.
- Preserve Pi's native capability set: do not register a codexhost Question Tool or pass a codexhost Extension at process startup; bridge only Interaction requests that Pi actually emits.
- Add contract, projector, Host routing, Pi transport, and real Desktop/Pi tests for normal response, early Question, cancellation, timeout, duplicate/unknown response, process exit, and same-Session continuation.
- Keep Pi questions distinct from Approval. Do not add Approval, permission policy, another Harness, Transcript persistence, Snapshot/Resume, Mapping Store, Fork, or custom Renderer dialog UI.

## Capabilities

### New Capabilities

- `harness-adapter-question-interaction-session`: UI-independent Question lifecycle, response command, ordered closure, and Codex native user-input projection semantics.

### Modified Capabilities

- `pi-model-routed-vertical-slice`: Pi-owned Threads now support structured blocking Questions through the existing routed Session instead of treating Question as an unsupported event.

## Impact

- Changes public TypeScript contracts and shared contract tests in `packages/harness-adapter`.
- Extends Codex projection in `packages/protocol-core` and bidirectional server-request routing in `packages/host-runtime`.
- Extends Pi RPC validation and native callback mapping in `packages/adapters/pi`.
- Keeps Pi's default and user-configured Tool set unchanged while supporting native Extension UI callbacks without parsing Pi TUI output.
- Uses the current Codex app-server experimental `item/tool/requestUserInput` shape and therefore requires a versioned real Desktop compatibility Gate before claiming completion.
