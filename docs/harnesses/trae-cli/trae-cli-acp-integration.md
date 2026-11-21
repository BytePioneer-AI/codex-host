# TRAE CLI ACP integration (experimental)

`trae-cli` connects to the official **TraeCode CLI**, using `traecli acp serve` over stdio. It is a new Harness identity, not a migration of the former `trae-cn` Desktop Companion prototype. It does not use Desktop private APIs, a Companion VSIX, a running TRAE window, or a project already open in Desktop. Host/Renderer/public contracts are unchanged.

## Installation and account boundary

Use the [official installation instructions](https://docs.trae.cn/cli_get-started-with-trae-cli-2), then run `traecli login` in a terminal. Discovery uses PATH, common user binary directories, or an explicit executable in `CODEXHOST_TRAE_CLI_COMMAND`. Version checks run `traecli --version`; updates remain manual (`traecli update`) because the inspected native updater has no documented stable JSON status. The plugin never initiates browser/PAT login, copies Desktop credentials, or changes global CLI configuration.

The [official CLI 2.0 overview](https://docs.trae.cn/cli_about-trae-code-cli-2) currently limits access to TRAE Enterprise flagship subscribers. A Desktop/SOLO subscription does not establish CLI entitlement. CLI authentication, Agent types, model names and defaults must not be inferred from Desktop. Old Desktop Companion Sessions cannot be resumed through this plugin.

## Inspection, configuration and execution

Inspection initializes ACP and calls the read-only `session/list` to verify access. Full inspection also runs `traecli models --json` in the requested directory, validates its model entries, and caches the result per cwd until explicit refresh. It never creates a native Session or submits a prompt. Unknown catalog formats and an empty catalog fail explicitly. No first model is chosen by the plugin; no default is synthesized. Thinking and permission choices come from the opened Session's native config options/modes, when available.

Creating a Host draft connects and checks access without `session/new`. Native creation is delayed until the first explicit configuration command or Turn. Discarding an untouched prewarm creates no native conversation. An explicit model choice may create a native empty Session before its first prompt; cleanup of that native record is not claimed. All Session launches inherit the per-Thread environment over the factory environment.

The transport uses standard session configuration, permission and cancellation methods. Model/Thinking changes require the returned complete config list to confirm the selected value; changing Model replaces its Thinking options, including clearing obsolete choices. Permission changes require native readback and are rejected during an active Turn. Tools and confirmed ACP diffs are projected separately from assistant/reasoning text. Approval choices are forwarded once; stale/foreign responses are rejected. Supported form elicitation is string and string-enum fields; complex/URL forms fail explicitly.

Only one prompt runs per Session. A pending prompt has no arbitrary generation deadline. Startup, control requests and inspection are bounded. Closing terminates this plugin's owned CLI process/tree; it never stops a user's shared native services. Whether real CLI work always terminates on stdio close, including any native daemon behavior, still requires entitled-account verification. No global permission mode is changed, and `unattended-full-access` is explicitly rejected until native policy equivalence is verified.

## History and recovery limits

Resume verifies the Session is listed in the persisted workspace, then uses advertised `session/load` and checks known Turn refs. It never creates a replacement Session or resends input on a failed resume. Native replay is not exposed as new live output.

The standard replay used here has no guaranteed native message identity/stop-reason field. Turn keys combine the persisted user boundary ordinal with its input digest; live completion publishes an identity only after the same prefix and last input are confirmed by durable replay. Repeated reads preserve those keys and Item identities. A changed, missing or ambiguous user prefix fails alignment. Consecutive user chunks are one boundary: cancellation histories without a separating native reply and replay truncation must be validated against the real CLI before general recovery is claimed. Historical outcomes remain `unknown` when ACP does not supply a stop reason; a confirmed live outcome is retained only inside the same open Session, not invented on cold load.

Checkpoint-precise Fork/Rollback, Steering, autonomous Turns, native Subagent transcript reading, global usage and account-credit projection are not advertised. The real initialize response advertises native full-session Fork/Resume and Steering extensions, but that alone does not prove their semantics satisfy the Host contracts.

## Evidence and remaining acceptance

2026-11-17, Windows, official `traecli 0.213.1` (`installation: public`):

- `acp serve --help` and `models --help` confirm the stdio entry and JSON catalog command. `--no-daemon` is rejected for ACP; it is not passed by the plugin.
- Actual initialize negotiated protocol 1, advertised `loadSession`, session list/fork/resume/close, and Enterprise SSO/PAT auth methods. No authentication was attempted by the probe.
- With this account not logged in/without CLI entitlement, `session/list` and `session/new` returned JSON-RPC `-32000`, `Authentication required`; `models --json` returned `[]`. This is not evidence for an authenticated catalog schema or successful model inference.
- `test/acp.test.ts` runs a separate native-protocol fixture process, including the public Adapter and SDK transport; it covers streaming, tools/diffs, permission choices, forms, cancellation, replay, configuration confirmation and owned-process cleanup. Fixture catalogs/modes are standard ACP test data, not observed TRAE account models.
- Real authenticated creation, two-Turn conversation, cancellation/approval/form semantics, model/Thinking/mode changes, cold continuation, empty-Session cleanup and native process lifecycle remain **unverified**. The user confirmed their account lacks CLI access. Keep this integration experimental/draft until a maintainer or entitled tester completes these checks.

The exhaustive capability inventory is [CAPABILITIES.md](../../../packages/adapters/trae-cli/CAPABILITIES.md). Build and plugin Loader tests establish packaging, not native authenticated behavior or daily Desktop deployment.
