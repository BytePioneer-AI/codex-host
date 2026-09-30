# CodeBuddy native Harness plugin

CodeBuddy runs as an independent `codebuddy` Harness using its installed, signed-in CLI. The plugin uses native ACP over stdio through the existing `@agentclientprotocol/sdk` dependency. It does not substitute a Claude executable, translate CodeBuddy into an OpenAI-compatible provider, or store native credentials in codexhost.

## Interface selection

The following official interfaces were compared against CodeBuddy CLI **2.148.0** on Windows, with the user's existing native login, on 2026-09-11 (Asia/Shanghai).

| Interface | Assessment |
| --- | --- |
| [CLI overview](https://www.codebuddy.ai/docs/zh/cli/overview) and bidirectional print mode | Useful CLI automation surface. Stream-json resembles Claude's format, but that resemblance does not establish equivalent permissions, configuration or history semantics. |
| [ACP](https://www.codebuddy.ai/docs/zh/cli/acp) | Selected. Native Session creation/loading, structured streaming, permission requests, configuration options and cancellation work through one owned subprocess. A live prompt returned `userMessageId`, matching the native transcript and subsequent `session/load` replay. |
| [Daemon](https://www.codebuddy.ai/docs/zh/cli/daemon) | Provides a shared background lifecycle for native HTTP/Web clients. codexhost already owns Session processes, so this would add another service, lifetime and credential boundary. No daemon is started by this plugin. |
| [HTTP API](https://www.codebuddy.ai/docs/zh/cli/http-api) | REST Runs and ACP over HTTP are available. The current HTTP documentation and installed CLI use password authentication by default; the daemon page's older local-auth description is not a reliable current default. A second listener and HTTP credentials are unnecessary for a local Harness subprocess. |
| [TypeScript SDK](https://www.codebuddy.ai/docs/zh/cli/sdk-typescript) | A credible alternative: `query()` and the experimental Session API expose configuration and permission callbacks. SDK **0.3.256** was inspected and probed against the installed CLI. A Session with `requestTimeoutMs` failed during startup; without that option it connected, but returned a legacy 12-model/four-mode catalog instead of ACP's 15-model/eight-mode catalog. The SDK also bundles a CLI and has distinct settings-source defaults. These concrete differences favor the installed CLI's ACP surface for this integration. |
| [Python SDK](https://www.codebuddy.ai/docs/zh/cli/sdk-python) | Exposes an asyncio client with multi-turn receive, interruption and model/permission controls. It would introduce an additional language/runtime boundary without addressing the observed TypeScript/native catalog differences. It was reviewed, not executed. |

The pre-existing [PR #110](https://github.com/BytePioneer-AI/codex-host/pull/110), inspected at `54abeb46d78bc0f090c0149da355f4ac68316c25`, uses print transport and the older static registration architecture. This implementation uses the current plugin loader and shared plugin route. It does not modify that contributor's branch.

## Ownership and lifecycle

`packages/adapters/codebuddy` owns discovery, ACP, native configuration, history, usage and interactions. Host Runtime retains Thread mapping and public event projection. Its package dependencies and concrete Adapter registration remain unchanged.

The plugin uses the shared executable-discovery mechanism, including npm shims on Windows and version-manager roots on macOS/Linux. `CODEXHOST_CODEBUDDY_COMMAND` can select a specific installation. An explicit invalid installation does not silently fall back. Authentication, native settings, tools and MCP configuration remain CodeBuddy's responsibility. Per-Thread environment values override the factory's environment on both create and resume.

Inspection creates a disposable protocol Session with `--no-session-persistence`, reads native configuration and closes the process. It sends no prompt and persists no user transcript. Results, including negative results, are cached by cwd until explicit refresh; there is no periodic discovery loop.

Each writable Session owns one CLI connection. Model IDs are encoded as opaque `cb.<base64url>` refs. Model, thought-level and permission changes wait for native configuration confirmation. A Model change refreshes the complete available thought configuration. Ordinary prompts never travel through shell arguments.

CodeBuddy 2.148.0 can retain cancellation state after returning a cancelled prompt. After an acknowledged cancellation, the plugin closes that owned CLI, loads the same Native Session in a fresh process, restores confirmed Model/Thinking/Permission values, and only then completes the Host Turn. Connection generations prevent old updates or replay from contaminating the next Turn. Cancellation has a bounded recovery deadline; recovery failure faults the Session rather than reporting a usable connection.

## Capability boundaries

| Capability | Current behavior |
| --- | --- |
| Create, multiple Turns and writable resume | Implemented; source identity and cwd are validated. |
| Streaming text and public reasoning | Separate public Items, with immutable starts and exactly one completion. |
| Tools and approvals | Native calls/results are projected. Repeated `tool_call` frames share one Item; incomplete argument chunks are not rendered as command output. Permission action IDs retain their native allow/reject scope. |
| Questions | Native `AskUserQuestion` is mapped to a Host Question. Its answers are submitted through the native `_codebuddy.ai/resolveInterruption` extension before retiring the pending ACP permission request. This extension is version-specific and covered by a real 2.148.0 probe. The older `_codebuddy.ai/question` callback is also understood. |
| Model, Thinking, Permission Mode | Live configuration, from the native catalog. At verification ACP exposed `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, `fullAccess`, and `delegate`. This list is not hardcoded as a catalog. |
| Unattended execution | Requests the advertised native `fullAccess` mode. `bypassPermissions` is not assumed to bypass CodeBuddy's high-risk checks. Policy acceptance is tested; destructive operations are not used for acceptance. |
| Usage | Reads native model-request usage once per request, exposes context size/used, and reports CodeBuddy credits as credits, not USD. Account quota is not implemented. |
| Native history | Read-only JSONL projection follows the current parent chain. Persisted user-message IDs identify Turns. Prompt completion and snapshots must agree on identity. A Tool result written before its call — CodeBuddy records a refused call and its result from separate writers — is applied when its call arrives; a result whose call never appears is dropped instead of failing the read. Missing, ambiguous, corrupt or oversized history produces an explicit error. Incomplete native history remains `unknown`; it is not labeled successful. |
| File diffs | Standard ACP diff content is understood when supplied. Native tools still expose their calls/results when no diff is available. This is not a claim that every CodeBuddy Edit/Write supplies a complete historical diff. |
| Fork / rollback | Native derived Sessions at a Turn boundary, in the same cwd. A model-free CLI copy isolates the source; native `/fork` gives the final Session independent native identities, then `_codebuddy.ai/session/rollback` retains the exact requested prefix. See the version-specific lifecycle below. |
| Native Agent subagents | Running/completed collaboration cards and read-only child Threads, with real child messages/tools read from the native transcript. Native Agent IDs survive resume. A background launch acknowledgement completes its tool Item but not the child lifecycle; observation continues without mutating that completed Item, and becomes interrupted when the parent exits without a proven native child-completion signal. |
| Cross-Harness delegation | Uses the shared persistent Thread/delegation path, native `fullAccess` for unattended creation, and per-Session environment forwarding. When all four Runtime/CLI/Thread variables are present, the plugin passes discovery instructions through native `--append-system-prompt`; the native shell invokes the configured CLI and inherits the correct parent identity. Runtime tokens are never expanded into process arguments or prompt text. CodeBuddy-native Agent subagents retain their separate behavior. |
| Commands and compact | The Session command catalog follows native ACP `available_commands_update`, including argument hints and skill commands. Execution sends the advertised slash text through `session/prompt`; `/compact` supports native summarization instructions and projects a `contextCompaction` Item. Commands that replace the Session, detach work, create autonomous queues, or require a native UI are excluded. The Desktop menu reads a static Adapter catalog of verified `/compact` and `/cost` commands; execution still requires the command to be advertised by the live native Session. |
| Teams | No dedicated Host coordination capability. Member-tagged output is not mixed into the parent's answer. Native CodeBuddy configuration is not rewritten to disable Teams. |
| Images | Current public Turn input remains text. Native ACP image capability is not advertised as Host image support. |
| Same-turn steer | Declared only when the running CLI's unprefixed product version is at least 2.143.1. `turn.steer` calls the ACP extension `session/steer` (no underscore prefix) with `sessionId` and text `contentBlocks`. Native `{steered:true}` is acceptance; `{steered:false}` (`idle` or `stale`) is `invalidState`. Empty text is `invalidRequest`. The call does not cancel the Turn or start another one, and the Adapter does not publish a `userMessage` Item. A live `user_message_chunk` echo stays ignored. History parsing is unchanged, so each persisted user row remains its own Turn after refresh. While the Turn is open, completion binds the original prompt when the new native Turn count is 1 plus the steers this Turn has accepted, and still fails when that count does not match. Below 2.143.1, or when `--version` cannot be read, steer stays undeclared and `turn.steer` is `unsupported`. A busy `turn.start` stays `sessionBusy`. `session/steer` exists from 2.134.0; the acceptance receipt required to return `accepted` exists from 2.143.1 (npm package 2.157.0 types). This checkout has no CodeBuddy CLI, so the path is not live-verified. |

The plugin is preinstalled through `scripts/release/harness-plugins.json`; no new SDK dependency or proprietary CodeBuddy binary enters the distribution. Desktop's remaining static Agent list, per-Agent configuration, icon, settings link and production enabled list are updated. Routing uses `encodeHarnessPluginRoute`; no CodeBuddy-specific Host codec or ownership fallback is added. The plugin and Renderer use identical copies of the user-provided CodeBuddy mark captured from `https://www.codebuddy.cn/`, replacing the original neutral code glyph. The SVG is bundled locally without changing its colors, proportions or clipping; asset provenance is recorded in `packages/renderer-extension/src/assets/README.md`.

The README badge uses the round gradient favicon declared by [CodeBuddy's homepage](https://www.codebuddy.cn/home/), rather than the square Desktop mark. The [original favicon](https://download.codebuddy.cn/web/website/423727b4d2d85eaaef1d5b8f9cef78abc8b2a1a7/assets/logo.svg) is preserved in `docs/imgs/codebuddy-favicon.svg`; `docs/imgs/badge-codebuddy.svg` embeds its original vector shapes, gradients and clipping in the existing README badge style. Both are local assets, with no external image dependency.

## Chinese permission-mode presentation

The Renderer translates the known native labels and descriptions when Desktop uses Simplified Chinese. The menu and selected-mode label share the same translation; native IDs, catalog order, selection behavior and danger indicators stay unchanged. English retains the native wording, and unknown labels/descriptions fall back to their original text rather than being inferred from an ID.

The following eight entries were confirmed by read-only ACP inspection of CodeBuddy CLI **2.149.0**, without sending a prompt or changing permissions:

| Native ID | Native label | Chinese label |
| --- | --- | --- |
| `default` | Always Ask | 始终询问 |
| `acceptEdits` | Accept Edits | 接受编辑 |
| `plan` | Plan | 规划模式 |
| `auto` | Auto | 自动 |
| `dontAsk` | Don't Ask | 不询问 |
| `bypassPermissions` | Bypass Permissions | 绕过权限 |
| `fullAccess` | Full Access | 完全访问 |
| `delegate` | Delegate | 由父会话管理 |

The Chinese descriptions preserve the distinctions: Don't Ask denies actions that still require permission; Auto can fall back to asking, or denial if prompts are unavailable; Delegate means parent-session permission management, not cross-Harness task delegation. Bypass is described as skipping ordinary permission prompts because the CLI's help explicitly retains HIGH/CRITICAL checks, despite ACP's shorter “Skips all permission prompts” wording. Full Access also skips dangerous-command checks for all agents. This is presentation only, not a Host-defined permission policy.

## Build, installation and validation

`npm run build:typescript` produces `packages/host-runtime/dist/plugins/codebuddy/{manifest.json,plugin.mjs,assets/icon.svg}`. The bundle is relocatable and uses the existing audited ACP/diff/zod dependency set. `npm run build:renderer` builds the Desktop integration. An isolated plugin root can enable it with `{"version":1,"enabled":["codebuddy"]}` in its own `enabled.json`; do not add a second enabled copy where the same ID is already preinstalled.

Verified Windows behavior includes independent plugin loading outside the repository, live catalog/configuration changes, streamed native responses, an approved scratch-file write, question answers, cancellation followed by another successful Turn, and fresh-loader native identity recovery. A separate real Host run loaded the plugin, created a Thread through the shared route, projected a native Turn, closed the Host, resumed the same Thread with its persisted mapping and completed another Turn. The stock-Codex transport in that isolated Host test is a fixture; it is not evidence of a newly deployed Desktop or a real native Codex turn.

Focused tests cover adapter lifecycle, busy/invalid operations, cancellation recovery, interaction validation, immutable events, native branch/history identity, credit accounting, Renderer configuration isolation, generic Host routing, plugin loading and release bundle boundaries. Runtime artifacts and synthetic live evidence belong outside the product repository.

## Native subagents and macOS remote execution

Agent events identify child traffic through `codebuddy.ai/parentToolCallId`. The
adapter consumes that traffic separately from parent messages/tools and correlates
its native request ID to a child under the verified parent's `subagents/`
directory. Only known active child calls are observed, at 750 ms intervals.
Invalid IDs, redirected files/directories, different workspaces, mixed identities
and oversized files are rejected. An incomplete final JSONL line can be ignored
during live child observation, including parent validation, only while it remains
unterminated; ordinary parent-history reads and malformed completed/interior lines
remain strict. Each Session observer keeps a bounded file-fingerprint cache, skips
unchanged full-file reads and parsing, and invalidates on path, inode, size or
nanosecond timestamp changes. A reusable cache entry is installed only when file
identity and metadata are stable before and after the read and the byte count agrees;
changed files are reread in full rather than incrementally. Cache hits still
revalidate canonical paths, workspace ownership and transcript identity. Read
failures and assistant/file messages never imply child completion, and closing the
parent prevents in-flight observations from emitting late events.

Managed macOS remote execution uses the [native Aqua broker](../../platforms/macos/native-aqua-broker.md):

```sh
codexhost broker install --harness codebuddy
codexhost broker status --harness codebuddy
```

The native CLI runs in the login user's Aqua session, keeping its own credentials.
The SSH/Remote Control Host connects over an authenticated owner-only local socket;
the adapter does not fall back to another Harness or an SSH CLI process.

The implementation was packaged and tested on Windows and macOS in a combined
0.6.2 candidate before being split into an independent CodeBuddy PR. Agent state,
live child history, mode changes and same-child resume were verified through the
real Mac Remote Host and official SSH proxy. The user also verified local Desktop
subagents, Windows-to-Mac remote sessions, and Mac-to-Windows Remote Control.
Those user confirmations are separate from automated adapter/Host tests. Building
this branch does not itself restart or deploy any existing Desktop installation.

## Command and delegation validation (CLI 2.151.0)

The [native ACP documentation](https://www.codebuddy.cn/docs/cli/acp) describes
`available_commands_update`; [slash commands](https://www.codebuddy.cn/docs/cli/slash-commands)
describe `/compact`. The installed CLI's native ACP implementation and help were
also checked for command execution, compaction markers, and `--append-system-prompt`.

The Desktop command button reads `HarnessAdapter.commandCatalog`, not the
Session's dynamic catalog. The Adapter exposes verified `/compact` and `/cost`
metadata without inspection, native process startup, or a persisted Session.
The menu also opens before a Thread exists, with direct execution disabled until
there is a conversation. Other native commands and skills remain available through
typed invocations when advertised by the Session.

Commands share normal Turn busy/cancel/fault handling. Local commands may complete
without a persisted user Turn; the adapter then omits Native Turn identity instead
of fabricating it. CodeBuddy's persisted local-command caveat, command, and stdout
records project as one command Turn. Its internal compaction prompt, reasoning,
and summary project as `/compact` and a compaction Item, rather than appearing as
user instructions or a normal assistant reply. Native automatic compaction does
not create an extra user Turn. Compaction Items start only from native evidence;
a successful Item requires a newly persisted `isCompacted` summary, and native
failure/cancellation preserves the corresponding Item outcome. Ordinary prompts still require
exactly one persisted Native Turn.

Focused adapter tests cover catalog refresh, removed/invalid commands, native
arguments, busy rejection, cancellation recovery, command histories, compaction
projection, and per-Thread environment propagation. A real macOS CLI probe executed
`/cost` followed by `/compact` and verified two successful Turns and their reloaded
history. The delegation probe uses the native shell and an isolated test CLI to
verify system-prompt discovery and inherited Runtime/parent environment; it is not
an end-to-end test of another live Harness or Desktop deployment.


## Native Fork and revision (CLI 2.151.0)

The installed native CLI has two different Fork paths. ACP does not advertise
`session/fork`, and ACP startup with `--resume --fork-session` did not copy the
source. Print mode with `--resume SOURCE --fork-session --session-id TARGET
--print --input-format stream-json --output-format stream-json` and immediate
stdin EOF does copy history without a prompt or model request. Its result must
confirm TARGET and zero API duration; result usage includes historical tokens.
Source bytes and the
native copied history must match exactly, with no added user/model items, before continuing; stdout and transcript reads
are bounded to 64 MB.

That print copy alone is unsuitable as a writable Thread: native reload derives
its runtime identity from inherited `sessionId` rows, so it reuses the source's
runtime ID under a different store ID. The plugin opens that temporary copy only
for administration, verifies that the native command catalog advertises `/fork`,
and invokes that native local command. CodeBuddy emits the final Session ID and
regenerates message IDs and parent links itself. Every copied content field and
parent edge is compared with the source. No model work or child Agent is started
in the temporary copy.

The final Session is rewound using native `resend_edit`, with files disabled, to
the end of the selected Turn, including its Tool result suffix. Revision retains
the prefix before the last Turn, including the valid empty prefix. Native
`resend-fork-notice` records identify the requested branch of the append-only history;
the plugin verifies that prefix and excludes `/fork` administrative messages from
its projection. A notice alone does not guarantee that a fresh native process
restores the same cursor. After loading, the writable Session reapplies and confirms
native rollback only when the latest message/rewind record is still a rewind notice
(`null` for an empty prefix). Initial resume and cancellation recovery share this
path. Titles, summaries and file snapshots do not consume the notice; a subsequent
message, reasoning or tool record anchors the branch and prevents another rewind,
so later valid Turns survive resume. No additional persistent state is needed.
Missing or unconfirmed rollback fails closed. This does not automatically repair
Sessions already continued on the wrong branch. It never edits native transcripts, injects
replacement messages, invents native message IDs, or rewinds source files.
Snapshots and Turn completion expose checkpoints based on persisted native user
message IDs. Cross-cwd Fork remains unsupported.

This requires an extra temporary CLI and administrative ACP process before the
final writable ACP Session starts. The administrative ACP process also starts
CodeBuddy's native HTTP server on `127.0.0.1` with an OS-assigned port and a random
per-process password. After validating the derived history, the plugin calls the
native `DELETE /api/v1/sessions/{id}` endpoint for only its own temporary copy.
Successful Fork/revision therefore leaves only the final derived Session. The
server exits with that same administrative process; no additional process or
long-lived server is introduced. HTTP startup banners, including the password,
are removed before ACP parsing and are not logged or persisted by the plugin.
The password is passed through the process environment, not CLI arguments or
user configuration.

Failure cleanup attempts the same native deletion. CodeBuddy refuses to delete
the currently active Session, so failures before `/fork` changes the active
Session, unavailable endpoints, and shutdown can still leave temporary data.
Cleanup failure is reported with the temporary ID, and successful cleanup is
required before exposing a writable result. Failures can also leave an
unreturned final derived Session. The plugin never unlinks native stores.
Unsupported commands, changed source history, altered native copies, or an
unconfirmed/nonpersistent rewind return an error without exposing a writable
result.

When the source is open, current confirmed Model, Thinking and Permission settings
are inherited; explicit revision settings take precedence. Confirmed derived
settings travel in the opaque Native Session locator and are reapplied on reload,
including after cancellation. A closed original Session without saved settings
uses the native loaded configuration, as native ACP itself does. The public
contracts and other Harnesses do not change.

Real no-model probes verified source-byte isolation, recursive Fork from a derived
Session, exact native IDs across process restart, one-Turn revision to empty
history, and restoration of `plan` / `high` configuration. Focused tests also
cover Tool suffixes, invalid checkpoints, missing advertised commands, native
copy/rewind failures, altered history, shutdown, and configuration overrides.

An isolated live-model check on CLI 2.151.0 confirmed why the shorter print-copy
plus rollback path is not used: although replay and rollback succeed, new live
ACP events and newly persisted parent messages retain the source Session ID,
and a real Agent subagent writes its transcript under the source's subagent
directory. This is an observed runtime identity failure, not just a concern
about inherited historical rows. Native HTTP cleanup was verified to reject an
unauthenticated request and to remove only the intermediate copy.
The cleaned final Session was also continued with a real model and Agent call:
live events and new parent messages used the final ID, the child transcript
was stored beneath the final Session's subagent directory, and the source
transcript stayed byte-for-byte unchanged. Reload and last-Turn revision
preserved the expected two-Turn and one-Turn histories respectively.
