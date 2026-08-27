# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`codexhost` lets non-Codex Agent Harnesses (Pi, Claude Code, Grok Build, DeepSeek Harness, OMP)
run as independent Threads inside the official **Codex Desktop** shell, instead of Codex's own
Harness. It does this without forking Codex Desktop or normalizing everything through ACP:

- **Desktop side**: uses CDP / Electron Inspector to enhance the official Codex Desktop's Agent
  selection and session UI. It does not rebuild the chat shell or modify the official installer.
- **Protocol side**: a CLI Shim transparently proxies the official `app-server`; native Codex
  requests pass through unchanged.
- **Harness side**: each Harness is integrated via its own native interface (Pi via official RPC,
  Claude Code via the Agent SDK/CLI, etc.) and projected onto Codex Desktop's existing streaming,
  tool, diff, approval, and question UI.

The goal is fidelity, not just "can chat" — streaming, tool state, patches, approvals, and
questions should come from the Harness itself, not be guessed or faked by the Host.

Read `docs/领域术语表.md` before making domain changes — it defines and disambiguates Harness,
Agent, Model, Provider, Account, Thread, Turn, Fork, Native Session/Checkpoint/Turn Ref, Turn
Anchor, Adapter, Permission Mode, and Approval Request. Do not conflate these terms.

Read `docs/harness-command-integration.md` before adding a Harness-specific slash/native command
(e.g. Pi `/compact`, Claude `/init`) — it's the step-by-step checklist and current boundary rules
for that flow.

## Commands

```bash
npm start                     # build nothing; launches the app from source via tools/dev-desktop/run.mjs
npm run build                 # build:typescript + build:renderer + build:rust, in that order
npm run build:typescript      # tsc -b across the TS workspaces
npm run build:renderer        # esbuild bundle for @codexhost/renderer-extension
npm run build:rust            # cargo build for launcher/platform/shim/updater crates

npm run typecheck             # tsc -b plus tests/tsconfig.json, no emit
npm run lint                  # eslint . + tools/check-boundaries.mjs (package boundary enforcement)
npm run format                # prettier --write . + cargo fmt --all
npm run format:check          # prettier --check . + cargo fmt --all --check

npm run test:typescript       # build:typescript, then vitest run --config tests/vitest.config.js
npm run test:rust             # cargo test --workspace --locked --features codexhost-shim/test-utils,codexhost-gate-a-native/gate-tools
npm test                      # test:typescript + test:rust
npm run test:e2e              # playwright test --config tests/e2e/playwright.config.js

npm run check                 # format:check + lint + typecheck + test:typescript + check:rust (full pre-PR gate)
npm run check:rust            # cargo fmt --check + clippy -D warnings + cargo test (Rust equivalent of `check`)
```

Running a single TS test (vitest, config lives at `tests/vitest.config.js`, tests are picked up
from `packages/**/test/**/*.test.ts`, `tests/release/**/*.test.mjs`, `tools/**/*.test.mjs`):

```bash
npm run build:typescript
npx vitest run --config tests/vitest.config.js packages/harness-adapter/test/some-file.test.ts
npx vitest run --config tests/vitest.config.js -t "test name substring"
```

Running a single Rust test:

```bash
cargo test --locked --features codexhost-shim/test-utils,codexhost-gate-a-native/gate-tools -p codexhost-shim some_test_name
```

Do not run `gate:a` / `gate:c` / `gate:claude` suites unless specifically asked — they are
heavyweight differential/live probes against real Codex Desktop / Claude Code installs, not part
of routine change validation. Per AGENTS.md: small, low-risk changes don't need tests; add
focused tests for high-risk or cross-package changes; never claim a check passed without running it.

## Architecture

### TypeScript package graph (`packages/`)

Dependency direction flows one way — lower layers must not import from higher ones:

```
shared-contracts (browser-safe types + zod schemas, no Node-only APIs)
  ├── mapping-store        (external Thread metadata persistence)
  ├── harness-adapter       (Harness abstraction: the contract every Adapter implements;
  │                          exposes a "./testing" subpath for adapter test harnesses)
  ├── desktop-control       (CDP/Electron Inspector-driven Desktop interaction)
  ├── renderer-extension    (browser-injected JS: Agent/Model picker, Composer buttons,
  │                          usage panel — esbuild-bundled to dist/index.js, production.js,
  │                          renderer-binding-probe.js)
  ├── update-manager        (background update preparation)
  └── protocol-core         (depends on harness-adapter + mapping-store + shared-contracts;
                             Host protocol routing/projection — talks to the real app-server)

packages/adapters/{claude-code,pi,grok,omp,deepseek-harness}
  — each depends on harness-adapter + shared-contracts, plus its own native SDK/CLI
    (Claude Code: @anthropic-ai/claude-agent-sdk + MCP SDK; Grok: @agentclientprotocol/sdk;
    DeepSeek: @deepseek-ai/dsh-*). Harness-specific protocol details MUST stay inside the
    owning Adapter — never leak into protocol-core or shared-contracts.

host-runtime — top-level composition root; depends on every adapter, desktop-control,
  harness-adapter, mapping-store, protocol-core, shared-contracts, update-manager, and `ws`.
  This is where the Shim, Adapters, and Desktop control are wired together into a running Host.
```

`tools/check-boundaries.mjs` (run via `npm run lint`) enforces this statically: it walks TS
imports and forbids `renderer-extension` from importing Node builtins/Electron private
APIs/Harness SDKs (e.g. `@anthropic-ai/claude-agent-sdk`, `@agentclientprotocol/sdk`, `electron`),
and generally checks package boundaries. If you add a new cross-package import, this is what will
fail lint if it violates layering — read it before assuming a boundary is just a convention.

### Rust workspace (`crates/`)

Owns native launch, process management, update installation, and platform integration only —
never Host protocol or Harness semantics (that's all TypeScript, in `host-runtime` and below).

- `launcher` (`codexhost-launcher`): produces the `codexhost` and `codexhost-start` binaries —
  native application launch entry points.
- `shim` (`codexhost-shim`): the CLI Shim binary that transparently proxies the official
  app-server; has a `test-utils` feature flag used by `npm run test:rust`.
- `updater` (`codexhost-updater`): update installation; depends on `codexhost-platform`.
- `platform` (`codexhost-platform`): shared Windows/macOS integration library used by the others.

`tools/gate-a/native` is also a Cargo workspace member (for the macOS launch-path gate probes)
but is not a `default-members` package.

### How a session actually runs (brief mental model)

1. `host-runtime` starts the Shim (Rust) which sits in front of the real Codex `app-server` and
   forwards native Codex traffic untouched.
2. `desktop-control` (via CDP) injects `renderer-extension` into the running Codex Desktop window,
   adding the Agent/Model picker, Harness Commands button, and usage panel to the native UI.
3. When a user picks a non-Codex Agent, `protocol-core` routes that Thread's Turns to the matching
   package under `packages/adapters/*` instead of the real Codex Harness.
4. The Adapter talks to its Harness natively (RPC/SDK/CLI), and translates native events back into
   the Host's existing Item/Turn/Interaction projections so Codex Desktop's stock renderer can
   display them without knowing the Harness changed.
5. `mapping-store` persists external-Thread metadata (since these Threads aren't native Codex
   Threads); `update-manager` handles background update prep independently of session traffic.

### Spec-driven changes (`openspec/`)

This repo tracks larger changes as OpenSpec artifacts: `openspec/specs/<capability>/spec.md`
holds the current accepted behavior per capability (e.g.
`harness-adapter-approval-interaction-session`, `external-thread-fork-routing`,
`remote-ssh-harness-host`), and `openspec/changes/<change-id>/` holds in-flight
proposal/design/tasks plus the specs it would add or modify before being archived. When a task
touches behavior that has a matching spec, check it for the already-agreed contract before
changing code.

### Tests layout

- `packages/**/test/**/*.test.ts`, `tools/**/*.test.mjs`, `tests/release/**/*.test.mjs` — vitest
  unit tests (`tests/vitest.config.js`).
- `tests/e2e/*.spec.ts` — Playwright specs against the built renderer.
- `tests/differential/` and `tests/fixtures/{gate-a,gate-c,gate-claude-code}` — fixtures/scripts
  for the `gate:*` npm scripts (differential/live probes comparing against real Codex Desktop /
  Claude Code behavior).
- Rust tests live alongside each crate and run via `cargo test --workspace`.

## Coding conventions (see AGENTS.md for the full list)

- Brand name is always lowercase: `codexhost`.
- TypeScript: Strict Mode + ESLint + Prettier. Rust: rustfmt + Clippy (`-D warnings`).
- Look at existing Adapters/contracts/tests/docs before adding new patterns; don't build a generic
  abstraction for a single caller, and don't add a raw-RPC passthrough for Harness commands.
- Keep changes narrowly scoped — no unrelated refactors, renames, dependency bumps, or reformatting.
- Treat 500 lines as a design-review signal for handwritten modules, ~800 lines as a split signal.
- No wrapper functions that add no domain meaning and have exactly one call site.
- Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `test:`) for commit subjects.
