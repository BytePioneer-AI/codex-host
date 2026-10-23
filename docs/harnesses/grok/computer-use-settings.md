# Grok Computer Use and in-app browser settings

CodexHost enables Grok's ChatGPT-backed `cua_repl` surfaces from two independent switches. Nobody edits `~/.grok/config.toml` by hand.

## Surfaces

- **Codex Desktop → Settings → Connections → Grok** and **codexhost console → Connections** show one card with two switches: **Computer Use** and **In-app browser**. The Harness list and Harness CLI version block stay as they are.
- Both switches write `~/.codexhost/grok-computer-use.json` (`{ "enabled": boolean, "browser": boolean }`; a file with only `enabled` reads as `browser: false`) and upsert `[mcp_servers.cua_repl]` in `~/.grok/config.toml`.
- RPC `codexhost/harness/grok-computer-use/set` and `POST /api/harnesses/grok-computer-use` accept `{ enabled }`, `{ browser }`, or both.
- CodexHost does not inject `computer-use@openai-bundled`. The stanza uses ChatGPT's `cua_node`, `cua-repl` and the same trusted-service names as the official plugin.

## Switch matrix

| Computer Use | In-app browser | `CUA_REPL_ENABLED_SURFACES` | Trusted services | `BROWSER_USE_AVAILABLE_BACKENDS` |
| --- | --- | --- | --- | --- |
| off | off | stanza `enabled = false` | empty JSON object (inert) | unset |
| on | off | `computer` | `sky` | unset |
| on | on, binding unsupported | `computer` | `sky` | unset |
| off | on, binding unsupported | stanza `enabled = false` | empty JSON object (inert) | unset |

Computer-only users keep the computer-only stanza. The in-app browser switch stores intent in `~/.codexhost/grok-computer-use.json` even while ChatGPT Desktop refuses Grok IAB. Until Desktop authorizes an external Harness, CodexHost does not add the `browser` surface.

Availability is three separate facts: saved intent (`enabled` / `browser`), installed files (`available` / `browserFilesPresent`), and usable binding (`browserAvailable`). File presence is not IAB success.

The current implementation sets `GROK_BROWSER_BINDING_SUPPORTED = false`. Both `browserAvailable` and the generated Grok configuration use that policy flag. The console's authorization explanation describes the known unsupported integration; reading settings does not perform a live Desktop authorization check. Restarting Desktop or creating a new Grok thread does not change this policy.

Computer Use needs the shared `cua_node` runtime, the packaged Codex CLI, and `Codex Computer Use.app`. The browser switch needs that same runtime plus `@oai/browser-desktop`; it does not need Sky.

Saves and session applies acquire filesystem locks for both the preference directory and Grok config directory, so separate Host and console processes re-read intent inside the same critical section. Grok config is written first, then the preference file. A failed publication attempts to restore the previous config and records `applyFailed` without accepting the new intent. New Grok threads stop before transport startup if applying settings fails. Locks time out after five seconds without stealing another writer’s lock; an abandoned `.grok-computer-use.lock` or `.codexhost-cua.lock` directory requires removal after confirming that its writer has stopped.

## IAB, Computer Use and Chrome extension

| Path | What it drives | Owner |
| --- | --- | --- |
| In-app browser (IAB) | ChatGPT Desktop's built-in browser pane through `cua.getBrowser({ id: "iab" })` / `createBrowserTab` | Grok `cua_repl` `browser` surface, opt-in here. Official Codex uses the same backend through ChatGPT **Settings → Browser** |
| Computer Use | Mac apps through Sky (`Codex Computer Use.app`) | Grok `cua_repl` `computer` surface, opt-in here. ChatGPT **Settings → Computer use** governs official Codex |
| Chrome extension | A user's Chrome profile | Official Codex only. Not wired to Grok and out of scope here |

The official Browser Use helpers are never intercepted (see [macOS native tools](../../platforms/macos/macos-native-tools.md)). Grok gets its own `cua_repl` process.

## Default and availability

- Users who never opted in stay off. An enabled legacy `cua_repl` stanza without a surface list reads as Computer Use on, browser off. An explicit surface list preserves separate Computer Use and browser intent; a browser-only stanza never opts into Computer Use.
- Computer Use needs ChatGPT.app `cua_node`, `cua-repl`, the packaged Codex CLI, and `Codex Computer Use.app`.
- The browser switch also needs `cua_node/lib/node_modules/@oai/browser-desktop`. Without it the switch cannot be turned on.
- New Grok threads read the switches. An open thread does not reload MCP.

## Fail-closed binding

ChatGPT Desktop serves IAB through per-session unix sockets and checks each caller:

1. The MCP call must carry `x-codex-turn-metadata.session_id` equal to a Desktop session with a captured browser route.
2. The native pipe verifies the code-signing identity of the connecting process and its parent chain (OpenAI `com.openai.codex*` identities).

When either check fails, `cua.getBrowser({ id: "iab" })` reports `Browser is not available: iab` and Grok does not open a tab. CodexHost does not synthesize session ids, disable peer authorization, or reuse another backend as IAB evidence.

## Verified on Desktop 26.1016.51333

A real Grok ACP session invoked a read-only diagnostic MCP tool and its own browser-only `cua_repl` server. The diagnostic received no `x-codex-turn-metadata`: session and turn metadata were absent, an effective session could not be compared with the native Grok session, and Desktop route ownership was unverified. The subsequent Grok IAB selection was unavailable. Existing Desktop logs also contain the native peer rejection reason `missing-code-signing-identity`; that log observation is separate from metadata captured by the diagnostic tool and does not prove route registration.

In an official Codex thread, the official Browser Use tool successfully bound IAB, opened a blank test tab, read its state and closed it. The Grok probe’s before/after snapshot found `~/.codex/config.toml`, `auth.json` and `AGENTS.md` byte-identical. No official Browser Use helper was intercepted or reconfigured. Computer Use remains an independent surface.

`browserAvailable` stays false, including when `CODEXHOST_GROK_IAB_BINDING` is inherited. There is no environment override that qualifies the blocked binding. Sanitized evidence is retained under ignored `.codexhost/update-impact/26.1016.51333/`.

## Qualification on Desktop 26.1016.62342

On macOS, Grok `1.0.45` (`2bdd1d6a6369`) sends `x-codex-turn-metadata` on model tool calls when the MCP server is named `cua_repl`. A real ACP session using a read-only, session-local diagnostic confirmed nonempty session, turn and call identities. The session identity matched the native Grok session, and the awaited `turn_ended` call matched the same session and turn. A diagnostic registered under a different server name does not establish the metadata behavior of `cua_repl`.

A separate real ACP session supplied the installed browser-only `cua_repl` through its session MCP configuration, without changing global browser preferences or removing native authorization. Browser APIs were exposed, but selecting IAB returned `Browser is not available: iab`. During that probe window Desktop logged six native socket rejections with reason `missing-code-signing-identity`. The installed `cua_node` Node and `node_repl` executables have OpenAI signatures; the installed Grok executable is unsigned. The rejection reason does not identify the exact failed ancestry check.

This establishes a native authorization blocker after the Host configuration gate is removed for a bounded diagnostic. It does not establish an authorized browser route for the Grok session. Desktop's current bundle retains separate peer authorization and session-route ownership checks; metadata forwarding alone cannot satisfy either check. A supported external caller authorization and session-registration contract is still required before enabling normal Grok browser sessions.

Sanitized metadata and browser-probe summaries are retained under ignored `.codexhost/update-impact/26.1016.62342/`. They contain presence/equality booleans and rejection reasons rather than raw session identities or transcripts. Actual Grok navigation, turn cleanup of browser resources, and isolation between two browser-enabled Grok sessions remain unverified because binding failed.

## Limits

- The in-app browser switch is intent until Desktop supports external authorization and a session-owned browser route. CodexHost does not synthesize session ids, disable peer authorization, or treat another backend as IAB evidence.
- The Grok session id differs from the CodexHost thread id, so even an authorized peer needs a Desktop session route for the id Grok sends.
- Chrome extension and Excel stay out of scope.
