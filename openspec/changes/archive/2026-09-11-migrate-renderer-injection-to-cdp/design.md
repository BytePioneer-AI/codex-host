## Context

Production Renderer installation currently enters Codex Desktop through the Electron main-process Node Inspector, locates an Electron `webContents`, installs a main-process title wrapper, reloads that `webContents`, and calls `executeJavaScript()` to install the Renderer Extension. Codex Desktop 26.901.20858 ships Electron with `EnableNodeCliInspectArguments` disabled, so `--inspect`, `--inspect-port`, `--inspect-brk`, and `NODE_OPTIONS=--inspect` no longer expose that target.

The same build still accepts a loopback Chromium `--remote-debugging-port`, publishes page targets, and permits `Runtime.evaluate`, `Page.addScriptToEvaluateOnNewDocument`, `Page.bringToFront`, and direct discovery/wrapping of the reviewed React Request Manager. The existing production Renderer bundle and Host routing behavior remain usable once installed.

The current `renderer-control-session.ts` is already above the repository's module-size review signal and is coupled to Electron main-process concepts. The migration therefore introduces a focused Renderer-CDP Session rather than adding another control mode to that module.

## Goals / Non-Goals

**Goals:**

- Restore production GUI injection without modifying or re-signing Codex Desktop.
- Keep the CDP endpoint loopback-only and temporary to the managed Desktop lifecycle.
- Reuse the existing production Renderer bundle and fixed Request Manager bridge.
- Install into the current document and automatically into later documents on the same target.
- Rediscover and reinstall after page-target replacement.
- Preserve non-blocking managed readiness and official Codex fallback while accurately retaining Session installation failure internally.
- Allow external Agent routing without the unavailable main-process title wrapper.

**Non-Goals:**

- Recover Electron main-process access through fuse or application modification.
- Reimplement the main-process automatic-title interception in Renderer code.
- Replace private React/DOM contracts or expose a generic Host bridge.
- Attach to independently started official Desktop instances.
- Redesign the local contract-audit tool's separate read-only main-process inspection mode.

## Decisions

### 1. Launch Chromium Renderer CDP directly

The Launcher will allocate the existing random loopback port but pass `--remote-debugging-port=<port>` to Codex Desktop and pass the corresponding HTTP origin to Desktop Control as a Renderer CDP endpoint.

Alternative: continue trying Node Inspector argument variants. This is rejected because the fuse blocks the entire CLI Inspector capability before argument parsing.

Alternative: patch Electron fuses, preload, or `app.asar`. This is retained only as a manual fallback because it invalidates the official signature and creates update and Gatekeeper risk.

### 2. Add a Renderer-only control Session

A new Desktop Control module will own target discovery, page WebSocket connection, script registration, immediate injection, Request Manager policy installation, binding validation, activation, and target replacement. Production Controller will depend on this module. The legacy Electron Inspector Session remains available to developer tooling that explicitly needs main-process contracts until that tooling is separately migrated.

The selected target must be a `page` whose parsed URL is exactly the primary `app://-/index.html` surface. `avatar-overlay` and every other page are excluded. A live owned target is preferred during recovery; otherwise a currently discoverable primary target is selected.

Alternative: retrofit both main-process and Renderer modes into `renderer-control-session.ts`. This is rejected because it would mix two lifecycles and deepen an already oversized module.

### 3. Register before evaluating immediately

For each selected target, the Session will:

1. enable Runtime and Page domains;
2. call `Page.addScriptToEvaluateOnNewDocument` with the configured production source;
3. evaluate the same source immediately in the current document;
4. install the reviewed draft prewarm/request bridge directly in that Renderer;
5. wait for the production binding to report the exact enabled-Agent set and Adapter readiness.

The Production Controller SHALL prefix the Renderer bundle with Zod's documented global `jitless` configuration before any shared-contract schema module initializes. Direct page execution is subject to Codex Desktop's strict CSP; without this ordering Zod's object-schema JIT probes `Function`, causing every Harness inspection parse to fail even when Host returns a valid response.

Registering first closes the reload race. Immediate evaluation handles a document that was already loaded before the Controller connected. The production bundle's existing idempotent installation semantics handle duplicate evaluation.

### 4. Install draft routing in the Renderer execution context

The existing Request Manager discovery expression and `installDraftPrewarmPolicyBridge` remain authoritative. A direct CDP installer will evaluate discovery and installation in one Renderer expression, preserving object identity without Electron `webContents.debugger` or a general-purpose exposed request method. Ambiguous manager or Host ownership continues to fail closed and is retried only within the existing bounded installation window.

### 5. Treat title isolation as unavailable, not as global Adapter failure

The Renderer Adapter will no longer return `unsupported` solely because `__codexhostMainProcessTitlePolicyV1` is absent. Model target uniqueness, draft routing policy, Host ownership, and fixed control clients remain mandatory. Automatic external-title isolation is explicitly unavailable in this mode; Host-owned external Thread names and normal Desktop fallback behavior remain usable, but the implementation will not claim the old main-process privacy boundary.

Alternative: synthesize the title-ready marker. This is rejected because it would falsely claim a policy that is not installed.

### 6. Preserve compatible-only managed readiness

The Launcher readiness contract remains the repository's strict managed-process readiness (`compatible`, no issues). Renderer Session failure remains an internal recoverable state: no Session object is retained, authenticated attachment cannot claim success, startup trace records a bounded stage, and the Controller retries with existing exponential backoff. This distinguishes managed-process readiness from external Renderer capability readiness without reintroducing the retired compatibility dialog path.

## Risks / Trade-offs

- [Chromium may disable remote debugging in a future update] → Keep the boundary isolated in the new Session and preserve official Codex fallback plus bounded recovery.
- [The debugging port exists for the managed Desktop lifetime] → Use an ephemeral loopback endpoint only, reject non-loopback endpoints in Desktop Control, and never publish it in the runtime descriptor.
- [A new page target may appear between monitor cycles] → Register new-document injection on the owned target and rediscover on every failed/missing binding check.
- [Multiple primary windows may exist] → Prefer the already owned target; on replacement select only from exact primary targets and verify the production binding after installation.
- [External first-turn title text may reach Codex's native title service] → Do not claim title isolation; keep the capability absent and document this migration gap for a later Host-owned title design.
- [Duplicate bundle execution] → Rely on the existing production entry's versioned idempotent binding and validate the exact resulting status.
- [Private Request Manager structure changes] → Reuse the existing reviewed discovery and fail closed on ambiguity.
- [Runtime schema validation probes dynamic code under strict CSP] → Set Zod's official global `jitless` configuration before the production Renderer bundle initializes.

## Migration Plan

1. Add focused direct-CDP draft-policy and Renderer Session tests.
2. Add the Renderer-only Session and export it without deleting legacy Inspector tooling.
3. Point Production Controller at the new Session and rename its internal CLI option to Renderer CDP terminology.
4. Change Launcher managed Desktop arguments to the Chromium remote-debugging port.
5. Remove the Renderer Adapter's title-marker hard gate and update focused tests.
6. Run package tests, TypeScript build, and focused Rust launcher tests.
7. Perform a controlled local launch and contract audit on the installed Codex Desktop.

Rollback consists of reverting the Launcher argument and Production Controller dependency. No persisted data migration is required.

## Open Questions

- A later change must decide whether external automatic titles are generated entirely by Host or whether native title generation is accepted as a documented privacy trade-off.
- The developer contract-audit tool still has a distinct Inspector-backed title inspection path; migrating its read-only mode to Renderer-only evidence is intentionally separate from production startup.
