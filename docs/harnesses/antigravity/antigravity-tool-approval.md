# Antigravity Permissions and Interactions

Antigravity integrates through `agy acp` (`agy >= 1.5.8`, validated with `1.5.9`) and exposes native ACP permission modes, tool approvals, and form-based user questions without Host-invented permission rules or external Hook bridges.

## Permission Modes

The Adapter exposes five permission modes matching `agy acp`:

- **`default` (Ask permissions)**: Native new-session default (`currentModeId: "default"`). Read/search operations run directly; mutating edits, command execution, and gated tools trigger native `session/request_permission` requests.
- **`accept-edits` (Accept edits)**: Auto-approves workspace file edits while still requesting permission for shell commands and external side effects.
- **`auto` (Auto)**: Uses Antigravity's native automatic safety classifier via `session/set_mode`.
- **`plan` (Plan)**: Restricts execution to planning and read-only exploration until switched out of Plan mode.
- **`dangerously-skip-permissions` (Skip permissions)**: Starts `agy acp --dangerously-skip-permissions` so native permission prompts are bypassed. Required when `executionPolicy` is `"unattended-full-access"`.

Switching among `default`, `accept-edits`, `auto`, and `plan` calls `session/set_mode` live on the active ACP connection and updates `nativeRef.locator.permissionModeId`. Because `dangerously-skip-permissions` is a CLI startup flag rather than an ACP mode ID, switching into or out of `dangerously-skip-permissions` requires an idle Session: the Adapter closes the current `agy acp` child process and reopens the same `nativeSessionId` via `session/resume` with or without `--dangerously-skip-permissions`. Explicit unknown or retired mode IDs are rejected rather than silently remapped.

## Native Tool Approvals

When `agy acp` sends `session/request_permission`, the Adapter projects `HostApprovalInteraction`:

- Native options (`allow_once`, `allow_always`, `allow_session`, `reject_once`, `reject_always`) map directly to `HostApprovalAction` effects (`allowOnce`, `allowAlways`, `allowForSession`, `deny`) while preserving native `optionId` values for `RequestPermissionResponse`.
- Command executions (`run_command` / `kind: "execute"`) and file-mutating calls (`write_file`, `edit_file`, `kind: "edit" | "delete"`) receive categorized titles and descriptions synthesized from the native `toolCall` payload.
- Cancelling a Turn or closing a Session resolves pending permission callbacks with `{ outcome: { outcome: "cancelled" } }` and emits `interaction.closed` before `turn.completed`.

Actual permission evaluation belongs entirely to `agy acp`; `codexhost` does not maintain a parallel allow/ask/deny ruleset or workspace path filter.

## Native Question Elicitation

The Adapter declares `clientCapabilities.elicitation: { form: {} }` during ACP initialization. When the model invokes `ask_question`, `agy acp` sends `elicitation/create` (`mode: "form"`):

- Single-choice (`oneOf` / `enum`), multi-select (`type: "array"`), free-text (`<key>_other`), and text/password fields are projected into `HostQuestionInteraction` (honoring `required` when listed and keeping unlisted fields optional) and bound to the active `ask_question` `toolExecution` item when present.
- User answers map back to `{ action: "accept", content }`; Turn cancellation or explicit dismissal maps to `{ action: "cancel" }`.

## Validation

Focused unit tests cover permission mode catalog decoding, live `session/set_mode`, idle transport restart across `dangerously-skip-permissions`, `session/request_permission` option mapping, and `elicitation/create` form projection:

```bash
npx vitest run -c tests/vitest.config.js packages/adapters/antigravity/test/permission-modes.test.ts packages/adapters/antigravity/test/skip-permissions.test.ts packages/adapters/antigravity/test/acp-projection.test.ts packages/adapters/antigravity/test/antigravity-adapter.test.ts
```

Opt-in real CLI integration (`CODEXHOST_RUN_ANTIGRAVITY_QUESTION_REAL=1`) verifies live `elicitation/create` round-trip, Turn cancellation while a question is open, and `session/resume` history restoration against an installed `agy` binary.
