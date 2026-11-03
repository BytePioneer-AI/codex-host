# CodexHost TRAE CN Bridge

Connects CodexHost to the native Agent bundled with domestic TRAE CN Desktop. It reuses Desktop authentication and native conversation models. Independent Trae CLI login is not used.

This integration is in development and currently verified on Windows TRAE CN 3.4.12. Its private native IPC may change between application versions. Installing this extension alone does not install the separate CodexHost Harness plugin.

Build the VSIX from the repository root:

```sh
npm run build:companion --workspace=@codexhost/adapter-trae-cn
```

In TRAE CN, open Extensions and choose **Install from VSIX...**, then select the generated `packages/adapters/trae-cn/dist/trae-cn-bridge.vsix`. Reload the TRAE CN window if prompted. Sign in inside TRAE CN and keep the target workspace open and trusted. Only install the extension in domestic TRAE CN; other products are rejected during activation.

The Bridge listens on authenticated loopback HTTP, with private discovery metadata in `~/.codexhost/native-bridges/trae-cn`. Desktop login tokens remain inside its extension host; the local Bridge token grants access to the Agent in trusted workspaces. Do not share the discovery files. Workspace trust is checked before native operations.

Use **CodexHost: Restart TRAE CN Bridge** in the command palette if the connection needs refreshing. Restarting the Bridge can interrupt its native connection; finish or cancel active work first. Closing a CodexHost observer leaves native execution running. Explicit task cancellation is separate.

Companion 0.1.1 reads complete native file changes from the message snapshot after execution. It does not infer a Diff from the empty file bodies in streamed tool parameters. Install the matching VSIX when upgrading the Harness plugin; older Companions cannot provide these snapshots. File content above 2 MiB per native message is rejected explicitly.

Companion 0.1.2 also exports the native numeric context counters. The Harness reports context occupancy only: this Desktop version's stored counters describe the latest model request and do not establish cumulative Session token consumption or cost. Missing usage stays unknown; refreshing it does not start a model Turn.

Companion 0.1.3 exposes native same-workspace text-history forks and the Desktop feature flags. The Harness validates exact prefixes and keeps the source unchanged when forking or rolling back a Turn. TRAE CN 3.4.12 does not copy the file snapshot tags, so file-edit forks and rollbacks retaining a nonempty file-edit prefix are explicitly unavailable. A sole file-edit Turn can be removed by opening a separate empty Session. History rollback leaves workspace files unchanged.

Companion 0.1.4 prepares model configuration for the next native request using the refreshed conversation catalog and the same DTO as Desktop. Model selection does not submit a Prompt or change global preferences. An already accepted Turn retains its model; saved next-request selections are validated again on resume, and historical Turns retain their actual models. Install the matching VSIX to enable this capability.

Companion 0.1.6 supports next-request Thinking selection using the account and model's validated native policy. Opaque choices belong to one native model and request field; unsupported or mismatched choices are rejected before a message is sent. An accepted Turn retains its captured choice, while saved future selections are prepared again on resume. Native MiniMax-M3.1-Flash Light/High requests, cold restoration, and configuration preservation over text Fork/Rollback have been verified. No synthetic levels or implicit model defaults are added.

Companion 0.1.7 also reads the local domestic app's permission menu, feature switches, native default and custom-profile availability. Permission choices affect the next request and are sent in both native policy fields without writing global rules. Accepted requests keep their captured choice; saved Host selections are validated again on resume. Native history does not store this setting, so the bridge does not infer it from old messages. Remote and enterprise permission selection remain unavailable. Native rules decide when an approval is needed; selecting a permission mode is separate from unattended execution, which is still explicitly rejected.

[Source and integration details](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/harnesses/trae-cn/trae-cn-desktop-integration.md)

Companion 0.1.8 advertises file/MCP confirmation support explicitly. File allow decisions use the native event's tool-call identity; command/MCP decisions use the tool name, and legacy confirmations omit new permission scopes. Only allow-once and deny are offered. Edit allow/deny, unchanged global rules, native diffs and cold recovery were verified on 3.4.12. MCP and deletion confirmation formats have source-backed tests but no live approval acceptance yet. The plugin omits replacement-text arguments that native Edit clears after execution, retaining stable paths and actual snapshot diffs. Version 3.4.13 has separately passed bridge/catalog/history read-only compatibility; this is not inference acceptance.

Companion 0.1.9 observes native RunCommand background results through the owning Session, original message, Plan, tool-call and command identities. It returns actual command output and exit status rather than a launch receipt. The Harness keeps the detached Item alive after its parent Turn, allows later foreground chat and prevents idle release while observing commands. Closing observation does not cancel native execution. Cold restoration during a still-running background command returns sessionBusy; terminal history can be restored. The output window is 16,384 characters and retained background execution identities cannot be forked. Native 3.4.13 rejects poll_pending_wakeups, so autonomous wakeups are not advertised or simulated. Real isolated Host acceptance covered delayed completion, a later chat, history overlay and exact cold reads after rebuilding the development Bridge. This does not deploy the extension or API 2 Host to the user's daily window.

Companion 0.1.10 reads terminal DeleteFile/delete_file message snapshots even when native results omit can_show_diff. Only the absent side of an added/deleted document may be null; all other missing content remains an error. Real workspace deletion history restores its full deletion diff across processes. Delete approvals also passed real allow-once/deny and cold-read checks with dedicated external files and unchanged global permissions. Native snapshots returned no diff for those external files, so only their tool results are preserved; history is never reconstructed from the current filesystem. Live MCP approval acceptance and daily Desktop deployment remain pending.

Companion 0.1.11 adds **CodexHost TRAE CN: Native Agent** in TRAE CN settings (`codexhost.traeCn.nativeAgent`). Builder remains the default; choose SOLO Agent to use its separate conversation model pool and native MCP tools. Finish active work before running **CodexHost: Restart TRAE CN Bridge**. Saved Sessions require their original native Agent; a mismatch returns a configuration error instead of changing the Session.

MCP execution callbacks must match an observed native Session, message, tool-call, loaded server/tool, arguments and workspace. Execution is reserved once before calling the application; pending approval, completed, stale, duplicate or foreign callbacks are rejected. Other executable desktop commands remain unavailable. TRAE CN 3.4.14 / SOLO passed one actual Echo MCP execution, exact history recovery after reopening the Bridge, unchanged global permissions and source-hash verification. The native policy did not require an extra approval in that case; live MCP allow/deny and resource-read acceptance remain pending.
