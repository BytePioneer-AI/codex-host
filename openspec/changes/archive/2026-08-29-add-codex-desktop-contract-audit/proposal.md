## Why

Codex Desktop updates can change private DOM, React/Fiber state, Electron main-process objects, or request-manager shapes without breaking codexhost compilation or startup. Maintainers need one local, developer-only audit entrypoint that checks every Codex GUI contract consumed by codexhost and produces bounded evidence before deciding whether an upstream update is safe.

## What Changes

- Add a local Codex Desktop contract-audit command that is never invoked by the production Launcher, Controller readiness, Host runtime, or user-facing update path.
- Inventory the semantic Renderer and main-process contracts consumed by Composer, Model, Permission, request/prewarm, title, Settings, Sidebar, Usage/Credits, and Fork integration.
- Run read-only inspection by default against an existing loopback CDP and Electron Inspector endpoint; require an explicit controlled mode before reload, policy installation, or Renderer injection.
- Reuse production discovery and validation logic rather than maintaining a second set of private selectors or Fiber-shape assumptions.
- Emit per-surface `no-impact`, `confirmed-impact`, `possible-impact`, or `unverified` verdicts with sanitized JSON and Markdown reports under ignored `.codexhost/update-impact/` storage.
- Record installed Desktop version/build, Chromium/protocol identity, app.asar integrity, checks that actually ran, and an optional reviewed-baseline comparison without retaining a complete Codex application or full DOM snapshot.
- Extend the existing controlled Renderer binding probe only as the opt-in behavioral tier; do not replace it or weaken production fail-closed behavior.

## Capabilities

### New Capabilities

- `codex-desktop-contract-audit`: Defines the local audit command, semantic contract inventory, read-only and controlled inspection modes, sanitized evidence, baseline comparison, and verdict semantics.

### Modified Capabilities

- `versioned-renderer-agent-routing`: Requires audit-facing inspection to reuse the owning production discovery logic for version-locked Renderer and main-process contracts without changing production routing behavior.

## Impact

- New tooling under `tools/` and a root npm audit command.
- Focused additions to `packages/desktop-control` and `packages/renderer-extension` for reusable, read-only inspection summaries at existing ownership seams.
- Focused tests for argument parsing, schema validation, sanitization, contract classification, and report generation.
- No production startup integration, no user-facing compatibility dialog, no automatic Codex download, no modification of the installed `app.asar`, and no persistence of prompts, transcripts, credentials, IDs, payloads, user paths, or full DOM/source snapshots.
