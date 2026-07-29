## Why

Selecting the Pi Agent currently leaves the Composer backed by the internal `codexhost/pi-native` routing token and provides no way to inspect or select the actual Models available to Pi. Pi RPC capability evidence already proves native catalog, selection, and state-readback behavior, so codexhost can now expose the PRD's Agent-separated Model experience without injecting Pi Models into the blocked Codex native picker.

The development baseline schedules the complete Model Catalog after stable Snapshot and Native Ref work. This change advances only the independent current-process slice for new drafts and already-open Pi Threads; it does not add cross-restart recovery, complete `MVP-06`, or introduce Mapping Store dependencies.

## What Changes

- Add browser-safe, runtime-validated Model Catalog and narrow Renderer/Host control contracts without exposing Pi RPC objects, Provider configuration, credentials, prices, base URLs, or local paths.
- Extend `HarnessAdapter` with side-effect-free inspection, normalized Model references, effective Model state, Model-selection capability, and an Idle-only `model.select` command whose actual result is published through ordered Session state.
- Map Pi's native `get_available_models`, `set_model`, and `get_state` behavior inside `PiAdapter`, using the native `(provider, model id)` pair as an Adapter-private identity and confirming the effective Model after every write.
- Route draft inspection and current-process Pi Thread Model selection through explicit codexhost-owned Host operations while preserving transparent behavior for official Codex requests.
- Carry a selected Pi Model through the existing Composer-scoped optimistic Model state so a new Pi Thread applies that exact selection before its first Agent Loop; keep `codexhost/pi-native` as an internal routing token rather than a user-visible Model.
- Add a Pi-specific Model selector beside the existing Agent control for the supported Desktop build, with loading, empty, stale-request, error, pending-selection, Composer replacement, and fail-closed states.
- Add focused contract, Adapter, Host, Renderer, privacy, and real Desktop/Pi validation. Thinking Catalog and Thinking selection remain outside this change.

## Capabilities

### New Capabilities

- `harness-model-catalog`: Harness-level Model discovery, stable Model references, effective Session state, Idle-only native Model selection, and current-process Host/Renderer projection.

### Modified Capabilities

- `shared-runtime-contracts`: Add browser-safe Model Catalog and narrow control-boundary schemas consumable by Renderer, Host, and HarnessAdapter packages.
- `versioned-renderer-agent-routing`: Keep Agent and Model controls separate while binding the selected Pi Model to the same logical Composer and supported native create state.
- `pi-model-routed-vertical-slice`: Extend Pi's internal transport carrier and current-process Thread routing to apply an explicitly selected Pi Model without changing Harness ownership or entering the Codex Agent Loop.

## Impact

- Affected packages: `shared-contracts`, `harness-adapter`, `adapters/pi`, `host-runtime`, `renderer-extension`, and the version-locked Desktop control/probe assembly needed to expose a narrow request bridge.
- Affected APIs: `HarnessAdapter.inspect`, create-session configuration, `HarnessSessionState`, `HarnessSessionCapabilities`, `HostCommand`, Pi private RPC transport methods, and codexhost-owned app-server control methods.
- Codex-owned app-server traffic remains transparent. No Codex config or native catalog files are modified, no Pi or Codex package version gate is introduced, and no reference project becomes a runtime dependency.
- Persisted Mapping Store formats, Native Session recovery, Thread history, Fork/Detach, Thinking selection, unified Provider configuration, and Host Routed Mode are unchanged.
