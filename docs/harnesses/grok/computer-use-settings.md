# Grok Computer Use setting

CodexHost can enable or disable Grok Computer Use without editing `~/.grok/config.toml` by hand.

## Surfaces

- **Codex Desktop → Settings → Connections → Grok** and **codexhost console → Connections** expose a **Computer Use** card (title, description, switch, Codex-only helper). The harness list and Harness CLI version block stay as they are.
- The switch writes `~/.codexhost/grok-computer-use.json` and upserts `[mcp_servers.cua_repl]` in `~/.grok/config.toml` (`CUA_REPL_ENABLED_SURFACES=computer`).
- **ChatGPT Settings → Computer use** and **Browser** remain official Codex. Always-allowed apps stay in that ChatGPT list (Sky). CodexHost does not inject `computer-use@openai-bundled`.

## Default

Users who never opted in stay off. An existing enabled `cua_repl` stanza is treated as on.

## Limits

- Enable requires ChatGPT.app Computer Use files (`cua_node`, `cua-repl`, `Codex Computer Use.app`).
- New Grok threads read the switch. A thread that is already open does not reload MCP.
- In-app Browser Use is a separate work item.
