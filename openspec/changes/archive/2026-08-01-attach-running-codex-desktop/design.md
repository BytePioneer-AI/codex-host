## Context

The production launcher currently performs one process-name/path check and exits whenever Codex Desktop is running. A clean codexhost launch owns a richer process chain: the Desktop inherits the Shim and Host environment, exposes a random loopback Electron Inspector, starts app-server through the Shim, and is monitored together with Desktop Controller. The current Windows machine provides a live example of that chain and proves that a second launcher can discover a running controlled Desktop without modifying it.

CodexPlusPlus uses a per-user launcher guard, invokes Windows packaged application activation again, and attempts CDP injection when Codex already exists. codexhost can adopt the same three-state launch model, but its attachment success condition must include the existing Host/app-server transport in addition to Renderer installation.

The predecessor Gate and production-chain designs rejected every existing Desktop. This change intentionally replaces that launcher decision; existing Harness ownership behavior remains unchanged.

## Goals / Non-Goals

**Goals:**

- Implement exactly three startup states: stale launcher recovery, normal clean launch, and running-Desktop attachment.
- Reuse a healthy codexhost-controlled Desktop without starting or terminating another Desktop.
- Preserve an independently started official Desktop and tell the user to fully quit it before retrying codexhost.
- Keep controlled reuse explicit, minimal, and non-destructive.

**Non-Goals:**

- Do not add stock/degraded/product modes or ask the user to select an Agent before attachment.
- Do not silently restart or terminate a running Desktop when attachment fails.
- Do not modify the official package, `app.asar`, user/system environment, or fixed global debugging configuration.
- Do not redesign HarnessAdapter, Thread ownership, or Protocol Core routing.

## Decisions

### 1. Use a small launcher state machine

Startup classification is limited to:

```text
stale launcher without Desktop/control endpoint -> clean stale state and retry
no Desktop                                  -> existing clean launch
controlled Desktop exists                   -> Controller handshake and activation
official Desktop exists                     -> explicit full-quit instruction
```

The classifier accepts injected observations in tests. It does not branch on selected Agent or expose a degraded mode.

### 2. Publish an atomic runtime descriptor for controlled instances

A clean launcher writes a per-user runtime descriptor only after Desktop, Inspector, Renderer, Controller, and Shim/Host startup readiness have succeeded. The descriptor contains only schema version, launcher PID, random loopback Controller port, and a random attachment nonce. It contains no Desktop PID, Inspector endpoint, Prompt, Thread ID, credentials, project path, or transcript data.

A second launcher does not repeat the owning launcher's Inspector or process-tree checks. The exclusive launcher lock establishes that another owner exists; the nonce-authenticated Controller response establishes that the published control endpoint is live. Invalid or stale descriptors are removed only after the control endpoint and Desktop are absent.

Alternative: infer the endpoint from arbitrary listening ports or process command lines. Rejected because it is ambiguous, expensive, and unnecessary for codexhost-owned instances.

### 3. Reuse a controlled instance through a fixed local attachment handshake

Desktop Controller owns a narrow attachment operation. A second launcher validates the descriptor schema and nonce, asks the owning Controller to ensure the Renderer remains installed, and lets that Controller activate its own Electron window. It does not inspect the Desktop process tree or start a duplicate Desktop, Controller, Host, or Helper.

The Controller reply is the single reuse health result: `ready`, `rejected`, or `failed`. This keeps repeat launch as an activation request while preserving the first launch's full-chain readiness gate.

### 4. Do not bootstrap an independently started official Desktop

When Desktop exists without a live codexhost owner and valid Controller handshake, Launcher returns an explicit instruction to fully quit Codex before retrying. It does not invoke `ApplicationActivationManager`, add Inspector/CDP arguments, inject Renderer controls, start temporary sidecars, or terminate the existing Desktop.

Windows Codex Desktop `26.727.6591.0` proved that packaged second activation and direct execution cannot add an Inspector/CDP endpoint to the existing root. Retaining an always-failing bootstrap would add timeout and process-control complexity without a supported route to Host/app-server rebinding.

Alternative: inject only Renderer controls like CodexPlusPlus. Rejected because the visible external Agent would not have a corresponding Host transport.

### 5. Launcher owns only clean-launch resources

The owning Launcher supervises only the Desktop and sidecars created by its clean launch. A second Launcher sends only the authenticated activation request. An independently started official Desktop remains entirely outside codexhost process ownership.

### 6. Validate real user behavior

Hermetic tests cover classification, descriptor validation, stale cleanup, duplicate invocation, timeout, and ownership cleanup. Real Windows behavior verifies clean launch, controlled repeat/double launch, official reactivation, independently started official Desktop preservation, stale recovery, and user quit without retaining the unsupported bootstrap in production.

## Risks / Trade-offs

- [Independently started official Desktop cannot inherit codexhost process state] -> Instruct the user to fully quit it before retrying; do not attempt partial attachment.
- [Stale descriptor points at an unrelated listener] -> Require a cryptographically random nonce and accept only the fixed Controller response; never send process or user data.
- [Two launchers install competing Controllers] -> The per-user lock leaves one owner; a healthy descriptor routes activation to that owner's Controller, and only unmanaged bootstrap may create a Controller.
- [High-privilege Inspector exposure] -> Use random loopback endpoints, never persist beyond the live runtime descriptor, and validate nonce before control operations.

## Migration Plan

1. Add runtime descriptor schemas, atomic persistence, state classification, and hermetic tests.
2. Add Windows PID-bound window activation and packaged activation support.
3. Add Controller attachment readiness/activation handshake and controlled-instance reuse.
4. Record unmanaged Desktop bootstrap evidence, then remove the unsupported production path.
5. Run focused Rust/TypeScript checks and real Windows user-behavior scenarios.
6. Update the production launcher to reuse controlled instances and explicitly preserve independently started official instances.

Rollback removes the descriptor and controlled-reuse branch and restores the prior clean-launch-only behavior; no persisted product data migration is required.

## Resolved Implementation Evidence

Windows Codex Desktop `26.727.6591.0` preserves the existing root but opens neither a new Node Inspector nor Chromium remote-debugging endpoint for packaged second activation. Directly starting the executable with a new Inspector argument also preserves the root without opening that endpoint. No supported main-process app-server rebuild operation is reachable on this build, so the production bootstrap and its platform surface were removed. The recorded evidence remains the basis for requiring a full quit before clean launch on every platform.
