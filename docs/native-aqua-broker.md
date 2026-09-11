# Native Harness plugins in the macOS Aqua session

Native CLI credentials held by the login keychain may not be accessible from an
SSH audit session. A managed remote plugin can use `BrokeredHarnessAdapter` to
run its native CLI through the current user's Aqua LaunchAgent.

The broker owns exactly one installed plugin. Its authenticated owner-only socket
and descriptor are scoped to the plugin ID. Foreign Session/parent references
are rejected before opening a native Session. Sequence, generation and native
writer ownership checks remain in force across requests.

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

The Host loads a plugin with `managedRemoteHost: true` for managed remote
execution. Its factory may select a broker client there and a native adapter for
local execution. The broker loads the same plugin with native context, avoiding
recursive broker construction. Neither the generic Host nor the broker imports
concrete adapters.

New clients may opt into forwarding the Host's scoped delegation environment:
`CODEXHOST_CLI_PATH`, `CODEXHOST_RUNTIME_ENDPOINT`, `CODEXHOST_RUNTIME_TOKEN`, and
`CODEXHOST_THREAD_ID`. HOME, PATH, loader variables and native credentials cannot
be supplied through this mechanism. Existing Claude clients retain their default
behavior. Native login files and keychain state stay in the user's home/session.

Discovery reconnects on the next explicit caller request after service startup or
connection loss. Existing wrappers can recover on snapshot read or a subsequent
Turn start by resuming their confirmed native Session with its last observed
model/Thinking/permission state and scoped delegation environment. Recovery is
refused if no native identity was confirmed; it never creates a substitute Session
or replays an interrupted Turn. There is no background model polling or native fallback.
Closing a client also closes its owned sessions and output channels. A failed
broker is reported as unavailable rather than routing the Thread to another
Harness. A service restart is separate from restarting Desktop or Remote Host.

Tests cover legacy compatibility, separate service/socket identities, foreign
references, scoped environment forwarding, output closure, and on-demand
discovery after a broker generation changes. Native install/stop operations must
be run only when the affected service's active work is idle.
