## Why

The Claude Code Adapter currently denies every ordinary Tool permission callback because the Host contract and Codex projection support only Questions. As a result, a Claude Turn that needs the user's approval for Edit, Write, Bash, or another native Tool cannot present a confirmation in Codex Desktop and continue after the user's decision.

## Gate Status

**Passed for native Approval on Codex Desktop `26.727.6591.0`.** The reviewed `mcpServer/elicitation/request` form with `_meta.codex_approval_kind: "mcp_tool_call"` renders truthful bounded context. Without `persist` it exposes `Allow once` and `Deny`; reviewed private metadata additionally supports `persist: "session"` and `persist: "always"`, producing `Allow this conversation` and `Always allow`. Responses preserve the selected scope in `_meta.persist`.

On external Turn cancellation, this Desktop may retain the native card after `serverRequest/resolved`. That presentation limitation does not block the MVP: Host and Adapter state must still converge before the Turn terminal, and the Host-owned Request-ID namespace must consume any late response without executing a Tool or forwarding the frame. Command, File Change, permissions, Question, and custom Renderer fallbacks remain out of scope.

## What Changes

- Add a UI-independent Approval Interaction with `allowOnce`, `deny`, and only the optional native `allowForSession` or `allowAlways` decision actually offered by the Harness, plus exact response correlation and ordered close/cancel/fault handling.

- Convert validated Claude Code `canUseTool` callbacks other than `AskUserQuestion` into pending Host Approvals instead of denying them immediately.
- Project pending Host Approvals through one reviewed native Codex app-server Approval server-request path and route the Desktop decision back to the exact Claude SDK callback.
- Keep Claude Tool input, Tool Use ID, control Request ID, SDK permission suggestions, and `PermissionResult` private to `packages/adapters/claude-code`; a broader accepted action returns the exact original suggestion set as `updatedPermissions`.
- Follow the proven Paseo deferred-callback pattern through an independent implementation; do not copy Paseo's AGPL code, shared Permission protocol, or custom UI.
- Keep `AskUserQuestion` on the existing Question path. Do not add Permission Mode controls, codexhost-owned permission rules, automatic approval, ordinary Claude Tool/File Change projection, custom Renderer UI, codexhost persistence, or release-scope changes.

## Capabilities

### New Capabilities

- `harness-adapter-approval-interaction-session`: Bounded Host Approval lifecycle, declared one-shot/Session/always responses, native Codex Approval projection, reverse routing, and cleanup semantics.
- `claude-code-tool-approval-session`: Claude Code ordinary Tool permission callback mapping, private native correlation, exact SDK response conversion, and Turn lifecycle convergence.

### Modified Capabilities

- `claude-code-question-interaction-session`: Preserve `AskUserQuestion` as Question while ordinary validated Tool permission callbacks use the separate Approval capability.
- `claude-code-text-session`: Reconcile partial and complete text per native Assistant response so a permission-mediated Tool loop can emit text before and after the Tool without a false Turn-level text conflict.

## Impact

- Extends public TypeScript contracts and contract tests in `packages/harness-adapter` with a bounded Approval union member and response.
- Adds the reviewed native MCP Approval projector in `packages/protocol-core` and Host-owned response routing in `packages/host-runtime` without changing official Codex transparency.
- Extends `packages/adapters/claude-code` transport and Session state with private pending Approval continuations and exact native permission-update application while retaining the current SDK, executable discovery, Tool set, and `permissionMode: "default"`; it also corrects response-scoped partial/full text reconciliation exposed by permission-mediated Tool loops.
- Adds no dependency, persistent data migration, Renderer component, Pi behavior, Permission Mode UI, or Claude release-support claim.
