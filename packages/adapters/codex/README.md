# Standalone Codex Adapter

The imported Web Codex Adapter runs an independent native `codex app-server` over stdio. It owns its model/history inspection process and a separate app-server process per active native session, translating messages, tools and interactions into the Harness events consumed by the Web Host.

This package is not in the Desktop preinstalled plugin set. It neither replaces the official Codex forwarding path nor connects to a running Desktop Host. The Web packer builds its plugin from this workspace; there is no second implementation inside Web Server.

Enable it explicitly with `--harness codex --codex-command /absolute/path/to/codex` in the Web server or `npm run start:web -- ...`. To keep external Harnesses visible too, select e.g. `--harness claude-code,codex`. Automatic preview selection (`--harness all`) still excludes Codex. The shared Host's `enabled.json` never grants the GUI access to this execution plugin.

The Web registry supplies `CODEXHOST_CODEX_COMMAND` and `CODEXHOST_CODEX_HOME` to the factory. The command must be an absolute native CLI path; known CodexHost shim/proxy paths and the inherited Desktop CLI override are rejected. The home defaults to `<web-data>/codex-home`, or can be set with `--codex-home`. It must not overlap the default or configured GUI Codex home, including through symlinks. Configure/login with the native CLI and that explicit `CODEX_HOME` before using the plugin. The Adapter creates only the isolated directory; it does not copy GUI credentials, configuration or sessions.

All model inspection, history, create and resume calls use the isolated home. Native references include its canonical path in `locator.codexHome`; create and explicit import both issue this binding. Resume and history reads reject references from another home or legacy references without the binding before starting a native process. Changing `--codex-home` therefore cannot silently resume previously saved references in another execution environment. Child processes receive no `CODEXHOST_*`, `CODEX_CLI_PATH`, inherited Thread identity or Node injection environment. Missing resume references fail instead of creating another session.

Run a single Web process with exclusive use of its isolated Codex home and Web data directory. Do not point another Web process or native CLI session at that home concurrently. This release does not implement a cross-process execution lease; isolation from GUI storage does not establish a globally unique writer. Cross-end history/execution sharing, fork and rollback remain outside the implemented capabilities; opening the same GUI Thread is not an implicit fallback.

The implementation originates in the MIT-licensed codexhost-web fork; the original license is retained in `LICENSE.upstream`.
