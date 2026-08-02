## Context

The current Claude Code transport runs the user-installed executable through Agent SDK `0.3.220`, inherits Claude Code's native Tool set, uses `permissionMode: "default"`, and supplies `canUseTool`. The callback currently exposes only validated `AskUserQuestion` requests; every other Tool permission callback is denied immediately. The public Harness contract, Protocol Core projector, and Host-owned server-request registry likewise support Question but not Approval.

The prior Claude semantics Gate proved that an ordinary Tool permission callback carries a Tool Use ID, a separate control Request ID, an AbortSignal, the proposed input, and optional permission updates. It also proved that `AskUserQuestion` uses the same callback but has Question semantics. Paseo demonstrates the minimal implementation pattern needed here: retain a deferred callback in provider-owned memory, expose a bounded approval request, and resolve only that callback after an allow or deny response. This change follows that behavior independently and does not copy Paseo's AGPL implementation or its unified Permission protocol.

The current supported Codex Desktop exposes several native Approval server-request surfaces. The compatibility Gate below selected one generic external-Harness shape that truthfully provides one-shot decisions. Follow-up inspection of the same Renderer found that this shape also accepts private `persist: "session" | "always"` metadata and returns the selected scope. External cancellation leaves a known presentation limitation in this Desktop build, but Host and Adapter lifecycle convergence can remain exact.

## Desktop Approval Gate Result

**Result: passed for the native Approval surface.** The controlled Gate used Codex Desktop `26.727.6591.0` with bundled `codex-cli 0.130.0-alpha.5`. It generated the current app-server JSON Schema, inspected the matching Renderer implementation, and exercised synthetic external Turns through the repository Launcher and Shim. A follow-up raw-response Gate covers one-shot, Session, and always scope. Gate artifacts contain no real Claude prompt, Tool input, native identifier, permission suggestion, or model request and remain under ignored `.codexhost/approval-gate/`.

The reviewed native candidates were:

- `item/commandExecution/requestApproval`: rejected because it necessarily presents Command Execution semantics for an arbitrary Claude Tool.
- `item/fileChange/requestApproval`: rejected because it necessarily presents File Change semantics and would imply a change or Diff that the callback does not prove.
- `item/permissions/requestApproval`: rejected because its reviewed payload and UI describe filesystem or network permissions rather than a generic native Tool decision.
- `mcpServer/elicitation/request`: accepted because the reviewed MCP Tool Approval form renders truthful bounded context, always exposes `Allow once` and `Deny`, conditionally exposes `Allow this conversation` or `Always allow`, and creates no Command or File Change Item.

The exact exercised MCP candidate request shape was the following; the Gate used a Host-reserved negative integer for `id`, represented here by a non-native placeholder:

```json
{
  "id": "<Host-owned request ID>",
  "method": "mcpServer/elicitation/request",
  "params": {
    "serverName": "Claude Code",
    "threadId": "<Host thread ID>",
    "turnId": "<Host turn ID>",
    "mode": "form",
    "message": "<bounded approval title>",
    "requestedSchema": { "type": "object", "properties": {} },
    "_meta": {
      "codex_approval_kind": "mcp_tool_call",
      "reason": "<bounded approval description>",
      "persist": "<optional session or always>"
    }
  }
}
```

The reviewed JSON-RPC `result` requires an `action` field with enum value `accept`, `decline`, or `cancel`. The Renderer sends `content: {}` for acceptance and `content: null` for decline/cancel. `Allow once` sends `_meta: null`; `Allow this conversation` sends `_meta: {"persist":"session"}`; `Always allow` sends `_meta: {"persist":"always"}`. `Deny` and Escape send `action: "decline"`, `content: null`, and `_meta: null`, confirming that dismissal has deny semantics rather than Turn-cancel semantics. The public app-server Schema leaves `content` and `_meta` open; these exact fields are a version-reviewed Renderer convention and must be parsed strictly.

For external Turn cancellation, the synthetic Host emitted `serverRequest/resolved` with the matching `threadId` and Request ID, followed by an interrupted `turn/completed`. This Desktop retained the native card with `Deny` and `Allow once` controls. The accepted implementation therefore distinguishes authoritative lifecycle from native presentation: it must retire Host and Adapter pending state before the Turn terminal, send `serverRequest/resolved`, and consume every later response in the reserved Host Approval Request-ID namespace without executing a Tool, forwarding to the official app-server, or affecting another Turn. The lingering native card is a version-scoped Desktop presentation limitation, not an active codexhost Approval.

The single accepted projection schema for this build is the MCP request and response shape above. It is version-reviewed and must be re-gated when the supported Desktop protocol or Renderer behavior changes.

Post-implementation verification used the production Claude SDK transport with controlled native callbacks. One-shot Allow resumed only matching callbacks without permission updates; explicit `permissions.ask` callbacks correctly exposed no broader action when the SDK supplied no suggestions. A natural Bash callback supplied `always` scope; in an isolated `CLAUDE_CONFIG_DIR`, accepting it returned `behavior: "allow"`, permanent-user classification, and `updatedPermissions` with the same array identity and count as the SDK's original suggestions, then executed the Tool successfully. Deny left target files unchanged; interrupt closed pending callbacks as cancelled; a later Turn on the same transport succeeded; and no transport fault occurred. A controlled Deny regression also covered text both before and after the permission callback without a false Turn-level text conflict. Separate current-Desktop runs proved the complete responses for `Allow once`, `Allow this conversation`, `Always allow`, and `Deny`; Escape retains the previously reviewed decline semantics.

## Goals / Non-Goals

**Goals:**

- Add a UI-independent Approval Interaction that is separate from Question.
- Surface validated ordinary Claude `canUseTool` callbacks as one-shot Allow or Deny decisions plus only the native broader scope represented by a valid suggestion set.
- Return the decision and, only for that broader action, the exact original suggestions to the exact SDK callback while preserving Turn, Interaction, cancel, fault, and close ordering.
- Reuse one reviewed native Codex Approval server-request path and the existing Host-owned reverse-routing pattern.
- Keep complete Tool input, SDK IDs, permission suggestions, and SDK response objects inside the Claude Adapter.

**Non-Goals:**

- No codexhost-owned Session or persistent Permission Rule, settings writer, or suggestion synthesis.
- No Claude Permission Mode discovery, selection, or effective-state UI.
- No automatic approval or Host-owned permission policy.
- No ordinary Claude Tool Item, File Change, Diff, Tool history, or reliable Patch projection.
- No custom Renderer approval component, Question fallback, Pi behavior, persistence, new dependency, or release-support claim.

## Decisions

### 1. Add Approval as a separate bounded Host Interaction

`HostInteraction` gains `HostApprovalInteraction`, and `HostInteractionResponse` gains an Approval response selected by stable action ID. Every Approval exposes exactly one `allowOnce` and one `deny` effect; it may additionally expose one `allowForSession` and/or one `allowAlways` effect only when the concrete Harness offers those scopes. The Interaction carries its Host ID, owning Turn ID, bounded display text, `nativeAction` subject, and declared actions. It carries no Tool input, path locator, SDK suggestion, or native identifier.

Question types and validation remain unchanged. A callback cannot be both Question and Approval.

Alternative: encode Approval as a two-option Question. Rejected because it would erase the security meaning already distinguished by the native callback and the repository architecture.

Alternative: put native permission updates directly on `HostApprovalAction`. Rejected because it would expose provider protocol payloads to generic Host and Protocol Core code. Stable semantic effects are sufficient for projection and reverse routing.

### 2. Retain a provider-owned deferred callback, following the Paseo pattern

For each valid non-`AskUserQuestion` callback during an active Turn, the Claude transport stores a private pending record containing the original input, Tool Use ID, control Request ID, AbortSignal listener, exact valid suggestion array, and `PermissionResult` resolver. The transport emits a private Approval request with bounded display fields derived in priority order from SDK `title`, `displayName`, `description`, and Tool name, plus only a `session` or `always` scope discriminator. No update object crosses the package boundary.

The Adapter assigns the Host Interaction ID and maps it back to that private request. Multiple callbacks use independent records; duplicate control Request IDs, missing IDs, callbacks outside an active Turn, and invalid display data are denied without exposing an Interaction.

Alternative: expose the SDK callback object through HarnessAdapter. Rejected because it crosses ownership boundaries and makes Protocol Core depend on a versioned Claude protocol.

### 3. Convert each declared decision to the exact SDK result

`allowOnce` resolves the matching callback with `behavior: "allow"`, unchanged original input, matching Tool Use ID, and temporary-user classification. It never returns `updatedPermissions`, even when suggestions were present. `allowForSession` or `allowAlways` is accepted only when it matches the pending request's derived scope; it returns the same unchanged input and Tool Use ID, permanent-user classification, and the exact original complete suggestion array as `updatedPermissions`. `deny` returns a non-sensitive denial message, matching Tool Use ID, and user-reject classification.

A non-empty suggestion set is Session-scoped when every known destination is `session` or `cliArg`. If any destination is `userSettings`, `projectSettings`, or `localSettings`, it is represented as always scope. Missing, empty, malformed, or future unknown destinations do not expose a broader action. codexhost never splits, widens, rewrites, caches, or persists suggestions; Claude SDK remains the final executor.

Dismissing the Desktop control is `deny`; it does not cancel the Turn. Turn cancellation remains the existing `turn.cancel` operation.

### 4. Use the reviewed native MCP Tool Approval projection

Protocol Core projects `HostApprovalInteraction` through the reviewed `mcpServer/elicitation/request` form with `_meta.codex_approval_kind: "mcp_tool_call"`, bounded `serverName`, `message`, optional `reason`, optional `persist`, and an empty object schema. It accepts only reviewed `action`, `content`, and `_meta` combinations: `accept` with no persist maps to `allowOnce`; `accept` with declared `session` or `always` maps to the matching semantic action; `decline`, `cancel`, and response errors fail closed to `deny`. Unknown fields, non-empty content, malformed persist metadata, and undeclared scopes fail closed.

Host Runtime allocates Approval requests from a reserved negative integer namespace distinct from Question requests. It owns the pending registry, routes direct responses through `interaction.respond`, and consumes unknown, duplicate, or late responses from that entire namespace. This preserves transparent forwarding for official app-server traffic while ensuring a stale native card cannot revive a closed Approval.

On Interaction close, Turn cancel, fault, Thread deletion, or Host shutdown, Host Runtime removes the pending entry and sends `serverRequest/resolved`. Current Desktop may retain an actionable-looking historical card, but codexhost has no live callback behind it and consumes any late click. `item/tool/requestUserInput`, a custom Renderer control, and semantically false Command, File Change, or permissions requests remain prohibited fallbacks.

### 5. Close every pending Approval before the Turn terminal

An accepted user decision emits `interaction.closed(responded)` after the matching native callback is settled. SDK AbortSignal, Turn cancel, Session close, transport fault, or an otherwise terminal native Turn closes each pending Approval exactly once before `turn.completed`. Late, duplicate, malformed, wrong-type, and wrong-Session responses return `invalidRequest` or `invalidState` and cannot affect another callback.

Cancel acceptance alone does not fabricate the Claude Turn terminal. The Adapter continues to wait for the native Result under the existing cancellation rules.

### 6. Preserve native policy and the current capability boundary

The Query remains on `permissionMode: "default"`, loads the same setting sources, and inherits the same native Tool set. A Tool already allowed by Claude Code rules may execute without `canUseTool`; this change does not synthesize an Approval for it. A Tool denied before the callback likewise produces no Host Approval.

This slice does not claim Tool or File Change visibility. That remains separate because permission callbacks describe decisions, not complete Tool execution or reliable successful patches.

### 8. Reconcile streaming text within each native Assistant response

A permission decision can split one Host Turn into multiple native Assistant responses: Claude may emit text, request a Tool, receive an allow or deny Tool result, and then emit more text before the single native Turn Result. SDK partial text belongs to the current native Assistant response, while a later complete Assistant message contains only that response's text; it is not a cumulative snapshot of all text already published for the Host Turn.

`ClaudeNativeTurnAccumulator` therefore keeps response-local streamed text for partial/full deduplication. A non-empty complete Assistant text reconciles only against the pending partial text for that response, appends any missing suffix, and closes that reconciliation segment. A later Assistant response starts a new segment and its text is appended in Turn order. The Adapter's Agent Message remains the ordered concatenation of all emitted deltas. A complete response that conflicts with partial text from its own open segment still fails closed as `textConflict` rather than replacing visible text.

Alternative: remove complete-message consistency checks and trust partial events exclusively. Rejected because partial streaming can be unavailable or incomplete, and the complete Assistant message remains the deterministic fallback.

Alternative: compare each complete Assistant message with all text published for the Host Turn. Rejected because the observed native permission-denial Tool loop proves complete messages are response-local, making Turn-global comparison a false conflict.

## Risks / Trade-offs

- [Current Desktop retains the MCP Approval card after external resolution] -> Converge authoritative Host and Adapter state, emit `serverRequest/resolved`, reserve and consume the full Host Approval response namespace, and document the version-scoped presentation limitation.
- [Claude permission rules bypass `canUseTool`] -> Expose only callbacks actually received and make no claim that Approval is a complete Tool audit stream.
- [SDK display metadata is missing or oversized] -> Use a bounded Tool-name fallback and deny malformed callbacks without exporting raw input.
- [Concurrent callbacks race with cancel or terminal processing] -> Use request-keyed pending records and one idempotent settle operation driven by response or AbortSignal.
- [A Desktop response offers an undeclared or malformed broader scope] -> Reject it before Adapter dispatch and fail closed to the declared deny action.
- [Approval input contains sensitive commands or paths] -> Keep complete input and native IDs inside the Adapter and retain only bounded live display text; do not persist or log them.
- [Approval appears without ordinary Tool projection] -> State the limitation explicitly and avoid fabricating Tool, File Change, or Diff items.
- [A Tool loop emits text both before and after a permission decision] -> Reconcile partial/full text only within the current native Assistant response and retain true same-response conflicts as failures.

## Migration Plan

1. Add the public Approval contract and Fake Harness contract tests.
2. Add the reviewed Protocol Core MCP projector and Host reverse routing with a reserved Approval Request-ID namespace.
3. Extend the Claude transport and Adapter with private pending Approval state and exact SDK response conversion.
4. Add optional semantic scopes to the existing contract/projector and preserve exact native suggestions privately.
5. Run focused hermetic tests, controlled real SDK/Desktop approval verification, privacy checks, and strict OpenSpec validation.

Rollback removes the new union members, projector, Host registry branch, and Claude mapping. There is no persistent data migration and no Native Session content is changed.

## Known Compatibility Constraint

- Codex Desktop `26.727.6591.0` can retain the native MCP Approval card after external `serverRequest/resolved`. The Host treats it as non-authoritative after cleanup and consumes all late responses in its reserved Approval Request-ID namespace. A future supported Desktop build should be re-gated to determine whether the presentation limitation has been fixed.
