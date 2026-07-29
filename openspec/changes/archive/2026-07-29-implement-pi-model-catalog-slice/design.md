## Context

The supported Renderer build already maintains Composer-scoped Agent state and writes `codexhost/pi-native` into the unique optimistic Model atom. Host Runtime decodes that value only as a Pi Harness route, opens a lazy `HarnessSession`, and routes later Turns by Thread ownership. The actual Pi Model remains whatever Pi Native Mode currently selects.

Gate C proved that Pi RPC exposes `get_available_models`, `set_model`, and `get_state`, and that two native Models can be selected between Agent runs and confirmed by state readback. The target HarnessAdapter design already defines side-effect-free `inspect()`, `HarnessModelRef`, `effectiveModel`, structural Model-selection capability, and an Idle-only `model.select` command. Production packages currently implement none of those interfaces.

The Codex native Model picker cannot be extended with Pi entries in the supported Desktop build. The existing official Model setter is also unsuitable because it persists the user's Codex default. The Model UI must therefore be codexhost-owned and must keep Agent, Model, Provider, Account, and Billing Source semantics separate.

The complete MVP sequencing puts Model Catalog after Snapshot/Resume and Mapping Store. This change intentionally implements only current-process discovery and selection. It does not recover effective Model state after Host or Renderer restart and does not claim the complete `MVP-06` acceptance criterion.

## Goals / Non-Goals

**Goals:**

- Display the Models returned by the user's actual Pi Native Mode when a Composer selects Pi.
- Keep Pi-native RPC structures private to `PiAdapter` and expose only browser-safe, UI-neutral Model contracts.
- Apply a draft Model to the exact Pi Thread created by that Composer before its first Agent Loop.
- Allow an already-started Pi Session to switch Models only while Idle and display the state confirmed by Pi.
- Preserve lazy Pi startup, one-Harness-per-Thread ownership, Codex transparency, bounded process cleanup, and fail-closed Renderer behavior.
- Cover malformed catalog data, duplicate native identities, stale Renderer requests, selection failure, write/readback mismatch, and Turn/configuration races.

**Non-Goals:**

- Thinking Catalog or Thinking selection.
- Cross-restart Model recovery, Snapshot/Resume, Mapping Store, Fork, Detach, or complete `MVP-06` closure.
- Provider, authentication, billing, price, base URL, or local-path display and configuration.
- Codex native picker injection, Codex catalog/cache mutation, official Model setter use, ASAR modification, or a generic native request escape hatch.
- A persisted Model Catalog or a dependency on `reference/opencodex`.

## Decisions

### 1. Publish a narrow Model contract and keep native identity in PiAdapter

`shared-contracts` will own browser-safe runtime schemas for `HarnessModelRef`, `HarnessModel`, `HarnessModelCatalog`, inspection results, effective Model state, and the two fixed Renderer/Host control requests. `harness-adapter` will consume and re-export those types rather than define a second incompatible catalog shape.

A Model Ref is opaque outside its owning Adapter. Pi's real identity is the exact `(provider, model id)` pair, not `model id` alone. `PiAdapter` will encode the pair into a deterministic, URL-safe `pi-model-v1.<base64url>` reference and will be the only production module that decodes it. Host and Renderer can compare, store in current-process state, validate, and return the Ref, but cannot infer Provider semantics from it.

Catalog entries expose only `ref` and a display `label`. Pi base URLs, prices, authentication metadata, local paths, and unrecognized native fields are discarded at first formal consumption. Exact duplicate pairs are removed and entries are sorted deterministically by label and Ref. Conflicting or malformed required native fields fail inspection rather than producing guessed entries.

Alternative: expose `{provider, modelId}` publicly. Rejected because Host and Renderer would become coupled to Pi's identity structure and could begin treating Provider as a generic account or route contract.

Alternative: normalize identity as `provider/model` with separator replacement. Rejected because both components can contain separators and exact round-trip identity is required.

### 2. Implement inspect with an ephemeral Pi RPC transport

`HarnessAdapter.inspect({cwd, refresh})` starts an ephemeral Pi RPC process, reads current state and available Models, normalizes the result, and closes the process before resolving on both success and failure. It does not call `open(create)`, submit a Prompt, create a durable Native Session, or modify Pi configuration.

The first slice performs direct inspection per Renderer request. Request generation in Renderer prevents an older response from overwriting a newer Agent/Composer state. A short in-memory cache and in-flight request coalescing may be added inside `PiAdapter` only if measurement requires it; no persisted cache or silent stale success is introduced in this change.

Alternative: maintain a static Provider registry or write Codex `model_catalog_json`. Rejected because Pi Native RPC is the authority and Codex catalog mutation would change user configuration and misrepresent Pi Models as Codex Models.

### 3. Extend HarnessSession with structural capability, effective state, and one Idle command

The public Session additions are:

```ts
interface HarnessSessionCapabilities {
  configuration: { selectModel: boolean };
}

interface HarnessSessionState {
  nativeRef?: NativeSessionRef;
  effectiveModel?: HarnessModelRef;
}

type HostCommand =
  | ExistingTurnCommands
  | { type: "model.select"; model: HarnessModelRef };
```

`CreateSessionInput` accepts an optional Model Ref. A Pi create remains lazy: `open(create)` stores the requested Ref without starting Pi. On the first accepted Turn, Pi starts, applies the requested native Model if needed, calls `get_state`, and emits one complete `session.state.changed` before `turn.started`.

For a started Session, `model.select` is accepted only while the Session is open, no Turn is being accepted or active, and no other configuration command is pending. PiAdapter calls `set_model`, immediately calls `get_state`, and compares both native identity components. It emits the complete confirmed state before resolving `{completed: true}`. A definite native rejection returns an error without changing Host state; an uncertain write followed by unreadable state faults the Session.

Alternative: return the requested Model in the command result. Rejected because command completion and effective Session state would become competing truth channels.

### 4. Use two fixed codexhost Host methods, never a generic bridge

The version-locked Renderer Adapter will recover exactly one active request manager using the already-reviewed Fiber/signature checks and expose only typed closures for:

```text
codexhost/harness/inspect
codexhost/thread/model/select
```

The first method accepts Pi plus optional cwd/refresh and returns a runtime-validated inspection. The second accepts a current-process Pi Thread ID and Model Ref, executes `model.select`, waits until the ordered state event has been consumed, and returns that observed effective state. Neither method is forwarded to the official app-server. Unknown or Codex-owned resource references receive an explicit codexhost error.

No generic `sendRequest`, manager object, Electron API, Pi RPC method, or arbitrary payload is exposed through the Renderer public API. If request-manager ownership or signature is ambiguous, Pi Model controls remain unavailable while existing Agent routing continues to follow its own fail-closed rules.

Alternative: reuse the official Model setter. Rejected because it is debounced, persists the Codex default, and does not target a Pi Native Session.

Alternative: a process-level `nextModel`. Rejected because concurrent Composers and prewarm requests could consume another draft's selection.

### 5. Bind draft Model selection through the same optimistic Model carrier

The generic carrier remains:

```text
codexhost/pi-native
```

A selected Pi Model uses a bounded internal form:

```text
codexhost/pi-native@<opaque HarnessModelRef.id>
```

`protocol-core` is the only non-Renderer module that recognizes this carrier format. It returns a Pi route plus an opaque optional Model Ref; it never decodes the Pi-native provider/model pair. The token remains internal and is not displayed as a Model.

For a draft, the Renderer stores the selected Ref in the logical Composer state, writes the selected carrier to the same unique optimistic Model atom, then clears stale official prewarms. `thread/start` therefore carries Agent and Model in one request-local state. Host opens the Pi Session with that Model Ref. Generic `codexhost/pi-native` remains valid and means "use Pi's current Native Mode Model".

For an existing Pi Thread, the Renderer validates the supported conversation target shape to obtain the current Thread ID, calls the fixed selection method, and updates the optimistic atom only with the confirmed effective Ref. The same selected carrier can appear in the next `turn/start.model`; Host treats it as an idempotent assertion and applies it before starting the Turn if the current effective state differs.

Alternative: send a selection message and correlate it to a future `thread/start` by time or order. Rejected because it recreates the unsafe `nextHarness` class of race.

### 6. Add a separate Pi Model control and keep async state Composer-scoped

The existing Agent segmented control remains unchanged in meaning. When Pi is selected, a separate native HTML select/menu is mounted beside it. It displays normalized labels and never displays the transport token. Codex keeps its official Model UI behavior; codexhost does not rewrite Codex catalogs.

Each logical Composer owns its Pi Model Ref and async request generation. Draft-to-conversation replacement and same-process conversation revisit transfer the selected Ref with existing Composer state. A new default Composer starts without inherited Pi Model state. Agent changes, replacement, refresh, and disposal invalidate prior generations so late catalog or selection responses cannot overwrite newer state.

The control has stable loading, ready, empty, selecting, and error states. Draft submission is blocked only while the Pi catalog/selection needed for that draft is unresolved. Existing-Thread selection remains enabled between Turns; Host is authoritative and returns `sessionBusy` if a Turn is active. A failed selection keeps the prior confirmed Ref visible.

### 7. Keep Host state observation ordered

Each Pi Thread stores the latest `HarnessSessionState` observed from the Session output stream and a monotonically increasing in-memory state revision. Before issuing `model.select`, Host registers a waiter for the next revision. A successful command response is written only after the corresponding `session.state.changed` has updated the Thread state. This makes the Renderer response a projection of the ordered state event, not an inference from command success.

For first-Turn selection, the existing Turn response gate remains authoritative: the Host receives and stores the state event before projecting Turn lifecycle events, and the Pi Agent Loop starts only after native readback confirms the requested Model.

### 8. Validate in layers and preserve the sequencing boundary

Hermetic checks cover Shared Contracts, Fake HarnessAdapter, Pi RPC parsing, PiAdapter state ordering, Host custom routing, transport decoding, Composer state, stale requests, and DOM control behavior. A controlled real Gate then proves the supported Desktop request manager carries both custom methods, the real Pi list is displayed, a draft-selected Model reaches the first Pi Turn, an Idle switch changes the same Native Session, a busy switch is rejected, and Codex requests remain transparent.

The Gate records only counts, state equality, opaque Ref equality, Harness classification, and process evidence. It does not record raw Model catalogs, Provider configuration, Prompt text, full Thread IDs, credentials, or native paths.

## Risks / Trade-offs

- [The supported Desktop request manager rejects unknown custom methods] -> Keep the control disabled and stop for a real Bridge Gate; do not fall back to a generic IPC or time-correlated selection.
- [The conversation target does not expose an unambiguous Thread ID] -> Fail closed for immediate existing-Thread selection; the request-local create carrier remains usable, but the change cannot claim the existing-Thread scenario until the Gate passes.
- [Pi accepts `set_model` but the selected route is not callable] -> Confirm structural state immediately, then let the next native Turn report the real authentication/route error; never report Turn success from selection alone.
- [The catalog changes after inspection] -> PiAdapter revalidates the Ref at selection time and returns the native error or confirmed replacement state; Renderer keeps the prior confirmed value.
- [Opaque Ref contains reversible native identity] -> Treat it as local control data, never log it, bound its length, and expose no configuration metadata; stronger secrecy is not claimed because Model labels are intentionally user-visible.
- [Private Renderer structures drift] -> Retain asset/signature checks, exact ownership, request generations, and fail-closed controls; a new Desktop build requires a fresh controlled Gate.
- [This slice precedes Snapshot/Mapping Store] -> Mark cross-restart state as unsupported and do not update the complete MVP status.

## Migration Plan

1. Add and validate the OpenSpec deltas and browser-safe schemas.
2. Extend HarnessAdapter/Fake contracts and Pi private RPC mapping.
3. Add opaque transport carrier decoding and Host inspect/select routing.
4. Add Composer Model state and Pi Model control behind the current Renderer adapter checks.
5. Run focused package tests, `npm run check`, `npm run build`, strict OpenSpec validation, and `git diff --check`.
6. Run the controlled Desktop/Pi Gate with operator assistance because it can start the user's Pi Native Mode and may access a configured model/network.

Rollback removes the selected carrier suffix, fixed custom methods, Model UI, and new Adapter contract members. Generic `codexhost/pi-native`, existing Pi Threads, and all persisted formats remain compatible; no user configuration or cache cleanup is required.

## Open Questions

- The installed Desktop build must prove that direct calls through the uniquely owned request manager deliver the two fixed codexhost methods and return their responses without additional runtime method allowlisting.
- The installed Desktop build must prove the validated conversation Model target component equals the Host Thread ID used by app-server requests. Until then, immediate existing-Thread selection remains a Gate-dependent implementation path.
