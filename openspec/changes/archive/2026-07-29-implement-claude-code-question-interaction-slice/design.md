## Context

The shared HarnessAdapter Question contract, Protocol Core `item/tool/requestUserInput` projection, Host-owned request registry, and Desktop reverse routing are already implemented and tested. Claude Code `2.1.220` with Agent SDK `0.3.220` was separately probed: native `AskUserQuestion` is a built-in Tool, reaches SDK consumers through `canUseTool`, carries separate Tool Use and control Request IDs plus an AbortSignal, and accepts answers in `updatedInput.answers` keyed by complete question text.

Before this change, the Claude Adapter used `permissionMode: "dontAsk"`, reported only text deltas, and returned `unsupported` for `interaction.respond`. A parallel registered-Harness change had already removed the earlier `tools: []` override so the SDK Query inherited Claude Code's default Tool set. The Adapter still does not project ordinary Tool Items or Approval.

## Goals / Non-Goals

**Goals:**

- Preserve Claude Code's native `AskUserQuestion` capability without registering a codexhost-owned Tool.
- Map one or more native choice Questions, including multi-select and Other, into the shared Question contract.
- Return exact answers to the original SDK callback and preserve Session/Turn/Interaction ordering.
- Keep native callback identifiers and complete-text answer-key correlation inside the Claude Adapter while sending prompt text only through the ephemeral Host Question path required for UI.
- Reuse the existing Host and Desktop Question path unchanged.

**Non-Goals:**

- No ordinary Tool execution or permission Approval support.
- No automatic allow for Read, Edit, Bash, MCP, permission updates, or unknown callbacks.
- No claim that this slice restores the complete Claude Code Tool preset.
- No opaque `request_user_dialog`, MCP elicitation, persistence, Snapshot/Resume/Fork, or custom Renderer UI.

## Decisions

### 1. Preserve the inherited Claude Tool set and handle only native Question callbacks

The SDK query continues to omit `tools`, inheriting Claude Code's default Tool set, and changes to `permissionMode: "default"` with a `canUseTool` callback. This does not inject a capability: `AskUserQuestion` and the remaining Tools are owned by Claude Code. Native settings may continue to allow Tools without a callback; any Tool that requires an unsupported human permission decision is denied explicitly rather than auto-allowed or mislabeled as Question.

Alternative: restrict `tools` to `["AskUserQuestion"]`. Rejected because it would hide other original Claude capabilities merely to simplify this slice. Alternative: enable the full preset and auto-allow permission callbacks. Rejected because it would bypass Claude's permission semantics.

### 2. Keep SDK callback state inside the transport

The transport validates native `AskUserQuestion` input, stores the original input and a deferred `PermissionResult`, and emits a private typed request containing only the fields required by the Adapter. `respondToInteraction` resolves exactly one pending callback. Unknown, duplicate, malformed, and post-abort responses are rejected.

The SDK Tool Use ID and control Request ID remain private transport identifiers. They never become Host Item IDs, Question IDs, diagnostics, or persisted state.

### 3. Map native Questions without a native Tool Item in this slice

Each native question becomes a required Host choice Question. Stable Host IDs use the request-local ordinal; option label is both Host value and label, description is preserved, `multiple` follows `multiSelect`, and `allowOther` is true because Claude Code provides Other automatically. Preview metadata is omitted because the shared contract and current Desktop have no reviewed representation.

The interaction has no `itemId`, so the existing Host projector creates its reviewed synthetic Generic Tool Item. A later Claude Tool slice may associate the native `AskUserQuestion` Tool Item without changing the Interaction contract.

### 4. Convert Host answers to Claude's exact answer object

The Adapter validates the Host response, maps stable Host Question IDs back to complete native question text, and joins multi-select values with `", "`, matching the SDK's documented comma-separated output. A normal answer resolves `canUseTool` with `behavior: "allow"`, the original input plus `answers`, the native Tool Use ID, and `decisionClassification: "user_temporary"`.

Skip or cancellation resolves the same native callback with `behavior: "deny"` and a non-sensitive cancellation message. It is not converted into Approval.

### 5. Close pending callbacks before Turn terminal output

A user answer closes as responded; Skip, Turn interrupt, Callback AbortSignal, Session close, or fault closes as cancelled; an impossible native terminal with pending callbacks closes as superseded before Turn completion. Every path removes the pending maps once, and late responses return `invalidState` without affecting another callback.

The Adapter publishes `turn.started` before any early Question. The SDK callback may arrive before the prompt command has produced ordinary stream output, but `runTurn` establishes the active Turn and callback registry before pushing the SDK user message.

### 6. Keep capability boundaries explicit

Any `canUseTool` invocation whose Tool name is not `AskUserQuestion` is denied inside the Claude transport and is never emitted as a Host Question. SDK `onUserDialog` and `onElicitation` remain unset. This slice neither infers Approval from text nor handles opaque native dialog payloads.

## Risks / Trade-offs

- [Claude multi-select strings are comma-separated and labels may contain commas] -> Follow the versioned SDK contract and add exact tests; do not invent escaping.
- [Question previews are lost] -> Omit them explicitly and do not claim preview fidelity.
- [Synthetic Item differs from the native Tool lifecycle] -> Keep IDs separate now and migrate to Tool association only when the Claude Tool slice owns that lifecycle.
- [Permission callback races with interrupt or close] -> Use one deferred pending-state transition driven by the SDK AbortSignal and reject late Host responses.
- [Inherited Tools can execute without Host Item projection when native rules already allow them] -> Retain the existing text-only projection limitation in this slice and do not claim complete Claude Tool UI fidelity.
- [Current Codex `requestUserInput` has no multi-select field] -> Preserve `multiple` in the Host contract and Claude callback conversion, but record that the current Desktop renders the question as single-select and cannot collect multiple values.

## Migration Plan

1. Extend private Claude transport types with Question request, response, and closure events.
2. Add SDK callback validation and deferred response handling while enabling only `AskUserQuestion`.
3. Add Claude Session Interaction mapping and `interaction.respond` conversion.
4. Add hermetic Adapter tests for answer, multi-select/Other conversion, cancellation, abort, malformed input, duplicate response, fault, close, and continuation.
5. Run a controlled real SDK and Desktop Gate before claiming the native popup path.
6. Rollback removes only Claude-owned mapping and restores the previous explicit unsupported result; shared Question contracts remain for other Harnesses.

## Open Questions

- The controlled Desktop Gate confirmed paged multi-question and Other input. It also confirmed that current Codex `requestUserInput` renders Claude `multiSelect: true` as single-select because the Desktop protocol has no multi-select field.
- Full Claude Code capability fidelity still requires a separate Tool and Approval change; the inherited native Tool preset is not equivalent to Host Tool/Approval projection.
