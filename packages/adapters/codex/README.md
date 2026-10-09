# Standalone Codex Adapter

The imported Web Codex Adapter runs an independent native `codex app-server` over stdio. It owns its model/history inspection process and a separate app-server process per active native session, translating messages, tools and interactions into the Harness events consumed by the Web Host.

This package is not in the Desktop preinstalled plugin set. It neither replaces the official Codex forwarding path nor connects to a running Desktop Host. The Web packer builds its plugin from this workspace; there is no second implementation inside Web Server.

The CLI selector remains `CODEXHOST_CODEX_COMMAND`. Do not pass Desktop routing environment or a CodexHost proxy executable to it; the isolated Web preview deliberately excludes Codex until its native entrypoint is independently verified. The implementation originates in the MIT-licensed codexhost-web fork; the original license is retained in `LICENSE.upstream`.
