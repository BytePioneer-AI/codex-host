# Native Codex app tools

The official app-server must receive `CODEX_CLI_PATH` pointing to the stock
Codex executable, not the Host shim. Bundled MCP launchers use its resource
directory to discover the signed Node runtime when no explicit runtime is set.
Host-only launch and routing variables are still removed.

If `codex_app` fails with `Codex app tools pipe closed`, check the Desktop log
for `dynamic_app_tools_peer_rejected reason=missing-code-signing-identity`.
A fallback to a system Node can cause this rejection. Preserve the official
runtime discovery path; do not disable Desktop peer signature verification.

The environment regression tests cover the stock CLI replacement and removal
of Host routing. Desktop acceptance additionally requires launching the built
Host and successfully invoking the native task tools.
