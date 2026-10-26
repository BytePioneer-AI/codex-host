# Devin CLI Harness

Devin runs as an independent Harness through codexhost's public Harness plugin
contract. The adapter lives in `packages/adapters/devin/` and is loaded through
the dynamic plugin Loader like every other plugin; Host Runtime, Protocol Core
and Renderer do not import it. See the [capability inventory](../../../packages/adapters/devin/CAPABILITIES.md)
for implementation evidence and outstanding validation.

## Transport choice

The adapter launches `devin acp` and uses the official ACP SDK over stdio. This
preserves Devin's own stored authentication (`devin auth login`), native tools
and permission requests. Devin-specific translation remains inside
`@codexhost/adapter-devin`. For the explicit ACP authentication handshake, the
plugin reads `CODEXHOST_DEVIN_API_KEY`, then `DEVIN_API_KEY`, or the
`windsurf_api_key` field in Devin's `credentials.toml` under
`${XDG_DATA_HOME:-~/.local/share}/devin`. It passes that key to the local Devin
process without copying it to Host storage or implicitly opening browser login.

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
  the session's native catalog. Selection during an active Turn goes directly
  to the native configuration interface; Devin determines when it takes effect.
  Native rejection or missing confirmation leaves Host state unchanged. Parallel
  configuration writes and history reads remain mutually exclusive; a second
  Turn and permission-mode changes remain blocked during an active Turn.
- Native permission modes, confirmed by the ACP configuration response before
  Host state changes. Unsupported or unconfirmed values fail closed. Creating
  with `unattended-full-access` selects and confirms native `bypass`; an explicit
  non-bypass permission mode is rejected before opening native resources.
- Native permission requests surface as Host Approval interactions with exact
  correlation, response validation and cancellation cleanup.
- Structured `fileChange` Items for tools carrying native ACP diff content, in
  live output and history replay.
- Read-only snapshots reconstructed from the native `session/load` replay, with
  strict native turn identity checks (see below).
- Command resolution uses the shared `harness-discovery` mechanism;
  `CODEXHOST_DEVIN_COMMAND` selects an explicit executable. No polling timers,
  provider substitution or Codex fallback.
- Native session import through `session/list` on a sessionless probe
  connection (`initialize` only, no user Session is created). Rows missing a
  valid `cwd` or `updatedAt` are skipped rather than fabricated; `running`
  reflects the native `cognition.ai/isLocked` meta flag when present.

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

## History derivation

`history.fork`, `forkAcrossCwd` and `rollbackLastTurn` remain **false**.
Both derivation open branches return `unsupported` before starting a transport;
replayed Turn identities are not published as checkpoints. This is an unverified
integration boundary, not a claim that native Devin lacks Fork.

### Official evidence and protocol gaps

- [Commands & Flags](https://docs.devin.ai/cli/reference/commands#session-management)
  documents interactive `/fork [step]` (a new Session), `/steps`, and
  `/revert <step>` (rewind to **before** that step **and revert file changes**).
  It does not specify whether `/fork [step]` includes the selected step, step
  identity persistence, or machine-readable results. `/revert` cannot implement
  Host rollback, even on a copied Session: the workspace would still be changed.
- The [stable changelog](https://docs.devin.ai/cli/changelog/stable),
  v3000.4.16, says `/fork` defaults to the latest step and ACP revert can cancel
  an active Turn. Completed `ask_user_question` prompts also become steps.
  Another entry documents steps surviving compaction. A step therefore cannot
  be assumed to equal a user Turn, replay index, or the existing
  `cognition.ai/clientMessageId` / `userMessageId` identity.
- The commands reference identifies `devin acp` as the stdio JSON-RPC entry
  point. [ACP slash commands](https://agentclientprotocol.com/protocol/slash-commands)
  defines command discovery via `available_commands_update` and invocation as
  text in `session/prompt`. However, Devin's documented ACP command table does
  not explicitly list `/fork`, `/steps` or `/revert`. Neither that table nor the
  changelog defines their request extensions, completion payloads, new-session
  routing or a no-inference guarantee. Sending guessed slash text through the
  ordinary prompt path is not a safe capability probe.
- The pinned `@agentclientprotocol/sdk` **1.3.0** exposes experimental
  `ClientSideConnection.unstable_forkSession` (`session/fork`). Its
  `ForkSessionRequest` has `sessionId`, `cwd`, optional `additionalDirectories`,
  `mcpServers` and opaque `_meta`; **no step/checkpoint boundary field**.
  `ForkSessionResponse` has a new `sessionId` and optional `modes` / `configOptions`;
  it proves neither the retained prefix nor configuration preservation. See
  `dist/schema/types.gen.d.ts` and `dist/acp.d.ts` in the installed SDK.
  SDK method availability is not Devin support; even advertised whole-session
  Fork would not establish exact middle-Turn Fork or rollback. No `_meta` key or
  command output parser is inferred from these types.

The fetched Devin documentation matches the supplied documentation copies;
no native history derivation was executed. The existing real-run record above
does not cover derivation. `test/history.test.ts` covers the disabled gates and
checkpoint omission, not successful native Fork or rollback.

### Evidence required from the PR author

Read-only discovery can start with `devin --version`, `devin --help` and an ACP
`initialize` exchange only, followed by closing the process. Do not create a
Session, authenticate through a captured request, submit a prompt or invoke an
experimental method merely to discover support. Return the CLI/SDK versions,
platform, advertised session capabilities and any official history API reference.
Missing advertisement is not proof that every CLI surface lacks the capability.

Exact-boundary acceptance requires an explicitly authorized **disposable**
workspace and synthetic native history. The author must first establish the
supported invocation and whether it can trigger inference; unknown commands
must not be tried against real sessions or a paid model. `/steps` via
`session/prompt` is not assumed read-only. No `/revert`, database editing, prompt
replay, summary reconstruction or destructive cleanup is part of this plan.

Return redacted request/response/notification traces for the supported path,
including errors. Omit authentication payloads, credentials, account data,
private prompts, tool contents and real paths. Replace session/step/message IDs
consistently so equality and boundary relationships remain verifiable; retain
method names, field names, value types, ordering and selected synthetic content.
The evidence must establish:

| Case | Required result |
| --- | --- |
| Boundary identity | Native step discovery and exact mapping to completed logical Turns; before/after semantics, tool/question steps and compaction; no guessed IDs or positions. |
| Middle and tail Fork | A different, independently resumable/writable native Session; its replay exactly equals the requested Turn prefix, including input and Items, not just the Turn count. No command bookkeeping Turn or duplicated context. |
| Source and workspace isolation | Source replay remains identical before/after success and failure; workspace file bytes, path set and relevant metadata remain unchanged, including unrelated dirty files and newly created files. |
| Rollback | Fork to before the last complete Turn; exactly one fewer logical Turn. Multi-Turn, single-Turn to persistently empty/continuable Session, and empty-history rejection. |
| Configuration | Model, Thinking and Permission Mode supplied to rollback are natively confirmed on the child, even when different from the retained historical settings; no work starts before confirmation. Missing/unsupported confirmation fails closed. |
| Invalid/busy cases | Foreign Harness/Session checkpoint, missing/stale boundary and active Turn are rejected without source mutation; cancellation/incomplete history is not guessed into a complete Turn. |
| Routing and failure | Child identity and notification routing, same-process source lock behavior, close/reopen persistence, native failure and resource cleanup. Report orphan child Sessions if safe cleanup is unavailable; never delete the source. |
| Cross-cwd (only if advertised) | Native confirmation of the child's target cwd, not just the subprocess cwd; inherited history still matches the exact prefix. |

Continuation may use author-provided existing traces; any new model execution
requires separate explicit authorization. None was performed locally. Pi's
`pi-history.ts`, `pi-last-turn-rollback.ts` and corresponding Adapter/history
tests inform these invariants only; its Entry IDs, RPC commands and native file
format are not Devin protocol evidence.

## Current limitations

- Desktop discovery, icons and installation links use the dynamic plugin
  catalog and shared route. There is no Devin-specific Host or Renderer branch.
- Fork, rollback, steering, independent thinking selection, usage/account reporting,
  native session deletion wiring and subagent transcript browsing are
  not advertised. `devin auth status` exposes identity and plan but no valid
  usage percentage, so no `inspectAccount()` credits are fabricated. Image
  prompt input is outside the current Host text contract.
- Devin-specific `_meta` extensions beyond the identity and tool-name keys
  (slash commands, embedded context payloads) are not surfaced.
- Model inspection opens one empty native ACP session per cache refresh because
  the catalog is returned by `session/new`; it submits no prompt.

## Brand assets

`assets/icon.svg` carries the official Devin mark on a dark plate, and the
Renderer picker uses the same mark as `currentColor` artwork. The Devin name
and marks remain the property of Cognition AI, Inc.
