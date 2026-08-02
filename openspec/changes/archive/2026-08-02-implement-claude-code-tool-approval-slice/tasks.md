## 1. Codex Native Approval Gate

- [x] 1.1 Runtime-inspect the supported Desktop build's native Approval server-request candidates and record only reviewed method, field, action, and response-shape facts
- [x] 1.2 Run a controlled synthetic external Turn proving the native MCP Tool Approval candidate renders truthful bounded context, supports one-shot Allow and Deny, returns exact responses, and closes after direct response or dismissal without fabricated Tool/File Change semantics or custom Renderer UI
- [x] 1.3 Record the single accepted request/response schema, version result, and external-cancellation presentation limitation in `design.md` before production implementation

## 2. HarnessAdapter Approval Contract

- [x] 2.1 Add `HostApprovalInteraction`, bounded `allowOnce`/`deny` actions, Approval response, and the corresponding `HostInteraction` and `HostInteractionResponse` union members without changing Question semantics
- [x] 2.2 Add reusable Approval response validation for pending ownership, response type, declared action ID, and duplicate or closed state
- [x] 2.3 Extend FakeHarnessSession and contract tests for Allow, Deny, early Approval, independent concurrent Approvals, malformed/duplicate/wrong-Session responses, cancel, fault, close, and unique pre-terminal closure

## 3. Codex Approval Projection And Host Routing

- [x] 3.1 Add one Protocol Core projector for the Gate-reviewed native Codex Approval request and strict response parser, with no `requestUserInput`, custom UI, opaque native payload, or unsupported scope
- [x] 3.2 Extend the Host-owned server-request registry to route exact Approval responses through `interaction.respond` while preserving response-before-notification ordering and transparent official Codex traffic
- [x] 3.3 Integrate response, dismissal, malformed response, Turn cancel, Interaction close, Thread delete, fault, and Host shutdown cleanup so no in-memory Approval remains; emit native resolution and consume every late Host Approval response despite the reviewed Desktop presentation limitation
- [x] 3.4 Add Protocol Core and Host tests for Allow, Deny, unsupported scope, malformed/unknown/duplicate response, concurrent official requests, early Approval, cancellation, and unique terminal ordering

## 4. Claude Native Approval Transport

- [x] 4.1 Add private Claude Approval request, response, and closure transport types carrying only the fields needed by the Adapter while retaining original input, Tool Use ID, control Request ID, AbortSignal, and resolver privately
- [x] 4.2 Route valid non-`AskUserQuestion` `canUseTool` callbacks into independent pending Approval records and deny malformed, duplicate, or out-of-Turn callbacks without exposing an Interaction
- [x] 4.3 Convert `allowOnce` to the exact temporary-user SDK allow result with unchanged input, and convert `deny` to the exact user-reject result without returning `updatedPermissions` or interrupting the Turn
- [x] 4.4 Implement idempotent response, AbortSignal, Turn terminal, transport fault, and bounded close cleanup while preserving the existing Query, Tool set, settings sources, and `permissionMode: "default"`
- [x] 4.5 Add SDK transport tests for Edit/Bash callbacks, bounded display fallback, suggestions omission, exact Allow/Deny results, multiple callbacks, duplicate IDs, AbortSignal, terminal cleanup, and unchanged `AskUserQuestion` behavior

## 5. Claude HarnessAdapter Mapping

- [x] 5.1 Map private Claude Approval requests to `HostApprovalInteraction` with separate Host/native IDs and no Tool input, suggestion, or SDK payload crossing the package boundary
- [x] 5.2 Route validated Host Approval actions to the matching transport callback and reject wrong-type, unknown, duplicate, post-abort, and post-terminal responses
- [x] 5.3 Close all exposed Approvals before Turn terminal, cancel, fault, and Session close while preserving same-Session continuation
- [x] 5.4 Extend Claude Adapter tests for early and multiple Approvals, Allow, Deny, dismissal, invalid responses, cancellation, continuation, privacy, and strict separation from Question

## 6. Verification And Documentation

- [x] 6.1 Run the focused HarnessAdapter, Protocol Core, Host Runtime, and Claude Adapter tests plus formatting, lint, typecheck, and affected builds
- [x] 6.2 Run a controlled real Claude SDK and Desktop Gate proving a permission-requiring Tool waits, Allow resumes only that callback, Deny prevents that Tool, cancellation converges, and the Session can continue without recording prompt, input, or complete IDs
- [x] 6.3 Audit package boundaries, diagnostics, Fixtures, Mapping Store, and git status so native input, SDK suggestions, complete IDs, decisions, raw captures, and Paseo reference code are not committed or leaked
- [x] 6.4 Update affected HarnessAdapter/Claude status documentation, run `openspec validate implement-claude-code-tool-approval-slice --strict`, and run `git diff --check`

## 7. Native Permission Suggestion Fidelity

- [x] 7.1 Re-gate the supported Renderer `persist: "session" | "always"` request metadata and capture the complete `action`/`content`/`_meta` response shapes
- [x] 7.2 Extend the bounded Approval contract and Protocol Core projector for optional Session/always effects without exposing native permission payloads
- [x] 7.3 Preserve valid Claude SDK suggestions privately and return the exact original array as `updatedPermissions` only for its matching declared broader action
- [x] 7.4 Add focused contract, projector, Host, Claude Adapter, and SDK transport coverage for no suggestions, Session scope, persistent scope, malformed/undeclared scope, exact identity, and lifecycle races
- [x] 7.5 Re-run focused checks, real SDK/Desktop Gates, privacy audit, documentation updates, strict OpenSpec validation, and `git diff --check`

## 8. Tool-loop Text Reconciliation Regression

- [x] 8.1 Reconcile partial and complete text within each native Assistant response instead of comparing later response text with the whole Host Turn
- [x] 8.2 Add native accumulator and SDK transport regression tests for text before a permission callback, denial, later text, successful Result, and retained same-response conflict detection
- [x] 8.3 Run focused tests, formatting, lint, typecheck, affected build, strict OpenSpec validation, diff hygiene, and a controlled real SDK denial regression without committing raw Session evidence
