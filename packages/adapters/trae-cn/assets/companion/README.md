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

[Source and integration details](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/harnesses/trae-cn/trae-cn-desktop-integration.md)
