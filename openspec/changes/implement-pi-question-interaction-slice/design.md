## Context

The current production `HarnessSession.outputs` stream carries only Host events, and `execute()` accepts only `turn.start` and `turn.cancel`. Pi RPC already has a structured Extension UI sub-protocol: `select`, `confirm`, `input`, and `editor` emit blocking `extension_ui_request` records and resume only after the matching `extension_ui_response`, native timeout, or abort. Gate C proved normal response, early preflight requests, timeout, cancellation, unknown/duplicate IDs, process exit, and same-Session continuation.

The current Codex app-server types expose the experimental server request `item/tool/requestUserInput`. Desktop returns answers keyed by Question ID. The request requires `threadId`, `turnId`, `itemId`, `questions`, and optional auto-resolution duration. The Host currently forwards all official server requests and has no registry for Host-owned request IDs or responses.

Pi intentionally has no built-in permission popup or question tool. User Extensions can call `ctx.ui`, while model-initiated questions require a trusted Extension tool. CLI `--extension/-e` explicitly loads a codexhost-owned Extension without relying on project trust; ordinary user/global/project Extension discovery remains a separate native-mode concern.

## Goals / Non-Goals

**Goals:**

- Implement reusable, UI-independent Question semantics in `HarnessAdapter` with exact response and terminal invariants.
- Render Pi blocking dialogs through the current Codex Desktop native user-input request and return answers to the original Pi callback.
- Support early Questions, Tool-associated Questions, standalone Extension Questions, Adapter timeout cleanup, cancellation, fault, close, and continuation.
- Provide a narrowly scoped codexhost Pi Extension tool so the model can ask one choice or text Question.
- Preserve transparent routing for official Codex server requests and all non-owned responses.

**Non-Goals:**

- No Approval, permission mode, or implied security decision.
- No Renderer-owned dialog UI and no Pi TUI parsing.
- No persistence of Interaction state or answers.
- No Snapshot, Resume, Mapping Store, Fork, Detach, model catalog, or release packaging.
- No support for RPC fire-and-forget Extension UI methods beyond ignoring them safely or reporting a non-sensitive notice where already supported.
- No other Harness integration or semantic calibration.

## Decisions

### 1. Add Question as a first-class Harness output

`HarnessOutput` becomes a union of ordered Host events and `HostQuestionInteraction`. `HostCommand` gains `interaction.respond`, and `HarnessSession.execute()` gains the matching typed overload. Question responses contain answers keyed by stable Host Question ID plus an explicit cancellation flag.

A Question is not an Item and is not persisted as Transcript. It may reference an owning `itemId` when native execution provides one. The Adapter owns `Host Interaction ID -> native callback` correlation and emits exactly one `interaction.closed` event before the Turn terminal.

Alternative: encode Question as Generic Tool output. Rejected because a blocking callback needs a typed reverse command, distinct pending state, timeout, and cancellation.

### 2. Implement only Question semantics

Pi `select`, `confirm`, `input`, and `editor` map to choice or text Questions. Confirm maps to a required single choice with fixed `yes` and `no` values. This change does not add an Approval union member or generic native payload escape hatch.

Alternative: implement the full target Approval model at the same time. Rejected because Pi exposes no independent native Approval and the user requested a Pi-only flow.

### 3. Keep all native IDs private and maintain three correlations

The complete path maintains separate identifiers:

```text
Codex JSON-RPC server request ID
-> Host Interaction ID
-> Pi extension_ui_request ID
```

The Host allocates server request IDs from the reserved `-1..-1000000` range and intercepts only exact pending IDs. Official app-server requests use non-negative numeric IDs. Unknown responses outside the reserved range continue to the official app-server. The Pi Adapter never exports the Pi request ID, and Protocol Core never receives an `extension_ui_*` payload.

### 4. Use the native Codex user-input server request

Protocol Core projects a Host Question to `item/tool/requestUserInput` and validates `ToolRequestUserInputResponse` at the first consumption boundary. Choice options become Codex labels; free text uses `options: null`; allow-other is preserved; Pi timeout becomes `autoResolutionMs`. The current Desktop renders `isSecret: true` as an unmasked textarea, so Protocol Core fails secret Questions closed and Host cancels the Interaction instead of exposing visible secret input. Current Desktop also renders the timeout duration but does not automatically answer or dismiss the native Question.

Codex requires an `itemId`. A Question emitted while a Tool Item is active uses that Item. A standalone or preflight Question gets a stable synthetic Generic Tool Item owned by the Host Turn; it starts before the server request and completes when the Interaction closes. The first implementation task is a real Desktop compatibility Gate proving this sequence. If the current build rejects or fails to render it, implementation pauses and the design is revised rather than silently adding custom Renderer UI.

Alternative: use an arbitrary Agent Message Item ID. Rejected because it violates the Codex request's Tool association and creates unsupported UI behavior.

### 5. Preserve ordered response gating without deadlock

The Pi Session establishes the active Turn and native callback registry before submitting the prompt. `turn.started` is ordered before any Question. The Host writes the `turn/start` response before sending the Codex server request, but the Adapter does not wait for the Pi Prompt response before publishing an early Question. This prevents a cycle where Pi waits for the user while Host waits for Prompt acceptance.

A Desktop answer invokes `interaction.respond` on the owning Session. Command success means the native response frame was accepted for writing, not that the Turn completed.

### 6. Close every exposed Interaction exactly once

The Adapter tracks each Question as pending, responded, cancelled, expired, or superseded. It rejects unknown, duplicate, wrong-type, and post-terminal responses without affecting another Question. Native timeout closes as expired; accepted user response closes as responded; Turn cancel and Session close close as cancelled; replacement of a single-dialog native surface closes an older Question as superseded only if Pi actually supersedes it.

All pending Interactions close before `turn.completed`. A transport fault first closes pending Interactions, then completes active Items and Turn, then emits `session.faulted`.

### 7. Load a controlled question Extension explicitly

The Pi Adapter resolves a built Extension asset owned by `packages/adapters/pi` and passes it through repeatable `--extension`. It does not write into `~/.pi`, the project, or Pi settings, and it does not disable the user's ordinary Extension discovery. The Extension registers one `codexhost_question` Tool supporting one choice, single-line text, or multiline text prompt and calls only `ctx.ui.select`, `ctx.ui.input`, or `ctx.ui.editor`. It does not expose a timeout parameter because the current Desktop cannot automatically dismiss an expired `requestUserInput` request.

The Extension does not make permission decisions, access files, spawn processes, persist entries, or handle project trust. Tests can inject an alternate Extension path. Missing or unloadable controlled Extension is a clear Session startup failure when model-initiated Question support is enabled.

Alternative: install globally or place `.pi/extensions` in each project. Rejected because it mutates user/project configuration and changes the project trust boundary.

### 8. Keep timeout and privacy semantics explicit

The Pi transport performs native timeout resolution and Codex receives the same duration. The Adapter owns the bounded timer so a lost UI response cannot leak the native callback or Host Interaction state. When timeout, cancellation, fault, close, or Thread deletion resolves a Question without a Desktop response, the Host emits `serverRequest/resolved` for the numeric Host request ID and rejects any late answer at the Adapter boundary.

The current Desktop build does not automatically send a response for `autoResolutionMs`, and its `serverRequest/resolved` path does not remove this external Thread's visible `requestUserInput` control. Pi therefore continues correctly after timeout, but Desktop keeps the stale Question and withholds the Composer until the user clicks an option or Skip; that late response is consumed without reaching Pi. The controlled product Tool does not expose timeout until this Desktop behavior is resolved. This is a documented compatibility limit, not a successful UI timeout Gate.

Prompts and answers, especially secret text, are not written to diagnostics, route observations, committed Fixtures, Mapping Store, or ordinary test output. Tests assert structure, IDs, counts, and enum-like outcomes only.

## Risks / Trade-offs

- [The Codex request is experimental and may change by Desktop build] -> Add runtime validation, versioned real Desktop evidence, and fail closed on incompatible shapes.
- [Standalone Pi dialogs have no native Tool Item] -> Gate the synthetic Generic Tool lifecycle before implementing the full bridge.
- [Codex free-text UI may not preserve multiline editor prefill] -> Verify actual rendering; use honest text fallback or report unsupported instead of pretending fidelity.
- [Pi timeout and Desktop auto-resolution can race] -> Use one pending-state transition, reject all later paths idempotently, and do not expose timeout through the controlled Tool while the current Desktop leaves expired Questions visible.
- [User Extensions can emit sensitive Questions] -> Never log prompt or answer bodies and keep complete native IDs private.
- [The controlled Extension runs with user permissions] -> Keep it dependency-light and side-effect-free, load it explicitly, and document that it is not a sandbox or permission layer.
- [Host-owned server request IDs can collide with official requests] -> Reserve a bounded negative safe-integer range, use an exact pending registry, and transparently forward all IDs outside that range.

## Migration Plan

1. Prove current Desktop `requestUserInput` request/response behavior with a synthetic external Turn and reviewed shape-only evidence.
2. Add the public Question contract and Fake contract tests without changing product routing.
3. Add Protocol Core projection and Host request-response routing with synthetic tests.
4. Add Pi RPC runtime schemas, Adapter mapping, and the controlled Extension asset.
5. Run hermetic checks, real Pi Extension scenarios, and a controlled Desktop Gate covering answer, cancel, timeout, continuation, and process cleanup.
6. Rollback is removal of the new contract member, projector path, Extension flag, and Host request registry; no persistent data migration is required.

## Compatibility Findings

- Tool-associated and stable synthetic `dynamicToolCall` Items both render `requestUserInput` and return answers in the current Desktop. The standalone Gate's later Assistant text still hit the separately tracked visible-Thread binding P0; that does not invalidate the synthetic Item lifecycle itself.
- `input` renders as a native textarea. `editor` degrades to the same textarea but preserves submitted multiline text; editor-specific prefill presentation is not claimed.
- `isSecret: true` still renders an unmasked textarea (`-webkit-text-security: none`), so secret Questions are rejected before Desktop projection.
- Choice click, text Enter, and Skip return explicit responses. `autoResolutionMs` does not return a Desktop response, and `serverRequest/resolved` does not dismiss this external Thread's visible control in the current build.
- Future fire-and-forget Pi `notify` requests remain ignored until a separate user-visible notification slice.
