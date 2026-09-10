# Native Codex session configuration

Host must leave native configuration resolution to official Codex. The official
`ThreadStartParams` schema permits `model` to be omitted or null; these requests
must reach the official app-server without an external Harness route.

Previously, the Host decoder required a string Model and returned
`thread/start params.model must be text` before the official server could use
its configured default. This error was also present in the local Desktop logs.
The decoder now leaves omitted/null Models unrouted and forwards the original
request, including its config, permission settings, and instructions.

The audit did not find code deleting native session settings or rewriting
`config.toml`. Local official app-server arguments are forwarded, Host environment
filtering retains `HOME` and `CODEX_HOME`, and the renderer's draft Harness carrier
does not write native Model preferences. Native `thread/resume` and `turn/start`
requests and responses remain on the official path.

Regression coverage verifies default Model requests and preservation of native
session settings in resume/continue traffic. This establishes protocol behavior,
not recovery of previously lost settings or live Desktop acceptance. No user
configuration files or saved conversations were changed during this audit.
