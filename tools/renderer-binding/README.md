# Renderer Agent Binding Probe

This controlled probe validates the version-locked `Codex / Pi` Agent binding in a real Codex Desktop Renderer.

The current full result is recorded in:

- `docs/CodexRendererAgent绑定验证记录.md`
- `docs/RendererAgent路由阶段验证记录-2026-07-28.md`

## Scope

The runner:

- starts or attaches to Codex Desktop through loopback CDP and the Electron main-process Inspector;
- locates the populated primary Renderer through Electron `webContents`, excluding the avatar overlay;
- installs the version-locked main-process title policy;
- reloads the Renderer so its AppHost metadata service is associated with the owning `webContents`;
- confirms that ownership and writes a non-sensitive title-policy readiness marker into the Renderer;
- injects the browser-safe Renderer Agent selector and Model-state Adapter;
- records sanitized Adapter, Composer, replacement, submission, and title-policy counters.

The optional observed Host additionally records schema v2 route evidence:

```text
thread/start → carrier + selected Harness + anonymous create ordinal + purpose
turn/start   → matched ordinal + selected Harness + purpose
```

The probe does not persist Prompt text, input values, Transcript, full DOM, Model values, request IDs, Thread IDs, RPC payloads, URL query/hash values, or screenshots. Reports and logs are written under ignored `.codexhost/` directories.

## Current Result

The public DOM/preload surface still has no stable Agent-to-create binding. The supported build instead uses two version-locked structural adapters:

1. The Renderer Adapter uniquely locates the current Composer's optimistic Model atom and writes the internal `codexhost/pi-native` transport token for Pi.
2. The main-process title policy locates `ThreadMetadataGenerationService.generateTitle`; Pi uses the Desktop's local fallback instead of creating an official Codex ephemeral title Thread.

Composer replacement uses an opaque React Model target identity. A locked `default → conversation` transition transfers Pi state; a new task or another conversation resets to Codex.

The final controlled Gate proved:

```text
Pi create       → pi-transport / conversation / selectedHarness=pi
Pi first turn   → matched Pi create ordinal
Pi second turn  → same ordinal, no new create, same Pi process
Title policy    → Pi skip count increments, no official ephemeral create
New task        → codex / draft
Created thread  → pi / locked after replacement
Codex create    → official-model / conversation / selectedHarness=codex
Codex turn      → matched Codex create ordinal, no Pi process
Codex title     → official-model / ephemeral / selectedHarness=codex
```

Structure mismatch, ambiguous Composer association, missing title ownership, or unsupported assets fail closed. Renderer inspection has a bounded timeout across reloads, and Probe injection waits for metadata-service ownership before marking the primary Renderer ready.

## Run

Build the workspace, then attach to existing loopback endpoints:

```text
npm run probe:renderer-binding -- --endpoint http://127.0.0.1:9222 --inspector-endpoint http://127.0.0.1:9223
```

To start a controlled Desktop instance, also pass an absolute `--desktop` executable path. Use `--until-submissions <count>` for a run that completes after a fixed number of sanitized observations.

The runner installs the title policy, reloads the Renderer, verifies metadata-service ownership, marks the Renderer ready, and only then injects the Renderer probe.
