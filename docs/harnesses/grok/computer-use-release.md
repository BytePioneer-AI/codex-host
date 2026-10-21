# Grok Computer Use release

Grok uses its user-installed `cua_repl` MCP. Computer Use release requires grokgod patch `0026-cua-turn-end-release` on Grok Build `2bdd1d6a` (1.0.45). An unpatched Grok CLI keeps the MCP connection alive without notifying it when a turn ends. CodexHost does not install `computer-use@openai-bundled` into Grok.

## Turn lifecycle

The native Grok Session actor awaits cleanup on successful and failed completion, cancellation (including rewind), and Session close. Completion cleanup runs after claiming the exact turn finalization lease and before replying to the ACP prompt. Cancellation cleanup runs after aborting the matching task. Stale completions cannot release a successor turn.

Cleanup calls the hidden `cua_repl.turn_ended` tool through the existing MCP connection:

```json
{
  "hook_event_name": "Stop",
  "session_id": "<Grok Session ID>",
  "turn_id": "<Grok prompt ID>"
}
```

Cancellation uses `Interrupt`; completed Subagent turns use `SubagentStop`. Model tool calls carry the same identities in MCP `_meta["x-codex-turn-metadata"]`, together with their call ID. The cleanup tool is excluded from the model's tool catalog.

## macOS Sky bridge

The installed `cua_node` runtime advertises `turn_ended`, but its Mac Sky service does not release native control on that notification alone. Resetting the REPL or closing the MCP is also insufficient. Grokgod adds a narrow trusted-service wrapper when the configured server is named `cua_repl`, enables the `computer` surface, and uses `@oai/sky/service`.

The wrapper delegates ordinary Sky requests and error classification to the installed service. After `turn_ended`, the host calls the wrapper's release RPC over the same MCP. It sends Sky's `ComputerUseIPCCodexTurnEndedRequest` through the installed trusted native-pipe transport, with `{ threadID: session_id, turnID: turn_id }`. Sky then rejects further Computer Use in that turn; a later turn can use it again.

The wrapper is materialized at `<GROK_HOME>/computer-use/sky-release-service.mjs`. The child MCP's trusted-service environment selects it and adds the exact wrapper file to trusted code paths; user configuration files are unchanged. Other configured trusted services are preserved. The wrapper uses the installed Sky package and IPC version `CodexComputerUseIPC-5`; incompatible or custom Sky services fail closed.

## Failure and limits

- The entire cleanup has a three-second deadline. A missing `turn_ended` prevents Computer Use tool admission. A tool error, protocol error, or timeout disables that MCP connection; restart the Session after fixing the runtime.
- Successful cleanup preserves the MCP process and REPL bindings. App approvals and Always allow keep their existing native elicitation behavior; see [MCP elicitation](mcp-elicitation.md).
- Release follows native turn boundaries. There is no additional idle timer during a running turn. Sky's default 120-second IPC timeout bounds individual requests and is separate from turn cleanup.
- Abrupt process termination, OS failure, and independently running sessions are outside the awaited cleanup path. Sky owns its overlay and input enforcement; CodexHost does not draw a replacement overlay.
- The Mac bridge depends on an installed private Sky transport contract. Windows and Linux use the MCP notification path and require their own live acceptance checks.

## Verification

Focused native MCP tests cover notification payloads, connection reuse, hidden-tool admission, turn metadata, Mac bridge ordering, missing tools, protocol errors, and timeout. Live Mac contract probes use Clock and verify that Sky rejects a read in an ended turn with “Computer Use is unavailable because the current turn ended.” JavaScript bindings remain available after release.

The full patched-Grok Clock-through-ACP check and visible overlay disappearance remain pending: Sky reported that the user explicitly stopped Computer Use during live verification. The direct native contract check proves that ended-turn control is rejected, but does not by itself prove the full ACP path or overlay disappearance.

Session-specific build and ACP acceptance evidence is recorded in the wiki work item `projects/codex/work/2026-10-21-grok-computer-use-release/`.
