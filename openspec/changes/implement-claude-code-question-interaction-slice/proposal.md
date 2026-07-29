## Why

Claude Code has a native model-facing `AskUserQuestion` Tool, but the current Adapter disables all built-in Tools and returns `unsupported` for `interaction.respond`. The shared Question contract and Codex Desktop projection are now proven, so the Claude Adapter can preserve this original Claude capability without adding a codexhost-owned Tool.

## What Changes

- Preserve Claude Code's inherited default Tool set and provide the SDK `canUseTool` callback required to answer native `AskUserQuestion`.
- Convert validated native Question input into the live `HostQuestionInteraction` path while keeping Tool Use ID, control Request ID, native answer-key correlation, and SDK payloads private to the Claude Adapter.
- Convert validated Host answers back into the exact SDK `PermissionResult.updatedInput.answers` shape and resume the original callback.
- Close pending Questions exactly once on answer, Skip, Turn cancel, SDK AbortSignal, fault, Session close, or native terminal processing.
- Reuse the existing HarnessAdapter Question contract, Host request registry, Protocol Core projector, and Codex native `item/tool/requestUserInput` UI.
- Keep ordinary Tool permission callbacks distinct and unsupported in this slice. Do not auto-allow Read, Edit, Bash, permission updates, or any non-Question Tool.

## Capabilities

### New Capabilities

- `claude-code-question-interaction-session`: Claude Code native `AskUserQuestion` mapping, callback response conversion, lifecycle convergence, and capability-boundary requirements.

### Modified Capabilities

None.

## Impact

- Extends `packages/adapters/claude-code` transport and Session state with private native Question records and reverse responses.
- Reuses public types in `packages/harness-adapter` and routing in `packages/protocol-core` and `packages/host-runtime` without adding a Claude-specific public payload.
- Adds hermetic Claude Adapter/SDK transport tests and a controlled real SDK/Desktop compatibility Gate.
- Does not add dependencies, persistence, Renderer UI, Approval, release packaging, or Pi behavior.
