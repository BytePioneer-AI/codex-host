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
| Native history | Read-only JSONL projection follows the current parent chain. Persisted user-message IDs identify Turns. Prompt completion and snapshots must agree on identity. Missing, ambiguous, corrupt or oversized history produces an explicit error. Incomplete native history remains `unknown`; it is not labeled successful. |
| File diffs | Standard ACP diff content is understood when supplied. Native tools still expose their calls/results when no diff is available. This is not a claim that every CodeBuddy Edit/Write supplies a complete historical diff. |
| Fork / rollback | Explicitly unsupported. SDK `forkSession` does not prove a precise ACP checkpoint operation satisfying the Host's prefix and source-isolation contracts. |
| Native Agent subagents | Running/completed collaboration cards and read-only child Threads, with real child messages/tools read from the native transcript. Native Agent IDs survive resume. Background launch success is not child completion; observation becomes interrupted when the parent exits without confirmed child completion. |
| Commands, compact, Teams | No dedicated Host UI/coordination capability. Member-tagged output is not mixed into the parent's answer. Native CodeBuddy configuration is not rewritten to disable these features. |
| Images | Current public Turn input remains text. Native ACP image capability is not advertised as Host image support. |

The plugin is preinstalled through `scripts/release/harness-plugins.json`; no new SDK dependency or proprietary CodeBuddy binary enters the distribution. Desktop's remaining static Agent list, per-Agent configuration, icon, settings link and production enabled list are updated. Routing uses `encodeHarnessPluginRoute`; no CodeBuddy-specific Host codec or ownership fallback is added. The icon is a neutral code glyph, not a claim of an official trademark asset.

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
during a write; read failures never imply child completion.

Managed macOS remote execution uses the [native Aqua broker](native-aqua-broker.md):

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
