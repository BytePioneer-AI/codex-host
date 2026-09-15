# Windows Browser Use and Computer Use compatibility

Two distinct subprocess boundaries matter when Desktop runs through codexhost.

## Native Computer Use auxiliary app-server

Desktop passes its CLI override and launcher environment to its native helpers.
An auxiliary `app-server` invocation therefore used to enter the Host Runtime
again. With the primary runtime already running, it exits with `STORE_LOCKED`
(`Another codexhost process owns Mapping Store`). A helper can surface only
`codex app-server exited before returning response 1`.

On Windows the managed launch tree is `launcher -> Desktop -> shim`. The shim
now recognizes positively observed deeper descendants of the same launcher as
helpers. It sends those calls to the validated official CLI, without acquiring
a local Host Runtime lease or forwarding internal `CODEXHOST_*` environment.
The direct Desktop child still enters the Host Runtime. Missing, stale, reused,
or unresolvable ancestry does not opt a process into helper routing. Remote
Unix listener behavior is unchanged.

## Browser tool networking

The official MCP stdio launcher filters inherited environment variables. A
working main app-server does not prove that `node_repl`, `cua_repl`, or their
auxiliary app-server has the same proxy settings. Browser discovery/navigation
can work while trusted service HTTP requests or later page-state operations
fail. `nodeRepl.fetch request failed` and debugger errors must be diagnosed
separately from actual administrator-policy denials.

The Windows package includes `libexec/codexhost-node-repl.exe`. The launcher uses
Desktop's supported `CODEX_NODE_REPL_PATH` override when the wrapper is present,
unless the user has selected a different custom runtime. Explicit custom values,
including empty values, are forwarded unchanged in the AppX activation environment;
they must not rely on inheritance from the launcher process. The wrapper resolves
the official `node_repl.exe` next to Desktop's `NODE_REPL_NODE_PATH`; it does not
search PATH or modify the official runtime. Arguments, stdio, and exit status
are forwarded, with the child supervised by the existing Windows job mechanism.

The wrapper and sparse-environment CLI helper path recover the current user's
static Windows proxy configuration through WinHTTP. Explicit proxy environment
values, including empty values and `NODE_USE_ENV_PROXY=0`, take precedence.
Missing proxy aliases and `NODE_USE_ENV_PROXY=1` are supplied when applicable.
No local ports are hardcoded, no system settings are written, and no policy,
authentication, certificate validation, model check, or tool approval is disabled.

PAC/WPAD is not flattened into a global environment proxy. In those environments,
configure the appropriate explicit MCP proxy environment through normal Codex
configuration. Windows `<local>` (all dotless hosts) cannot be represented
exactly by portable `NO_PROXY`; it is omitted, while localhost and loopback
addresses are retained. Existing bypass entries and domain suffixes are carried
forward using the existing proxy-environment normalization.

## Verification

Use a fresh candidate and preserve the current installation for rollback.

1. Confirm the direct Desktop shim still owns the primary Host Runtime and can
   submit a normal turn. Check another Harness and thread resume as appropriate.
2. Inspect only routing/proxy environment keys in the tool process and its CLI
   child. Do not dump complete process environments, credentials, or auth files.
3. Test a trusted service HTTP request through official `node_repl`. Record the
   status/elapsed time, not the authenticated response body. A shell `curl` or an
   untrusted JavaScript `fetch` is not an equivalent end-to-end test.
4. Test in-app browser and Chrome independently: open a public test page, read
   its visible content, click a link, and verify the new page. Opening a tab or
   obtaining its title alone does not prove page-state/control functionality.
5. Test native Computer Use with a returned Calculator window: observe, perform
   a harmless input, and observe again. Preserve all normal app approvals.
6. Confirm the main Host Runtime remains the same healthy owner after tool use.

The regression suite covers direct Desktop versus nested helper routing, lease
non-acquisition, process-identity failures, proxy precedence, runtime discovery,
stdio/exit forwarding, and Windows-only release payload inclusion. Real browser
and native UI tests still require a Desktop restart into the candidate; build
and protocol checks alone are not a claim that all three UI modules passed.
