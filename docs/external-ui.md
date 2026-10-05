# External UI API

CodexHost can expose its existing app-server-compatible Host Runtime to local
third-party user interfaces such as Obsidian, a custom desktop UI, or a local
web gateway.

The External UI API does not start another Harness runtime. Every connected UI
uses the same Host Runtime, mapping store, Codex runtime scope, Harness plugins,
and delegation facilities.

## Enablement

A normal local Host started by the codexhost Launcher enables External UI by
default. Set `CODEXHOST_EXTERNAL_UI=0` to disable it.

A standalone development Host does not enable it implicitly. Start one with
`CODEXHOST_EXTERNAL_UI=1`.

Remote SSH-managed Hosts do not enable the local External UI endpoint by
default.

## Discovery and security

The Host listens only on `127.0.0.1` and writes:

```text
~/.codexhost/runtime.json
```

or `$CODEXHOST_DATA_DIR/runtime.json` when a custom data directory is used.

The descriptor contains the Host PID, loopback port, protocol version, and a
random per-process token. The descriptor file is created with mode `0600`.
Clients should authenticate the WebSocket upgrade with:

```text
Authorization: Bearer <token>
```

## Protocol

External UI uses the same JSON-RPC/app-server protocol consumed by CodexHost's
Desktop-facing `AppServerHost`. This intentionally avoids a second session
protocol.

Typical methods include:

- `initialize` / `initialized`
- `model/list`
- `thread/start`, `thread/read`, `thread/list`
- `turn/start`, `turn/interrupt`
- `codexhost/harness/plugins/list`
- `codexhost/harness/inspect`

Streaming responses, tool events, approvals, and questions are delivered as
normal app-server notifications and server requests.

## Client SDK

`@codexhost/client` reads the runtime descriptor, authenticates the WebSocket,
performs the app-server initialization handshake, tracks JSON-RPC requests, and
exposes notifications plus server requests.

```ts
import {
  CodexHostClient,
  externalHarnessTransportModel,
} from "@codexhost/client";

const client = await CodexHostClient.connect();

const plugins = await client.request("codexhost/harness/plugins/list", {});

const model = externalHarnessTransportModel("claude-code");
const thread = await client.request("thread/start", {
  model,
  cwd: "/path/to/workspace",
});
```

Server requests may use either numeric IDs (CodexHost-projected Harness
interactions) or string IDs (official Codex app-server requests). Reply using
`client.respond(id, result)` or `client.respondError(...)`.

## Obsidian example

See `examples/obsidian-codexhost`.

The current example supports Agent selection, thread creation, streaming Agent
text, and turn interruption while using the Obsidian Vault directory as the
thread working directory. Approval/question UI, reasoning cards, tool output,
and diff rendering are planned follow-up layers on the same protocol.
