# Experimental Cursor CLI Harness

Cursor can execute native CLI sessions through codexhost's public Harness plugin
contract. This package remains experimental. The preinstalled distribution
connects it to the Desktop Agent
Picker, configuration preferences, sidebar ownership and Connections page. Live
Desktop adoption remains separate from packaging and Host protocol validation.

## Transport choice

The adapter launches `cursor-agent acp` and uses the official ACP SDK over stdio.
This preserves Cursor's existing CLI authentication, native tools and interactive
approval requests. Cursor-specific translation remains inside `adapter-cursor-cli`.
Host Runtime, Protocol Core and Renderer do not import the adapter.

The [TypeScript SDK](https://cursor.com/docs/sdk/typescript) is suitable for
headless runs, but its local execution model does not offer the same interactive
approval round trip. The [SDK Bridge](https://cursor.com/docs/sdk/bridge) embeds
that SDK for other languages and would add another server to this TypeScript
integration. [CLI ACP](https://cursor.com/docs/cli/acp) is the selected interface.

## Implemented boundary

- Native create, text prompt, streaming text/reasoning, tool progress and cancellation.
- Structured Edit Diff for successful tools carrying native ACP diff content,
  including new files and updates, in live output and native history replay.
- Dynamic native parameterized model catalog and Thinking selection. Native
  `thought_level` parameters become complete selectable combinations (for example,
  thinking on/off plus effort); unrelated context/fast parameters stay in Model refs.
- Native advertised slash commands and skills through ACP `available_commands_update`.
  Custom commands keep normal Turn identity; `/copy-request-id` can complete without
  creating a native user Turn.
- Outbound cross-Harness delegation through a session-local native MCP server,
  enabled only when the Host supplies all four delegation environment variables.
- Native Agent, Plan and Ask configuration, confirmed by the ACP response before
  changing Host state. These are execution modes, not fabricated approval levels.
- Delegated `unattended-full-access` through the native `--force` Run Everything
  request, recorded in the Native Session Ref locator and reused by resume and by
  derived Fork/rollback Sessions. ACP still confirms no effective policy, so a Turn
  that receives a native approval or plan request is cancelled and failed instead.
- Native tool approvals and Cursor's blocking question/plan extensions, with
  exact interaction correlation, response validation and cancellation cleanup.
- Session resume and read-only snapshots, with strict native turn identity checks.
- Historical and tail Fork, plus revision of the last turn, on macOS/Linux using
  native CLI `/fork` and conversation-only `/rewind`, followed by ACP resume.
  Historical boundaries require native rewind anchors.
- Negative discovery caching and bounded startup/configuration/close. There is no
  background discovery polling, automatic provider substitution or Codex fallback.
- Direct Windows bundle invocation avoids leaving a PowerShell/cmd launcher owner
  in between Host and the ACP process. Configuration may select an executable via
  `CODEXHOST_CURSOR_COMMAND`. User authentication is never copied into the plugin.

## Experimental history gate

The tested Cursor CLI `2026.09.08-6caf4ff` emits no persistent user-turn ID in either
ACP prompt completion or replay. The prototype reads only user-turn identity and
prompt text from its native `~/.cursor/acp-sessions/<id>/store.db`, using a read-only
SQLite connection. A small bounded decoder follows the observed native root/turn
references. This is an undocumented native format, not a supported Cursor API.

The snapshot body comes from native ACP `session/load` and is reused only while the
native history root is unchanged. It is accepted only
when session, workspace, turn count, order and exact prompt text match native
history. A successful live turn must introduce exactly one native user-turn ID.
Missing/ambiguous history is an error; generated UUIDs, array positions and text
hashes are never used as native turn keys. The adapter keeps no shadow transcript.

The real Windows restart smoke demonstrates that completed turn IDs remain equal
after the adapter process is replaced, and a follow-up retains earlier context.
This does not establish compatibility with other Cursor versions, compacted
histories, externally modified sessions or every tool payload.

Cursor can cancel before persisting a native turn. In that case the cancelled
terminal intentionally has no `nativeTurnRef`. ACP history also omits historical
stop reasons, so snapshot outcomes are `unknown`. Do not infer a historical success
from the presence of assistant text. Cancellation persistence needs further native
contract investigation before release acceptance.

## Current limitations

- The Desktop Agent Picker is still based on a static Harness list. This integration
  adds Cursor explicitly and uses the shared plugin carrier. Its independent model
  and mode preferences do not inherit another Harness's Thinking selection.
- Context compaction, usage/account reporting and native session import are not
  advertised. Historical Fork/revision require the native CLI bridge described below.
  Inbound unattended delegation is a native Run Everything request, not an
  ACP-confirmed approval policy. Image/audio prompt inputs are outside the current Host
  text contract.
- Edit Diff is partial: it requires native ACP diff content. Delete/rename semantics,
  shell edits and missing historical diffs are not inferred. Other Cursor notification
  extensions are not all implemented.
- Model inspection opens one empty native ACP session per cache refresh because
  the catalog is returned by `session/new`. It submits no model prompt. Both
  successful and failed inspection results are cached per working directory without
  time-based expiry, until explicit refresh or Adapter shutdown. Concurrent checks,
  including refresh requests, reuse an in-flight inspection.
- The native history format and operating-system authentication behavior require
  platform/version acceptance before formal product support is claimed.

## Native CLI Fork bridge

Fork retains history through the selected turn in the same workspace. Historical
boundaries require a native rewind anchor on the first user turn to discard;
the current last turn can be copied without rewind. Snapshots expose checkpoints
for these boundaries. Previously saved tail checkpoints remain valid after the
source advances if the boundary has a native rewind anchor.

Editing the previous message uses the same derivation transaction to discard the
last complete turn, including the single-turn case that leaves an empty writable
session. Empty history is rejected. Current model, thinking and permission selections
are applied before adoption. The source is locked against concurrent Host turns and
configuration changes throughout the operation.

The adapter uses SQLite's backup API to stage the ACP database in a private temporary
CLI configuration directory. CLI and ACP use the same store representation: no
messages or blob contents are rewritten. The CLI workspace key hashes the resolved
working directory. The native CLI runs `/fork` in a PTY provided by `/usr/bin/script`;
Enter is sent only after its command menu advertises the native Fork action. The
new identity and metadata are produced by Cursor itself. For a historical boundary,
the same CLI process runs `/rewind` and explicitly selects **Restore conversation**,
never file restoration. Rewind is enabled only in the private temporary CLI config.
The adapter checks that the persisted root is exactly the target's native pre-turn
anchor and that the source blob contents are preserved, copies the result to the ACP
store, then verifies the exact retained turn IDs/text and ACP replay before adoption.
A changed menu, missing anchor, wrong boundary or replay mismatch fails the operation
and discards the owned copy. The adapter never writes a synthetic root or transcript.

The target ACP process starts and authenticates concurrently with CLI staging; it
loads the derived session only after the CLI transaction succeeds. Both operations
are joined before cleanup, and failure or cancellation closes the owned ACP process
and cancels staging. An active source can supply its full model parameter catalog
when the effective environment is identical and the target's freshly loaded model
IDs and labels match. Otherwise the target fetches a fresh catalog. Live selection
and current-model configuration always come from the target's native load response;
this reuse is limited to derivation, not a global account cache. Cursor's internal
model queries during authentication/load are unchanged.

Snapshot reads reuse the validated ACP replay while the native content-addressed
history root remains unchanged. A changed root (including changes without a new user
turn) or a new local turn invalidates reuse. Resume seeds the cache only when the
root is identical before and after ACP load; cache misses validate the root across
replay as well. Returned snapshots are copied and carry current configuration state.
Read-only replay skips the account model catalog. Configuration restoration sends
only values that differ from the latest native-confirmed configuration, checking
after each response because model selection can reset other parameters.

Source databases remain read-only. CLI settings are temporarily copied to preserve
native authentication/network configuration; staging is private and removed on
success, failure or normal cancellation. Failed ACP adoption removes only the new
target owned by the operation. No temporary CLI session is added to the user's
normal CLI chat directory. Abrupt Host termination can leave its temporary staging
directory, as with other interrupted filesystem operations.

This bridge depends on Cursor's native store layout and interactive command output,
not an ACP Fork API. Unknown output or incompatible storage fails the operation;
there is no version equality gate or fallback that submits a synthetic history
prompt. Windows Fork/revision is not advertised because this adapter has no Windows PTY
runner. macOS/Linux require `/usr/bin/script`.

The opt-in smoke exercises real model calls in an isolated store:

```sh
npx tsc -b packages/adapters/cursor-cli
node tools/cursor-fork-smoke.mjs
```

It checks historical and tail Fork, tool/child history replay, continuation, multi-turn
and single-turn revision, empty-history rejection, a new child under the fork,
fresh-process recovery, source/file preservation and final session count.
Set `CURSOR_FORK_PLUGIN_ROOT` to an independently built plugin directory to run
the same checks through the public Loader. The native bridge has been exercised
on macOS arm64 with Cursor `2026.09.15-d2fe57e`; Linux has not been tested live here.

## Capability audit and native configuration

The capability audit used macOS arm64 Cursor CLI `2026.09.10-fd3934a` and the
[official ACP documentation](https://cursor.com/docs/cli/acp). The installed CLI's
`src/acp/cursor-acp-agent.ts` and `src/acp/agent-session.ts` establish the additional
parameterized configuration and command behavior below; these are version-sensitive
native extensions, not fabricated RPC methods.

| Gap | Native interface and current result |
| --- | --- |
| Thinking | `initialize.clientCapabilities._meta.parameterizedModelPicker = true`, `cursor/list_available_models`, and `session/set_config_option`; implemented. |
| Slash commands | `available_commands_update` plus native `session/prompt` slash parsing; implemented for advertised commands only. |
| Cross-Harness collaboration | Native HTTP MCP passed to `session/new` / `session/load`; outbound tools implemented. Inbound unattended execution requests native `--force` Run Everything without claiming ACP policy confirmation. |
| Usage | The native ACP agent emits neither usage updates nor prompt usage; remains unknown. Shared SDK schemas alone are not evidence that Cursor emits these fields. |
| Fork / edit previous message | ACP has no Fork or rollback operation. A native CLI `/fork` + conversation-only `/rewind` bridge supports historical Fork and edit previous message on macOS/Linux at available native anchors. |
| Context compaction | The interactive CLI command is not part of the ACP slash-command handler; no native ACP compaction operation is implemented. Sending `/compact` as plain model text is not compaction. |

The model catalog comes from native configuration, including each model's own
Thinking parameter choices. Multiple `thought_level` parameters remain a complete
combination instead of silently dropping the thinking toggle when effort also
exists. Selecting a combination writes only those native parameters, confirms each
response, and publishes the actual state after each write. A later rejected write
leaves the already confirmed state visible. Model changes clear stale Thinking
when the new model lacks it; selecting Thinking remains permitted during an active
Turn, with native acceptance determining the result.

Opaque Model refs retain non-Thinking parameters such as `context` and `fast`, so
Host restart/reopen can restore them independently of Cursor's account-wide model
preferences. Earlier full bracketed refs are accepted only when every supplied
parameter/value remains selectable in native metadata. Unavailable/fixed parameters
that the current native catalog no longer exposes fail explicitly instead of being
discarded. Older CLI releases that ignore parameterized-picker negotiation keep
native variant selection and advertise no unsupported Thinking options.

Commands are accepted only from the native Session's latest advertised catalog.
The adapter forwards the original slash text and arguments to Cursor. It does not
reimplement command templates or pretend that interactive-only CLI commands exist
in ACP. The local `/copy-request-id` command can produce a successful terminal
without a `nativeTurnRef` when native history is unchanged; all ordinary command
turns still require the verified native user-turn identity.

The tested native `sendAvailableCommands` omits `input` for both custom commands
and `/copy-request-id`, although its custom-command parser accepts trailing text.
The plugin preserves that native behavior, honors an explicit `input: null` as
argument-free, and treats the administrative command as argument-free.

## Outbound delegation MCP bridge

The Cursor plugin uses the official MCP SDK to expose a loopback-only HTTP server
with a fresh bearer token for each writable Session. Native `mcpServers` injection
makes its descriptions and tools available to Cursor without changing the user's
project rules, global MCP settings, or prompts. The bridge is omitted from
inspection and history/subagent replay. It is recreated with the current Session
environment on resume and closed with the owning native transport.

The tools are `harness_list`, `harness_inspect`, `delegate_start`, `thread_send`,
`thread_read`, `thread_wait`, and `thread_cancel`. They invoke the exact absolute
`CODEXHOST_CLI_PATH` without a shell, preserve `CODEXHOST_RUNTIME_ENDPOINT`,
`CODEXHOST_RUNTIME_TOKEN`, and `CODEXHOST_THREAD_ID`, and use the Session cwd.
Native MCP approvals still apply. Tool schemas restrict CLI operations; waits are
limited to 60 seconds, CLI processes to 65 seconds, and captured output to 1 MiB.
Closing a Session terminates its owned CLI requests and removes its listener.
No bridge token or Host credential is persisted in a user configuration file.

This makes a normal Cursor Thread able to delegate outward and observe/follow up
on other Harnesses. A Host `unattended-full-access` request is carried into the
native ACP process as Cursor's own Run Everything request (`--force` before the
`acp` subcommand), persisted in the Native Session Ref locator, and reused by resume
and by derived Fork/rollback Sessions. The native `--force` path still checks team
policy and silently falls back to an allowlist when Run Everything is disabled; ACP
reports only Agent/Plan/Ask and provides no confirmation of the effective approval
policy. The adapter therefore claims no confirmation: a Turn that nevertheless
receives a native approval or plan request is cancelled and reported as
`nativeFailure`, never approved, and native denies, admin allowlists and Cursor's
team policy continue to apply. Question extensions remain interactive and are never
answered on the user's behalf. Refs persisted without a locator remain `default`.
The installed `2026.09.18-9a7762b` bundle makes this fallback in
`src/acp/cursor-acp-agent.ts`: `teamSettingsService.getAutoRunControls()` degrades to
an allowlist with a debug log and no client-visible result.

Real native acceptance on the tested CLI confirmed Thinking selection and an
administrative slash command without a model request. A separate native Turn
called the injected MCP `harness_list` tool against a synthetic Host CLI, preserved
the supplied parent Thread ID, and completed with a durable native Turn ID.
A fresh native process also restored a non-default `fast` value from its saved
Model ref after account-wide preferences were changed; native Turn identities
remained equal. Native model preferences modified for validation were restored.
Automated tests additionally cover tool discovery, argument safety, authentication,
Session isolation, bounded waits, shutdown, partial configuration failure, and
restoring non-Thinking parameters from saved Model refs. They also cover the native
`--force` argument, policy persistence through resume/Fork/rollback, and the
cancel-and-fail path for a native approval request in unattended full access; a live
unattended delegated Turn under Cursor team policy was not exercised. These are
plugin/native checks, not a claim of visual Desktop acceptance or an end-to-end
delegated task against another live Harness.

## Native Edit Diff

The adapter converts ACP `diff` content (`path`, `oldText`, `newText`) into public
`fileChange` Items for the existing Desktop patch and Turn Diff projection. Absent
or null `oldText` means a new file per ACP; an empty string means an existing empty
file. Whitespace and line endings in accepted native bodies are preserved.
Unchanged content is omitted.

Diffs are published only after the native tool reports success. Pending proposals,
failed tools and unconfirmed/cancelled calls do not create applied changes; changes
from a tool that already succeeded remain visible if the rest of the Turn is cancelled.
ACP content updates replace previous content, and repeated terminal notifications do
not create extra file-change Items. Native `session/load` uses the same projection;
it cannot recover diffs omitted by the native replay.

Whole patches share a 100,000-character budget per tool, with a 100 ms generation
budget per file. Oversized or timed-out patches are omitted rather than truncated;
the existing bounded tool output remains available. No file watcher, Git comparison,
filesystem baseline or separate diff history is added.

The macOS arm64 CLI `2026.09.10-fd3934a`, using native `cursor_login` and Model
`default[]`, was checked with real edits in an isolated workspace. An existing-file
patch reproduced the actual file from its known previous contents. A relocated
plugin loaded through the public Loader resumed that Session, completed another
real edit, and emitted one Desktop File Change Item and patch update. A fresh
Adapter/native process recovered identical patches and Native Turn IDs.

That same CLI's new-file `diffString` fallback was observed to put `-- /dev/null`
in `oldText` and `++ b/<path>` in `newText`, losing final-newline information. The
same corruption appears in replay. This known malformed pair stays as tool output;
it is not repaired from the current file or guessed into a File Change. Valid ACP
new-file content remains supported, but this native creation case does not have a
reliable Diff.

Automated fixtures cover complete patches, content replacement, success/failure/
cancellation, duplicate notifications, limits and the captured malformed creation
case in live and history projection. These checks are not visual Desktop acceptance
and do not establish coverage for every Cursor Edit/Write path or other versions
and platforms.

## Brand assets

`docs/imgs/badge-cursor.svg` embeds the original 2D Cube path, aspect ratio and
`#EDECEC` fill from `General Logos/Cube/SVG/CUBE_2D_DARK.svg` in the
[official brand kit](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip)
linked by [Cursor's brand page](https://cursor.com/brand). It uses the existing
20px README badge style and links to the Cursor CLI documentation.

The Renderer and plugin icons are byte-identical copies of the
[official favicon](https://cursor.com/favicon.svg), preserving its rounded dark
plate and light Cube mark. They replace the integration's neutral pointer
placeholder and are bundled locally without runtime network requests.

The Cursor name and marks remain the property of Anysphere, Inc.; their public
availability is not an open-source license or a claim of endorsement.

## Build a separate candidate

From the repository root, after `cursor-agent login` has completed in the user's
own terminal:

```powershell
npm ci --ignore-scripts
npm run typecheck
npx vitest run --config tests/vitest.config.js packages/adapters/cursor-cli/test
node tools/build-cursor-plugin.mjs <new-absolute-candidate-directory>
```

The builder refuses an existing output directory. It creates a relocatable plugin
bundle and an `enabled.json` for that candidate root. It does not install, modify
user configuration, restart Desktop or change the preinstalled plugin list.

## Reproducible probes

Use a dedicated empty smoke workspace: these commands execute real Cursor turns
using the user's native account. Receipts contain only synthetic test identities,
responses and aggregate results; no raw credentials or native store copies.

```powershell
# Real multi-turn execution, then a NEW process that resumes the same session.
node tools/cursor-harness-smoke.mjs <smoke-workspace>
node tools/cursor-harness-smoke.mjs <smoke-workspace> --resume

# Load the packaged plugin through the actual Host plugin loader, deny a native
# harmless shell request, and cancel a streaming turn.
node tools/cursor-controls-smoke.mjs <candidate-directory> <smoke-workspace>

# Actual AppServerHost JSON-RPC route with isolated mapping/account state.
# Only the unused official Codex child is synthetic; Cursor execution is real.
node tools/cursor-host-protocol-smoke.mjs <candidate-directory> <smoke-workspace> <new-host-state-directory>
```

Passing these probes establishes the tested Host/adapter boundary. Do not run
`npm start` as a validation shortcut: on Windows/macOS it stops the current Desktop
processes.

## Native Task cards and replay identity

Native Task pending/running/terminal events become Host collaboration cards and
read-only child Threads. The `cursor/task` extension confirms final native model
metadata. Current ACP does not expose the child's internal message/tool stream;
the child view contains its real prompt and the full text result ACP provides,
including after reconnect. The 2,000-character result limit applies only to card
summaries, not child view content. Native pending and in-progress Task notifications
remain distinct pending/running card states. Internal steps are not synthesized.
A successful background launch is not child completion; observation ends as
interrupted if parent exit leaves completion unconfirmed.

Cursor rewrites live tool-call IDs to `replay-N-M` during `session/load`. Child
inspection therefore uses a parent-scoped native invocation address: verified
Turn position, Task position and input fingerprint. This address is not a native
user-Turn ID or a fabricated child Session. The native Turn sequence is checked
before/after history reads, and changed inputs or missing Tasks fail closed.

## macOS SSH and Remote Control

Direct SSH startup can report a locked login keychain despite native GUI login.
Managed remote plugin construction selects the [native Aqua broker](../../platforms/macos/native-aqua-broker.md)
and preserves that login session:

```sh
codexhost broker install --harness cursor-cli
codexhost broker status --harness cursor-cli
```

There is no direct SSH/native-provider fallback if the broker is unavailable.
Neither credentials nor native stores are copied into Host state.

The implementation was packaged on Windows/macOS in a combined 0.6.2 candidate
before this independent Cursor PR. Native Task lifecycle, Plan/Agent switching,
and the same child handle after process/Host reconnect were verified. The user
also verified local Desktop subagents, Windows-to-Mac remote sessions, and
Mac-to-Windows Remote Control. These deployed-candidate/user checks are distinct
from automated tests of this branch, and do not establish compatibility with
unobserved future versions of Cursor's private history format.
