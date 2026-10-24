# macOS native tool compatibility

codexhost keeps the Desktop's main app-server on the Host Runtime while routing
private native-tool app-servers to the official CLI. Tool policy, authentication,
and approvals remain owned by the official CLI and Desktop.

When the selected Desktop bundles `Contents/Resources/cua_node/bin/node`, the
Launcher uses that signed Node for the Host and Desktop Controller by default.
The Desktop authenticates the native-tool peer, its parent and its grandparent;
an ad-hoc-signed Host Node breaks that chain even when the tool itself uses the
official runtime. The Launcher resolves the Node from the selected Desktop on
each start. An explicit `--node` still takes precedence. The npm wrapper leaves
the automatic choice to the Launcher instead of overriding it with its own Node;
older Desktops without a bundled runtime keep the installer Node or npm Node.
The Desktop's peer authorization remains enabled and rejects untrusted runtimes.

Three independent macOS helper paths need different handling:

- Browser helpers may preserve only `CODEX_CLI_PATH`. When that path resolves to
  the exact running Shim, it can discover the CLI inside a validated official
  Desktop bundle. An explicit `CODEXHOST_INSTALL_ROOT` remains authoritative;
  a missing/invalid bundle is an error. Discovery never falls back to `PATH`.
- The `node_repl` kernel resolves that CLI path, then clears both CLI overrides
  before invoking `sandbox -c ... -- <node> <kernel>`. Only this top-level
  `sandbox` command may also discover the validated official CLI with neither
  override present. An explicit invalid target still fails closed. Arguments are
  forwarded unchanged so the official CLI, not the Shim, enforces the sandbox.
- Native Computer Use inherits the managed Desktop's full environment. Desktop
  launched via LaunchServices is reparented to `launchd`, so Windows-style ancestry
  to the Launcher cannot identify these helpers. On macOS the Shim verifies the
  live Launcher executable, then walks a bounded, start-time-checked ancestry to
  the exact Desktop executable in the resolved official CLI's validated bundle.
  A direct Desktop child retains Host routing; only a deeper descendant uses the
  stock CLI with `CODEXHOST_*` bootstrap state removed. Missing or stale identity
  evidence retains existing explicit Host/SSH routing.

For a candidate switch, preserve the previous runtime and confirm that both the
Desktop process chain and the installed Remote Host refer to the new package.
After Desktop synchronizes its MCP configuration, reconnect idle remote tasks or
restart the managed Remote Host during an authorized maintenance window: a tool
process created earlier can retain an old `CODEX_CLI_PATH` even when the file on
disk now names the new candidate. Resetting the JavaScript kernel alone does not
necessarily recreate that process environment.

Validate real Chrome navigation and page reads separately from native app
enumeration and input. A successful CLI handshake alone does not prove either
tool works. Likewise, Chrome availability does not establish in-app browser
availability. IAB discovery requires a backend matching the calling session's
metadata; do not synthesize session IDs, disable matching, or use another backend
as evidence of IAB success. Report an unavailable IAB independently.

Focused macOS regressions:

```sh
cargo test --locked -p codexhost-shim --features test-utils --test proxy macos_
cargo test --locked -p codexhost-shim --features test-utils --test proxy browser_helper
cargo test --locked -p codexhost-shim --features test-utils --test proxy rejects_missing_stock_cli
```

The native-helper test exchanges bytes through real Shim processes at direct and
nested depths, including a Desktop fixture reparented to `launchd`. It asserts
that the main app-server retains Host routing and helpers do not acquire Host
ownership. The existing lease and SSH lifecycle regressions remain required.
