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
  Native rejection does not publish the requested value; a complete native
  readback publishes the actual state even when it differs from the request.
  Parallel configuration writes and history reads remain mutually exclusive; a second
  Turn and permission-mode changes remain blocked during an active Turn.
- Independent Thinking selection when ACP advertises a `thought_level` select
  option. Inspect and Session state use its native values, labels and current
  value; model-dependent options are replaced after every native configuration
  response or notification. Idle and active-Turn selection use the same native
  interface without cancelling or restarting the Turn.
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

## Thinking configuration

[Devin v3000.11.1](https://docs.devin.ai/cli/changelog/stable) adds ACP model,
thinking effort and speed controls. The [Models guide](https://docs.devin.ai/cli/models)
describes model-dependent reasoning levels; wire fields follow
[ACP Session Config Options](https://agentclientprotocol.com/protocol/session-config-options).

- Discover the first `type: "select"`, `category: "thought_level"` entry in
  `configOptions`. Missing/unknown categories, `model_config` speed options,
  selector names/IDs and Model suffixes do not establish Thinking support.
  No usable selector means false capability and typed `unsupported`.
- Preserve native labels and grouped values. Host IDs encode
  `devin.<base64url(native value)>`; writes use the advertised selector `id`
  and original `value` as `session/set_config_option`'s `configId`/`value`.
- Complete responses, `config_option_update` notifications and reloads replace
  effective state and available options. Selector removal clears Thinking;
  Model changes never replay old Thinking. Per-Model restrictions describe only
  the observed active Model. A missing mode selector preserves the latest
  native-confirmed permission mode. Faulted or closed reloads fail snapshot reads.
- Create/resume hints apply Model first, then validate Thinking against its
  returned options. Omitted hints preserve native state; stale or unconfirmed
  hints fail opening and close the transport. Model discovery uses category
  `model`, with the observed legacy `id: "model"` fallback.

Coverage is hermetic, including synthetic ACP processes, not native Thinking
acceptance. Actual Devin fields, idle/running selection, Model-dependent options
and cold resume with/without hints still require an authenticated CLI with this
feature; the `3000.10.31` run below predates it.

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

Fork and `rollbackLastTurn` are implemented through the native revert extension.
They are advertised only when initialization confirms `loadSession` and all three
agent `_meta` flags: `cognition.ai/revert`, `cognition.ai/revertHistoryRewound` and
`cognition.ai/revertByUserMessageId`. The client advertises
`_meta["cognition.ai/revert"]: true`. Older/unnegotiated agents return `unsupported`;
there is no account-free-probe gate that disables every real Fork.
`forkAcrossCwd` remains **false**.

### Runtime path and safety boundary

- `session/load` supplies the actual Turn IDs. Native
  `_cognition.ai/revert/listSteps({sessionId})` supplies step boundaries: only a
  unique `kind: "prompt"` step whose `userMessageId` equals the replayed Turn key
  becomes a checkpoint, using its native `stepId`. Missing mappings have no
  checkpoint; ambiguous/malformed mappings fail. Tool/question steps, positions,
  prompt text and hashes never manufacture a boundary. Live terminal checkpoints
  use the same mapping. An optional discovery RPC/schema error leaves a healthy
  Session usable without a checkpoint or any change to the settled Turn outcome.
  Actual transport failure (including process exit or a timeout that closes it)
  still reports a Session fault.
- Fork calls only `_cognition.ai/revert/forkFromStep({sessionId, stepId})` and
  requires a nonempty `forkedSessionId` different from the source. A new transport
  loads that exact ID. `session/list` must confirm the requested cwd for both
  source and child; a known live source in another cwd is rejected. An unavailable
  cwd confirmation fails rather than treating process cwd as native proof.
- Before success, the child is read back through `session/load` and `listSteps`.
  Both its full projected Turns (including native user IDs, inputs and Items) and
  native transcript update payloads must equal the requested inclusive prefix.
  Only Session routing/checkpoints and session-level config/mode/catalog/usage
  updates are excluded from equality. The source is read again and must remain
  unchanged. Active Turns/configuration/history operations are mutually exclusive
  on a live source; a cold source uses its own temporary load connection and
  verifies its native cwd **before** loading (load must not silently relocate it).
- Multi-Turn rollback forks at the preceding Turn's checkpoint. Single-Turn
  rollback creates a distinct `session/new`, then loads it to verify empty history
  and a usable identity; empty-source rollback returns `invalidState`. The child
  receives the supplied Model, Thinking and Permission Mode in that order, with
  native acknowledgements and a final combined-state check. Source configuration
  is not written. Every transport receives this open's environment overrides.
- No prompt replay, summary, database copy, standard `session/fork`, slash command,
  `execute`, `resume` extension or file undo is used. In particular `/revert` is
  not Host rollback. There are no speculative alternative RPCs on failure.
- Failed children and temporary source transports are closed. If releasing a
  temporary source fails after derivation, its child is closed before returning
  failure; cleanup errors do not replace the original derivation error. Safe native deletion
  is not wired: once a child ID is known, failure reports that its persistent data
  may remain on disk. Source data is never deleted or intentionally rewound.

### Evidence versus assumptions (3000.11.205)

The official macOS arm64 archive has manifest SHA-256
`d80c39678dc3ac6b62c25c1864ba6881086b4eeaadf9a3e3a4e86a30b41423df`.
The supplied `/tmp/devin-native-probe.vYP85R` evidence and independent
`/tmp/devin-history-independent-0hrvtq73.json` / `-stderr.txt` confirm negotiation,
not a successful mutation. The archive and raw local probe files are not repository fixtures.

| Evidence level | Established facts / assumptions |
| --- | --- |
| Unauthenticated native observation | The three extension flags are negotiated. Wire methods require the leading `_`. `listSteps({sessionId})` and `preview({sessionId,userMessageId:string})` or `preview({sessionId,stepId:string})` parse, then fail because the synthetic Session is inactive. Standard `session/fork` is not advertised. |
| Official binary symbols, not successful responses | `RevertListStepsResponse`, `RevertStepInfo` with `stepId`, `stepNumber`, `userMessageId`, `toolCallId`, `questionNodeId`, `revertTargetNodeId`, `forkTargetNodeId`, `summary`; step kinds `prompt` / `questionAnswer`; `RevertForkFromStepParams/Response`, `forkedSessionId`, `execute`, `resume`, `preview`, `skipFileUndo`. |
| Implemented, pending author native verification | `listSteps` returns `{steps:[{kind,stepId,userMessageId,...}]}`; prompt IDs match ACP replay IDs; `forkFromStep` accepts `{sessionId,stepId}` and retains the **complete inclusive Turn** at that prompt's fork target, without changing workspace files or source history. |
| Implemented, pending author native verification | The returned child can be loaded/continued independently with preserved user IDs and transcript payloads; `session/list` reports its cwd; single-Turn `session/new` plus load yields a durable empty writable Session; Model/Thinking/permissions can be confirmed on that child. |
| Hermetic validation only | Mock regression and `test/fixtures/history-acp.mjs` synthetic stdio ACP exercise the implementation under these assumptions. They are not captured successful native traces. A native schema or boundary mismatch fails explicitly at runtime, not as fabricated success. |

No real Devin process, credential access or paid model execution is required by
these tests. Native mutation/file-preservation/persistence validation remains for
the author; it is not a prerequisite gate for enabling the negotiated code path.

### Native follow-up acceptance

Return CLI/SDK versions, platform, advertised capabilities and redacted native
request/response/notification traces proving:

- Supported invocation, step-to-Turn mapping and inclusive/exclusive boundaries,
  including question/tool steps and compacted history.
- Middle/tail Fork into a distinct, resumable/writable Session with exactly the
  retained prefix; source history and workspace files stay unchanged.
- Rollback removes one complete Turn, preserves current Model/Thinking/Permission
  Mode, handles single-Turn to persistent empty Session, and rejects empty history.
- Invalid/stale checkpoints, active Turns and native failures leave the source
  intact; child routing, restart persistence and resource cleanup are verified.
  Cross-cwd support additionally requires native confirmation of the target cwd.

Use explicitly authorized disposable workspaces and synthetic history; establish
whether the invocation triggers inference before executing it. Unknown slash
commands, including `/steps` via `session/prompt`, are not read-only probes.
Paid model execution requires separate authorization. Remove credentials,
authentication payloads, account data, private content and real paths from traces;
pseudonymize IDs consistently while retaining field names, types and ordering.

## Current limitations

- Desktop discovery, icons and installation links use the dynamic plugin
  catalog and shared route. There is no Devin-specific Host or Renderer branch.
- Steering, speed selection, usage/account reporting,
  native session deletion wiring and subagent transcript browsing are
  not advertised. `devin auth status` exposes identity and plan but no valid
  usage percentage, so no `inspectAccount()` credits are fabricated. Image
  prompt input is outside the current Host text contract.
- Devin-specific extensions outside identity/tool metadata and the negotiated
  native history path (slash commands, embedded context payloads) are not surfaced.
- Model inspection opens one empty native ACP session per cache refresh because
  the catalog is returned by `session/new`; it submits no prompt.

## Brand assets

`assets/icon.svg` carries the official Devin mark on a dark plate, and the
Renderer picker uses the same mark as `currentColor` artwork. The Devin name
and marks remain the property of Cognition AI, Inc.
