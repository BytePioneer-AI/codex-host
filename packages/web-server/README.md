# Web Server

An independent Node Web Host for the responsive DSH-derived UI. It loads the repository's self-contained Harness plugins through the public factory context and projects their events and interactions onto the existing browser protocol. It does not start, stop or connect to CodexHost Desktop.

Build from the repository root with `npm run build:web`. The default plugin input is the same checkout's `packages/host-runtime/dist/plugins`, built by the existing CH release plugin builder; the installed CodexHost.app is not consulted. Usage-only plugins are excluded from conversations. The standalone Codex Adapter lives in `packages/adapters/codex`; no Harness implementation is duplicated here.

`npm run start:web` uses the isolated, authenticated Claude Code preview. The packed entry is `dist/codexhost-web/preview.mjs`; it strips inherited Desktop routing and Node injection variables, preserves CLI credentials/PATH, and stores preview data separately. `server.mjs` is the configurable full entry and must not be launched with inherited Desktop routing state.

Node test-runner suites are owned by this package's `test`, `test:distribution` and `test:browser` scripts; the root TypeScript test command invokes the unit suites separately from Vitest. The browser and distribution suites require built frontend artifacts. They use temporary data and a fake Harness, never real model submissions.

The initial Web implementation is imported from the MIT-licensed `codexhost-web` fork; its upstream license is retained in `LICENSE.upstream`. Current behavior, limitations and ownership are documented in [standalone-web.md](../../docs/product/standalone-web.md).
