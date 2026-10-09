# Native Harness plugins in the macOS Aqua session

Native CLI credentials held by the login keychain may not be accessible from an
SSH audit session. A managed remote plugin can use `BrokeredHarnessAdapter` to
run its native CLI through the current user's Aqua LaunchAgent.

The broker owns exactly one installed plugin. Its authenticated owner-only socket
and descriptor are scoped to the plugin ID. Foreign Session/parent references
are rejected before opening a native Session. Sequence, generation and native
writer ownership checks remain in force across requests. A Fork reads its source
without claiming or releasing that Session's writer, so an open source does not
block it. The derived Session still needs its own unclaimed write identity;
native checkpoint validation and cross-directory Fork limits remain Adapter-owned.

A Session may expose `nativeWriterRef` to reserve the immutable identity it will
write before a native Session exists. This does not confirm durable history and
is not projected as `initialState.nativeRef`: persistence and recovery still
require native confirmation. An Adapter using this contract must not write to
that identity during `open`; the Broker claims it before commands can execute.
Claude Code supplies the generated session ID that its CLI will use, so unused
Desktop prewarms reserve only their own IDs, not the entire Broker. Concurrent
opens wait for an in-flight create to report its identity rather than failing
with a transient busy error. Sessions without an early write identity retain the
conservative provisional guard. Foreign or colliding reservations are rejected;
a later confirmed native identity must match the reservation exactly.

Desktop Control marks disposable external prewarms and asks the Host to discard
obsolete results, including late results after a configuration change. The Host
serializes discard with user operations and never discards an adopted Session.
See [external Thread prewarm ownership](../../architecture/harness-plugin-runtime.md#外部-thread-预热).

Rust manages the service lifecycle:

```sh
codexhost broker install --harness <plugin-id>
codexhost broker status --harness <plugin-id>
codexhost broker stop --harness <plugin-id>
codexhost broker uninstall --harness <plugin-id>
```

The installed candidate's launcher supplies its Node/runtime paths; explicit
`--node` and `--host-runtime` options are also supported. Without `--harness`,
the commands still select Claude Code and preserve the legacy label, paths and
wire protocol. Other plugins have distinct
`ai.bytepioneer.codexhost.<plugin-id>-broker` LaunchAgents and
`~/.codexhost/harness-broker/<plugin-id>-broker-v1.{json,sock}` resources.

On macOS, a successful `codexhost remote install`, `stop`, `status` or `uninstall`
applies the same broker command to every brokered plugin (Claude Code, CodeBuddy,
WorkBuddy and Cursor CLI). Every broker runs even if an earlier one fails, and the
command reports the first failure.

Brokers run only while needed:

- `broker install` only registers the LaunchAgent (`RunAtLoad` is false). It stops a
  running broker so the next start loads updated code, but never leaves one running.
  Logging in does not start brokers either.
- The managed remote Host starts a broker on demand (`launchctl kickstart`, or
  `bootstrap` of the installed plist when it is not loaded) on the first request
  that needs it, and only when the plugin's local check finds its native CLI.
  Otherwise the Harness reports `notInstalled` and no broker starts.
- A broker exits after one hour with no open Session and no request, or as soon as
  it is idle after an inspection that is not `ready`. It never exits while a Session
  is open. While exiting it unpublishes its descriptor and refuses late requests as
  retryable `brokerRetiring`; the client retries such a request once on a new broker.
- `broker stop` (and `remote stop`) terminates the process but keeps it registered;
  `broker uninstall` (and `remote uninstall`) also removes the LaunchAgent.

None of this is shown to users: the connection list reports only the Harness status.
If a broker cannot be started, for example because no desktop user is logged in,
the error names the plugin and the `codexhost broker install --harness <plugin-id>`
command that registers it again.

The Host loads a plugin with `managedRemoteHost: true` for managed remote
execution. Its factory may select a broker client there and a native adapter for
local execution. The broker loads the same plugin with native context, avoiding
recursive broker construction. Neither the generic Host nor the broker imports
concrete adapters.

Composer account limits use `adapter.credits` to read the native Adapter's existing
quota snapshot. The broker client caches it for the Host's synchronous `credits()`
read and coalesces concurrent refreshes. This forwards Claude Code's native 5-hour
and 7-day windows without a separate account query or Model Turn. Missing quota
stays absent; failed reads keep the last valid snapshot. The Renderer and local
Claude Code quota path are unchanged.

New clients may opt into forwarding the Host's scoped delegation environment:
`CODEXHOST_CLI_PATH`, `CODEXHOST_RUNTIME_ENDPOINT`, `CODEXHOST_RUNTIME_TOKEN`, and
`CODEXHOST_THREAD_ID`. HOME, PATH, loader variables and native credentials cannot
be supplied through this mechanism. The managed remote Claude plugin opts in,
including the scoped Node executable used by the CLI, so its shell tools can
read/delegate through the owning Host. Other broker clients retain their default
behavior. Native login files and keychain state stay in the user's home/session.
The Claude adapter overlays this per-session map on its own native environment
for both create and resume. The broker still rejects foreign HOME/PATH values;
the adapter retains its existing HOME, system PATH, proxy and configuration
variables. Replacing that environment with only the scoped delegation variables
can make real Turns fail OAuth refresh even while account inspection succeeds.
The overlay is a fresh object for each Session and does not mutate either input.
Directly launched packaged remote Runtimes also resolve the sibling native CLI
and their own Node executable when Launcher-provided paths are absent. Delegation
therefore stays on the Runtime's installed candidate instead of a stale PATH CLI;
explicitly configured CLI/Node paths retain precedence.

Discovery reconnects on the next explicit caller request after service startup or
connection loss. Existing wrappers can recover on snapshot read or a subsequent
Turn start by resuming their confirmed native Session with its last observed
model/Thinking/permission state and scoped delegation environment. The filtered
environment is retained per Session for native fault recovery on the same broker
connection as well as for reconnection. Recovery is refused if no native identity
was confirmed; it never creates a substitute Session or replays an interrupted Turn.
There is no background model polling or native fallback.
Closing a client also closes its owned sessions and output channels. A failed
broker is reported as unavailable rather than routing the Thread to another
Harness. A service restart is separate from restarting Desktop or Remote Host.

Tests cover legacy compatibility, separate service/socket identities, foreign
references, scoped environment forwarding, output closure, and on-demand
discovery after a broker generation changes. Native install/stop operations must
be run only when the affected service's active work is idle.
