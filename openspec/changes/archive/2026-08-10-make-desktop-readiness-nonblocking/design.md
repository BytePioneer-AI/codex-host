## Context

The production Desktop Controller currently performs one complete Renderer Control Session installation before it starts its attachment server or publishes readiness. Title Policy, Agent binding, Draft Prewarm, and unclassified inspection failures are converted into four closed compatibility outcomes. The Launcher interprets those outcomes as a reason to stop the Controller and managed Desktop, show a native blocking dialog, and optionally invoke a compatibility update.

This conflates two concerns: managed process-chain availability and optional Renderer integration readiness. The Host already routes requests without an external transport carrier to official Codex, while the Renderer binding already keeps external submission unavailable when its local Adapter prerequisites are not ready. Login, onboarding, and Renderer reload can therefore remain a recoverable Controller state instead of terminating the managed process chain.

The current PRD and `versioned-renderer-agent-routing` main spec explicitly require startup-wide fail-closed behavior. This change intentionally replaces that product decision while preserving point-of-use routing checks.

## Goals / Non-Goals

**Goals:**

- Prevent `title-isolation`, `agent-routing`, `draft-routing`, and `compatibility-detection` failures from being emitted as blocking Launcher compatibility outcomes.
- Keep the managed Desktop, Shim, Host, Launcher, Controller, and authenticated attachment endpoint alive after an initial Renderer installation failure.
- Retry complete Renderer installation in the background and recover after login, reload, webContents replacement, or transient Inspector availability.
- Preserve normal compatible and non-blocking title-warning readiness when the initial installation succeeds.
- Keep external Agent submission unavailable until existing local Model target, Draft prewarm, title ownership, and Adapter checks pass.

**Non-Goals:**

- Treat an unavailable Renderer capability as functionally ready.
- Remove local structure uniqueness checks, transport carrier validation, Thread ownership checks, or submission blocking.
- Guarantee Pi or Claude Code controls while Codex is logged out or its Renderer structure is unavailable.
- Change Host fallback routing, Harness semantics, or normal Settings-based update behavior.
- Add a new user-visible background diagnostic surface.

## Decisions

### 1. Controller installation failure becomes a recoverable internal state

`runDesktopController` will own an optional `RendererControlSession`. It performs the existing initial installation attempt. Success preserves the current compatible or non-blocking title-warning readiness. Failure is retained only as an internal retry condition; the Controller starts its attachment server, publishes ordinary managed readiness, and remains alive.

Alternative: make the Launcher ignore incompatible readiness. Rejected because the Controller currently exits immediately after emitting it, so the Launcher would enter supervision with a dead required process and close the Desktop.

### 2. One serialized operation installs, verifies, activates, and recovers the optional Session

A single Controller operation queue will guard Session creation and use. `ensureSession()` creates a complete Session when none exists. Existing attachment, compatibility-update, shutdown, and monitoring callbacks call through this queue. The monitor catches installation/readiness failures, closes any invalid Session, clears it, and retries with bounded exponential backoff from 30 seconds to 5 minutes instead of exiting the Controller. An authenticated Attachment request may trigger one immediate serialized attempt.

The initial installation retains the existing bounded timeout and transient retry policy. This keeps current successful startup and warning behavior stable. A failed initial attempt can delay first readiness by that bound, but it no longer blocks the eventual managed launch or requires user action.

Alternative: publish readiness before attempting installation. Rejected for this narrow change because it would make the attachment port visible before the Controller can serve the existing Session operations and would eliminate the current startup title warning channel on every launch.

### 3. The four failure results leave the production readiness schema

The TypeScript Controller serializer will accept only `compatible`, `compatible-with-warning`, and the existing non-critical `degraded` shape. It will no longer serialize critical structure issues or `inspection-failed`. Internal `RendererCompatibilityError` remains an implementation signal used to reset and retry a Session, not a Launcher protocol result.

The Rust parser may retain bounded legacy decoding during one release for package skew, but the current production Controller will never emit those four outcomes. Launcher blocking UI and compatibility-update behavior become unreachable from the coherent release payload. Follow-up cleanup may remove legacy native variants after release skew is no longer relevant.

Alternative: delete every native enum and prompt branch immediately. Rejected because it increases cross-platform churn without changing current coherent-package behavior and could turn an accidental package skew into an unstructured parse failure.

### 4. Local fail-closed checks remain point-of-use capability guards

The Renderer Adapter continues to require a unique Composer Model state and target. External Agent switching continues to clear owned Draft prewarm state and marks the Adapter unsupported if clearing fails. Title Policy remains a prerequisite for the Adapter to become ready. Until these conditions pass, external controls remain unavailable or submissions are blocked, while unmarked official Codex requests continue through the Host's fixed Codex fallback.

This separates application availability from external capability availability without guessing a route.

### 5. Compatibility-triggered updates are not invoked for recoverable installation failures

Because the Controller no longer emits incompatible or detection-failed readiness, the Launcher does not invoke the compatibility-specific update path for these failures. The authenticated compatibility-update attachment command remains available for existing non-blocking warning behavior, and the Settings update flow remains unchanged.

## Risks / Trade-offs

- [Initial failure still consumes the existing bounded installation timeout] -> Preserve current success behavior first; a later change can introduce an explicit logged-out signal and earlier background transition with evidence.
- [Managed Codex can run temporarily without external controls] -> Keep official fallback fixed to Codex and never claim external readiness before local guards pass.
- [Repeated full installation can reload the Renderer] -> Serialize retries with 30-second-to-5-minute exponential backoff; successful installation resets the backoff and switches to `ensureInstalled()`.
- [Attachment arrives while no Session exists] -> Serialize an on-demand installation attempt and return the existing bounded attachment failure if it still cannot install.
- [A Session fails after previously becoming ready] -> Close and clear it, keep the Controller alive, and retry rather than terminating the managed Desktop.
- [Legacy Controller emits a removed blocking result] -> Retain strict bounded Rust decoding temporarily, but do not produce such results in current release payloads.

## Migration Plan

1. Change Controller readiness contracts and tests so the four blocking results are no longer serializable or emitted.
2. Refactor production Controller lifecycle around an optional, serialized, recoverable Session.
3. Add focused tests for initial structural failure, unclassified inspection failure, retry recovery, attachment behavior, and post-ready Session loss.
4. Update release bundle assertions and affected Rust tests only where current Controller output changes.
5. Update PRD, engineering baseline, development checklist, and compatibility design to distinguish managed startup from external Renderer readiness.
6. Run focused TypeScript/Rust/release checks and a real logged-out-to-logged-in Desktop Gate.

Rollback restores one-shot initial installation and the four blocking readiness outcomes. No persisted user or Thread data migration is required.

## Open Questions

- A future explicit `waiting-for-login` Renderer signal could remove the initial timeout without suppressing successful startup warnings; it is not required for this change.
