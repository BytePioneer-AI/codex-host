# Devin CLI Harness

Devin runs as an independent Harness through codexhost's public Harness plugin
contract. The adapter lives in `packages/adapters/devin/` and is loaded through
the dynamic plugin Loader like every other plugin; Host Runtime, Protocol Core
and Renderer do not import it.

## Transport choice

The adapter launches `devin acp` and uses the official ACP SDK over stdio. This
preserves Devin's own stored authentication (`devin auth login`), native tools
and permission requests. Devin-specific translation remains inside
`@codexhost/adapter-devin`. The plugin never reads or copies user credentials.

`devin acp` (CLI `3000.10.31`) reports `protocolVersion: 1` with
`agentCapabilities.loadSession: true`, image prompt support, and session
capabilities for `list`, `delete` and `additionalDirectories`. A single
`session/new` response exposes the full native configuration surface: the model
catalog (385 entries when tested) and the permission modes `accept-edits`,
`smart`, `ask`, `plan` and `bypass`.

## Implemented boundary

- Native create, resume, text prompt, streaming text/reasoning, tool progress
  and cancellation.
- Dynamic native model catalog. Native model values are encoded into
  transport-safe opaque Host refs (`devin.<base64url>`) without losing the
  original value; `model.select` resolves them back and rejects models outside
  the session's native catalog.
- Native permission modes, confirmed by the ACP configuration response before
  Host state changes. Unsupported or unconfirmed values fail closed.
- Native permission requests surface as Host Approval interactions with exact
  correlation, response validation and cancellation cleanup.
- Structured `fileChange` Items for tools carrying native ACP diff content, in
  live output and history replay.
- Read-only snapshots reconstructed from the native `session/load` replay, with
  strict native turn identity checks (see below).
- Command resolution uses the shared `harness-discovery` mechanism;
  `CODEXHOST_DEVIN_COMMAND` selects an explicit executable. No polling timers,
  provider substitution or Codex fallback.

## Turn identity

Devin emits a UUID-like native turn identity: the prompt response carries
`_meta["cognition.ai/userMessageId"]` and the `session/load` replay groups user
message chunks by `_meta["cognition.ai/clientMessageId"]` on the same value. A
successful turn must establish exactly one such ID; missing or ambiguous
identity prevents the adapter from claiming a successful terminal state and
never fabricates turn keys from positions or text hashes.

Devin locks a native session to one `devin acp` process: `session/load` for a
session that is already open elsewhere fails with "already open in another
process". `readSnapshot()` therefore re-replays history through the session's
own connection instead of spawning a second process, and a cross-process resume
must close the first adapter before opening the same native session again.

A real end-to-end run on macOS (CLI `3000.10.31`, pre-authenticated, model
`swe-2-high`, mode `accept-edits`) verified plugin load through the actual
Loader, inspect, create, a successful turn, a live snapshot, and a fresh-process
resume whose replayed `nativeTurnRef.nativeTurnKey` exactly matched the live
turn's. Cancellation persistence across reload and compacted histories have not
been established.

## Current limitations

- Devin is wired into the Desktop picker through the existing static Renderer
  lists (agent selection state, route construction, binding probe, sidebar
  icons, Connections install link and the production `enabledAgents` list).
  There is no Devin-specific Host branch; the Thread rides the shared
  plugin route like the other plugin Harnesses.
- Fork, rollback, independent thinking selection, usage/account reporting,
  native session import/deletion wiring and subagent transcript browsing are
  not advertised. Image prompt input is outside the current Host text contract.
- Devin-specific `_meta` extensions beyond the identity and tool-name keys
  (slash commands, embedded context payloads) are not surfaced.
- Model inspection opens one empty native ACP session per cache refresh because
  the catalog is returned by `session/new`; it submits no prompt.

## Brand assets

`assets/icon.svg` is a locally drawn placeholder spiral on a dark plate. It is
not the official Devin or Cognition mark; replace it with licensed artwork
before a branded release. The Devin name and marks remain the property of
Cognition AI, Inc.
