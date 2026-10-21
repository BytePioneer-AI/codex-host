# Grok MCP elicitation

CodexHost Grok sessions project bounded MCP consent forms as Desktop approvals. This is how a user-installed Computer Use MCP (`cua_repl`) can ask to use Clock or another app.

## Wire

Grok sends ACP extension `x.ai/mcp/elicit`. The JSON-RPC method on the wire is `_x.ai/mcp/elicit`. The Grok Adapter handles it through `Client.extMethod`. Initialization keeps `clientCapabilities: {}`; this Grok revision does not gate elicitation on a capability flag.

Supported request: `sessionId`, `toolCallId`, `serverName`, `message`, `mode: "form"`, and either no `requestedSchema` or a reviewed empty object schema. URL mode and non-empty/unreviewed schemas cancel without granting access.

Native replies are `{ outcome: "accept", content: {} }`, `{ outcome: "decline" }`, or `{ outcome: "cancel" }`.

## Desktop

An in-turn form becomes a Host approval with Allow once and Deny. Host Runtime labels the Desktop request with the Harness name (`Grok`); the Adapter title and description keep the MCP server name and consent text.

Allow once maps to native accept. Desktop deny or UI dismiss maps to native decline. Turn cancellation, Session close, process fault, and native `interaction_resolved` (`tool_call_id`) map to native cancel and close the Desktop card once.

When the patched Grok offer includes `persist: ["always"]` (or `session` plus `always`), Desktop adds **Always allow**. That maps to `{ outcome: "accept", content: {}, persist: "always" }`. Allow once still omits persist. **Allow this conversation** is not shown: native `session` lifetime is not proven to match a Grok conversation.

Unpatched Grok (no persist field) keeps Allow once / Deny only. Auto and Always approve permission modes do not auto-accept elicitation.

## Limits

- User-installed `cua_repl` remains Grok configuration. CodexHost does not inject `computer-use@openai-bundled`.
- Arbitrary data-entry forms, URL elicitation, and native TUI elicitation-card parity are unsupported.
- Tool `requestPermission` stays on its own nested ACP response path.
