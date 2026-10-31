# Codex CLI Harness

`codex-cli` is an ordinary external Harness: it runs the local native `codex app-server` over stdio and registers with the shared Host's external Thread runtime. Desktop's official Codex route is separate and never passes through this plugin, and the manifest declares `surfaces: ["web"]` so Desktop does not present it.

Model inspection uses a short-lived native process, read-only Thread listing shares one connection, and each active Session owns its own app-server. Native messages, tools and interactions are translated into the Harness events the Host consumes.

## Launch and native home

The executable comes from the same discovery rules as every other Harness: the persisted launch setting for `codex-cli`, then `codex` on `PATH` and the platform install roots. A resolved codexhost proxy or shim, including the inherited Desktop `CODEX_CLI_PATH` entrypoint, is reported as unavailable and never executed.

`CODEX_HOME` is passed through when set; otherwise the native CLI uses `~/.codex`. Child processes omit Desktop routing (`CODEX_CLI_PATH`), Desktop identity (`CODEX_THREAD_ID`, `CODEX_INTERNAL_*`) and Node injection environment. Of the `CODEXHOST_*` variables, only `CODEXHOST_CLI_PATH`, optional `CODEXHOST_CLI_NODE_PATH`, `CODEXHOST_RUNTIME_ENDPOINT`, `CODEXHOST_RUNTIME_TOKEN` and `CODEXHOST_THREAD_ID` are preserved for Host CLI calls. Create and resume merge the Host's per-session environment over the Adapter defaults before filtering; each Session has its own process and Host caller identity. Native references contain only the Harness identity and native Session ID, so the same native Session can be resumed through the same home without a home locator.

Native Codex discovers the Host CLI through the Host-managed `codexhost-delegation` Skill. Local Thread reads and cross-Harness delegation use the shared Host and do not require Desktop. The native shell environment policy and sandbox still apply: a restrictive policy must allow the Host CLI variables, and Runtime calls require access to its local endpoint. The plugin does not rewrite user configuration or relax the sandbox. Environment propagation tests do not establish real Model-driven delegation.

Authentication is owned by the native CLI. Inspection reads the model catalog without `account/read`, login calls or inference probes; Session creation has no authentication preflight. A readable catalog is not evidence of valid credentials or quota. Native failures keep their messages and use the ordinary Harness failure path.

## Account quota

The optional `inspectAccount()` reads current native authentication with `account/read` and queries `account/rateLimits/read` for ChatGPT accounts. API-key authentication, Providers that do not require OpenAI authentication, missing quota and failed reads return no account snapshot. Queries use a separate, short-lived app-server with bounded requests, create no Thread or model Turn, and never start a login flow.

`credits()` and `refreshCredits()` expose the same account quota to the shared Composer quota control. Background refreshes coalesce and run at most once per 30 seconds; cached values expire after 60 seconds. Explicit account inspection reads fresh data. An unavailable result or Adapter close clears the cache. Native primary/secondary windows retain their percentages and reset times; model-specific buckets keep their native scope. Quota describes the current account, independently of the Session's token usage or cost.

## Native configuration

Permission Modes stay at three native names: read only, auto/workspace write, and full access. When no mode was chosen, `thread/start` and `turn/start` send no approval or sandbox parameters and the user's native configuration decides. When a mode is chosen, only the native approval policy and sandbox mode name are sent; network access, writable roots and other sandbox details stay in user configuration.

The plugin exposes only native app-server capabilities: Turns, cancel, approvals and questions, model and reasoning effort, `/compact` and `/review`, history snapshots and native Session import. Fork and rollback are declared unsupported. Native requests the Host cannot handle receive an immediate error so the Turn never hangs. In-Turn follow-ups use the external Thread steering rules shared by all Harnesses; there is no adapter-level steer or readHistory.

Attachments use the same upload stores and path-context preparation as other Harnesses; the plugin receives text and the Web projects native file/image references into history cards and previews.

The implementation originates in the MIT-licensed codexhost-web fork; the original license is retained in `LICENSE.upstream`.
