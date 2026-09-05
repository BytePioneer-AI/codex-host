# Antigravity Tool Approval

Select **Desktop approvals** in the Permission Mode picker to approve tool
actions through Desktop. The existing **Configured permissions** and
**Skip permissions** modes retain their previous behavior.

## Execution Boundary

Native agy 1.1.27 print mode cannot consume interactive permission responses.
A real probe confirmed that a PreToolUse `allow` decision alone still leaves a
command subject to native headless denial. Therefore this opt-in mode uses
`--dangerously-skip-permissions` for that CLI process and gates execution with
the private PreToolUse Hook.

Before sending any model input, the Adapter asks the CLI for its effective Hook
configuration using the same workspace and private Hook directory. It requires
the exact enabled all-tool Hook, source path, and command. Missing or invalid
configuration rejects the Turn without starting tools.

The Hook waits for a standard `HostApprovalInteraction` response, projected
through `mcpServer/elicitation/request`. Only **Allow once** and **Deny** are
offered. Timeout, cancellation, a closed connection, malformed responses, and
foreign session identities deny execution. No persistent session or global
permission grants are written by the bridge.

The transport is shared with the Question bridge, including its private
loopback authentication, payload limits, Windows command quoting, and cleanup.
Question replies still use `deny.reason`; an approval never authorizes a native
question's automatic skip behavior.

## Scope

- Tool arguments are supplied to the common approval projector. Desktop applies
  its existing display-length limits; this is not a new custom review UI.
- Each permission approves one native tool call, not every operation performed
  internally by that tool or an approved command.
- Registered direct-child Hook requests can be approved on the active parent
  Turn. Unknown or detached child requests are denied. Child-specific Questions
  and Autonomous Turns are not introduced.
- Calling `ask_permission` is unnecessary in this mode: the agent must call the
  intended tool, which triggers the Desktop approval.
- This depends on private CLI behavior and effective Hook loading. Revalidate
  after CLI changes; do not describe it as native stdin permission support.

## Evidence

Windows, agy 1.1.27, 2026-09-05:

- Plain `allow` and an empty `permissionOverrides` list did not grant execution.
- Process-level skip plus Hook `allow` executed the fixture command.
- Process-level skip plus Hook `deny` did not execute it.
- A missing Hook script failed the tool instead of executing it.
- Existing deny Hooks prevailed over an allow Hook.
- The real Adapter test verified that a file did not exist while approval was
  pending, appeared only after Desktop acceptance, and was never created after
  denial or cancellation. Interaction closure preceded Turn completion.

The new mode has protocol/runtime verification, not a user-confirmed Desktop
visual acceptance test.

```powershell
$env:CODEXHOST_RUN_ANTIGRAVITY_APPROVAL_REAL = "1"
node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js packages/host-runtime/test/antigravity-approval.real.test.ts
```

This opt-in test uses the locally configured account and a private workspace.
Optional runtime evidence is written to
`CODEXHOST_ANTIGRAVITY_APPROVAL_EVIDENCE_DIR`; do not commit it.
