# Renderer Agent Binding Probe

This controlled probe validates the version-locked `Codex / Pi` Agent binding in a real Codex Desktop Renderer. It can also expose `Claude Code` as an internal development-only third Agent when both the Host and Renderer gates are explicitly enabled.

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
- installs a narrow Renderer bridge that only clears official local-host prewarms;
- injects the browser-safe Renderer Agent selector and Model-state Adapter;
- installs a tooling-only observer for sanitized submission, switch, and structural diagnostics;
- records the minimal production binding status separately from tooling observations and title-policy counters.

The optional observed Host additionally records schema v2 route evidence:

```text
thread/start → carrier + selected Harness + anonymous create ordinal + purpose
turn/start   → matched ordinal + selected Harness + purpose
```

The probe does not persist Prompt text, input values, Transcript, full DOM, Model values, request IDs, Thread IDs, RPC payloads, URL query/hash values, or screenshots. Reports and logs are written under ignored `.codexhost/` directories.

## Current Result

The public DOM/preload surface still has no stable Agent-to-create binding. The supported build instead uses three version-locked structural policies:

1. The Renderer Adapter uniquely locates the current Composer's optimistic Model atom and writes the internal `codexhost/pi-native` transport token for Pi.
2. The draft prewarm policy recovers the owned official request bridge through CDP and exposes only `clear-prewarmed-threads-for-host({ hostId: "local" })` as a no-argument Renderer operation.
3. The main-process title policy locates `ThreadMetadataGenerationService.generateTitle`; Pi uses the Desktop's local fallback instead of creating an official Codex ephemeral title Thread.

A draft remains switchable while the user edits it. Each Agent change applies the target optimistic Model state and then clears the stale prewarm; Send is disabled until clearing settles. Click, non-composing Enter, or form submission synchronously reapplies and locks the final Agent. Composer replacement uses an opaque React Model target identity: a draft or locked `default → conversation` transition transfers state, a new task or previously unseen conversation starts as Codex, and revisiting a known conversation in the same Renderer process restores its final Agent and locked phase.

The final controlled Gates proved:

```text
Codex → Pi      → stale official create unconsumed; final Pi create matched
Pi → Codex      → stale Pi create deleted locally; final official create matched
Pi → Codex → Pi → repeated stale Pi deletion; final Pi create matched
Pi lazy start   → no Pi process for any unconsumed prewarm
Pi title        → official generation skipped; fallback name updated locally
Codex title     → official ephemeral create and Turn preserved
New task        → codex / draft
Submission      → final Agent locked across default → conversation replacement
Persistence     → codexhost/pi-native absent from Codex configuration
```

Structure mismatch, ambiguous Composer association, missing title ownership, or unsupported assets fail closed. Renderer inspection has a bounded timeout across reloads, and Probe injection waits for metadata-service ownership before marking the primary Renderer ready.

## Run

Build the workspace, then attach to existing loopback endpoints:

```text
npm run probe:renderer-binding -- --endpoint http://127.0.0.1:9222 --inspector-endpoint http://127.0.0.1:9223
```

To start a controlled Desktop instance, also pass an absolute `--desktop` executable path. Use `--until-submissions <count>` for a run that completes after a fixed number of sanitized observations.

Claude Code is part of the default three-Agent list and the Host composition registers its Adapter without a development switch. The Adapter still requires a user-installed and authenticated Claude Code executable; missing installation or authentication fails closed without routing to another Harness.

```text
npm run probe:renderer-binding -- \
  --desktop <absolute-desktop-executable>
```

The runner installs the title policy, reloads the Renderer, verifies metadata-service ownership, installs the narrow draft prewarm policy, marks the Renderer ready, and only then injects the Renderer binding and its tooling-only observer. The schema v2 local report stores production state under `status` and Gate-only observations, switch counters, and structural diagnostics under `observer`.
