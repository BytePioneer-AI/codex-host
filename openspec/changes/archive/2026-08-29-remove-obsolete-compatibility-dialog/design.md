## Context

The runtime compatibility policy changed in `504452e` from blocking compatibility outcomes to non-blocking Renderer recovery. The last warning producer was then removed in `4fe8a17`/`53ac330` when minified title-service identities were found to be unstable compatibility signals. Today the production Controller serializes only `{ schemaVersion: 2, state: "compatible", issues: [] }`, while Launcher and platform layers still retain warning parsing, dialogs, acknowledgement persistence, stock/release decisions, and a dedicated `COMPATIBILITY_UPDATE` request.

The normal Settings update flow independently calls the Host update operations and remains active. Runtime Title, Request Bridge, Draft/Prewarm, Composer, Model, and Permission probes also remain active and must not be weakened.

## Goals / Non-Goals

**Goals:**

- Prove the dialog path has no production producer before removing it.
- Reduce the initial Controller readiness protocol to its one currently emitted success shape while preserving strict schema validation.
- Remove the compatibility-dialog-only UI, acknowledgement, decision, and update bridge across Rust and TypeScript.
- Preserve startup failure handling, running-Desktop prompts, stock Desktop helpers that have other callers, Settings updates, runtime compatibility probes, fail-closed routing, and background recovery.
- Align active specifications with the implemented silent compatibility policy.

**Non-Goals:**

- Do not remove or relax CDP/Renderer compatibility probes.
- Do not change recovery timing, Harness routing, official Codex fallback, or controlled-instance attachment.
- Do not remove normal codexhost update operations from Settings.
- Do not add replacement notifications, toasts, or dialogs.
- Do not delete historical archived OpenSpec changes.

## Decisions

### 1. Treat production reachability, not symbol existence, as the deletion criterion

A path is removable only when the production Controller cannot emit a state that enters it and repository-wide callers are limited to that path and its tests. Git history is used to confirm the behavior was intentionally retired rather than accidentally disconnected.

Alternative: retain the code as a future fallback. Rejected because it misstates current product behavior, increases cross-platform maintenance, and can be restored from history if policy changes.

### 2. Keep a strict compatible-only readiness handshake

The Controller and Launcher will continue exchanging one bounded newline-terminated JSON object. The Launcher will accept only schema version 2, state `compatible`, no issues, and no unknown fields. This preserves startup synchronization and malformed-output protection without carrying compatibility decision semantics.

Alternative: replace JSON with a literal `ready` line. Rejected to minimize protocol churn and preserve versioned strictness.

### 3. Remove the complete compatibility-dialog update bridge

`COMPATIBILITY_UPDATE` exists only so the obsolete dialog can check/start an update. Its path through Launcher attachment, Controller server, Renderer Session, Renderer binding, and `compatibility-update.ts` will be removed together. The Settings update client (`checkUpdate`, `startUpdate`, `readUpdateStatus`) remains untouched.

Alternative: keep the command for a potential future launcher UI. Rejected because it has no current caller and couples Launcher startup to Renderer availability contrary to non-blocking readiness.

### 4. Preserve unrelated platform and launch capabilities

Only compatibility-specific portions of macOS, Windows, and Linux UI modules will be removed. Windows running-Desktop and error dialogs remain. The general `launch_stock_desktop` and fixed Releases-page helpers remain available at the platform boundary even though the compatibility dialog no longer calls them; this change does not fold unrelated public API cleanup into the dialog removal.

### 5. Leave legacy acknowledgement files in place

New versions stop reading and writing `compatibility-warning-v1.json`. No migration or deletion is performed because the file is bounded, local, non-secret metadata and deleting user state adds unnecessary filesystem behavior.

## Risks / Trade-offs

- **[Hidden production producer outside the searched workspace]** → The Controller output is built from repository source and release bundle tests cover it; keep strict Launcher parsing so unexpected warning output fails startup rather than silently changing behavior.
- **[Accidentally remove Settings updates]** → Delete only `startCompatibilityUpdate` and `requestCompatibilityUpdate`; verify Settings still references `checkUpdate`, `startUpdate`, and `readUpdateStatus`.
- **[Cross-platform compile regressions]** → Run focused TypeScript tests, Rust workspace checks/tests for Launcher and Platform, and production build/start validation where the local installed Desktop permits it.
- **[Specification history loss]** → Modify active specs through delta artifacts; leave archived changes intact.
- **[Protocol naming remains compatibility-oriented]** → Prefer a minimal behavior cleanup now; broader file/type renaming is optional only where needed to make the compatible-only schema clear.
