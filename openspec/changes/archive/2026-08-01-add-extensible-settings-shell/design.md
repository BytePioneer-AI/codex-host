## Context

The current production Renderer Extension is a browser IIFE installed and restored by Desktop Control. It owns direct-DOM Agent and Model controls, while the versioned Adapter alone touches private Codex React/Fiber state for request routing. There is no settings shell, page composition contract, or credential-safe configuration request path.

The PRD confirms an in-Codex codexhost configuration button for Model, Provider, API Key, OAuth, local models, and default routes, but Model Gateway and Credential Manager are later-stage capabilities. This foundation must provide a real usable UI shell without claiming those Runtime capabilities exist. It must remain browser-only, survive the existing Renderer lifecycle, coexist with the active slash-command change, and avoid the dirty Host Runtime files owned by the current External Thread work.

## Goals / Non-Goals

**Goals:**

- Install one window-scoped codexhost settings dialog and open it through one compact icon-only trigger immediately before the verified Codex application-header action group.
- Provide a polished responsive settings layout with isolated styles, accessible navigation, focus restoration, keyboard close, and deterministic cleanup.
- Define an immutable page registry and page mount contract so later capabilities add cohesive pages without editing shell control flow.
- Give each mounted page a cancellable latest-result async scope that can call a page-owned, method-specific client without exposing a generic Host requester.
- Show honest baseline status for Overview, Routes, Providers, Credentials, Local Models, and Gateway while their owning capabilities are absent.
- Keep the Renderer bundle browser-safe and preserve existing Agent, Model, sidebar, routing, title, and reload behavior.

**Non-Goals:**

- Implementing Model Gateway, Credential Manager, Host Routed Mode, Provider discovery, OAuth, API Key storage, local-model discovery, or configuration persistence.
- Adding Shared Contract, Protocol Core, Host Runtime, Mapping Store, Harness Adapter, or native platform methods in this change.
- Reading existing credentials, accepting secrets, making Provider network requests, or opening OAuth flows in the foundation.
- Reusing Codex private React, Jotai, router, dialog, settings, or icon components.
- Providing a generic `request(method, payload)`, arbitrary URL fetch, arbitrary IPC, or Renderer access to Node.js/Electron.

## Decisions

### 1. Keep one window shell and one application-header trigger

`installRendererBindingProbe()` installs one `RendererSettingsShell` and one resilient header-trigger controller for the current Renderer window. The controller identifies the application header through the observed `data-testid="app-shell-header-context-menu-surface"` surface, selects the bounded right-side native action slot, and inserts one icon-only trigger before the native actions. Existing Renderer mutation scanning remounts it after a Codex header replacement. Disposing the Renderer binding removes both the shell and trigger; Renderer reload continues to rely on Desktop Control's existing reinstall lifecycle.

The trigger is application-scoped rather than Composer- or Thread-scoped. It copies no private React state and uses owned DOM and styling only. If the observed header or a bounded native action slot is unavailable, placement fails closed until a later scan; the implementation does not guess another control, inject into Codex's native Settings route, or overlay a fixed floating button.

Alternative: keep a trigger in every Composer. Rejected because configuration is application-level and the entry becomes unavailable or duplicated with Composer lifecycle.

Alternative: inject into Codex's native Settings page or React router. Rejected because there is no public extension point and configuration UI does not need private Fiber state.

Alternative: place a fixed floating button over the page. Rejected because it can overlap native controls at unknown window sizes.

### 2. Build the shell with direct DOM, native dialog, Shadow DOM, and owned CSS

The shell host is appended to `document.body`, owns a Shadow Root, and renders one native `<dialog>` with a constrained two-column desktop layout and compact single-column navigation at narrow widths. An imported CSS text asset is inserted only into that Shadow Root. The shell reads the document's semantic light/dark theme signal, owns both color palettes, and provides forced-colors system fallbacks; it does not consume Codex private color variables, utility classes, or React components.

The visual baseline is derived from a reviewed screenshot and read-only inspection of the locally installed Codex `26.727.6591.0` Renderer bundle. The owned shell follows the observed 240px navigation rail, centered 768px content column, neutral active state, compact navigation rows, grouped settings cards, and row separators. These measurements are design evidence only: production code copies no Codex source and has no runtime dependency on its private classes, tokens, routes, or components.

The implementation remains framework-free to match the current Renderer Extension and avoid adding a second component runtime for one shell. Selected Lucide icons are bundled and tree-shaken through the browser build; icon creation is scoped to owned elements and never scans or rewrites the Codex document.

Alternative: use Codex's React instance and component library. Rejected because private component identity and context would create another build-specific Adapter surface.

Alternative: use an iframe. Rejected for the foundation because current Desktop CSP/frame behavior is unverified and cross-origin messaging would add a second transport before a credential threat model is decided.

The cohesive settings implementation lives under `packages/renderer-extension/src/settings/`, with focused tests mirrored under `packages/renderer-extension/test/settings/`. Package-level lifecycle composition, public exports, asset declarations, and production entries remain at the Renderer Extension root. This keeps the feature boundary visible without creating a separate workspace package or changing the browser bundle and public API.

### 3. Compose immutable page definitions through a registry

The shell accepts an ordered array of `RendererSettingsPageDefinition` values. Each definition has a bounded kebab-case ID, label, icon name, and `mount(context)` function. Registry construction rejects empty input, duplicate IDs, invalid IDs, and missing default page. The shell owns navigation and active-page state; a page owns only its content subtree and returned cleanup.

The initial registry contains Overview, Routes, Providers, Credentials, Local Models, and Gateway. Their foundation implementations render operational availability rows and do not include editable controls or synthetic configuration values. Later changes replace a placeholder definition at composition time with a page module backed by its own contracts and clients.

The registry is immutable for one installation. Dynamic plugin loading is excluded because codexhost does not currently support third-party Renderer plugins and runtime mutation would complicate ordering and disposal.

### 4. Give pages a cancellable async scope, not a generic request API

A page mount context contains its content root, an `AbortSignal`, and a `runLatest(operation, handlers)` helper. Navigation, close, replacement, and shell disposal abort the active scope. `runLatest` applies success or failure only when the scope and request generation are current; rejected stale operations are ignored, while the page decides how current errors are rendered.

The operation is a closure supplied by the owning page. A future Routes page can close over a `RouteSettingsClient.listRoutes()` method, while a Credentials page can close over separate credential methods. The shell never receives method names, wire payloads, URLs, Native Refs, or secrets and therefore does not become a generic Bridge.

Alternative: define all future Gateway and Credential contracts now. Rejected because their semantics, persistence, and security Gates are not implemented and Shared Contracts require evidence-backed method-specific schemas.

### 5. Treat the foundation as non-sensitive Renderer UI

The initial pages never accept API Keys, OAuth codes, Tokens, filesystem paths, or arbitrary endpoints. Future credential work must decide whether user-entered secrets may transiently enter the official Codex Renderer; this shell and Shadow DOM are not security boundaries. Existing credentials must never be returned to Renderer, and later secret submission requires a separately reviewed Credential Manager contract and threat model.

The shell does not use `localStorage`, IndexedDB, cookies, query strings, clipboard access, or persistent page state. Closing resets the active async page scope; reopening defaults to Overview while the current installation remains otherwise stateless.

### 6. Preserve current routing behavior and verify the browser artifact

Settings open, navigation, and close handlers stop only events originating from owned controls. They do not observe Composer input, modify native Model state, call prewarm clear, register slash commands, inspect Thread identity, or change submission behavior. The settings modules expose no global mutable request client.

Focused tests cover registry validation, active-page state, latest-result cancellation, default-page descriptors, and lifecycle integration points. Browser build checks confirm the production IIFE contains the shell styles/icons without Node.js or Electron imports. A local Playwright smoke page will exercise desktop and narrow layouts because Node-only Vitest has no DOM implementation; this is development evidence rather than a committed second application.

## Risks / Trade-offs

- [Codex replaces or reshapes the application header] -> Re-evaluate the observed semantic surface during existing mutation scans, remount exactly one trigger, and fail closed when a bounded right-side action slot is unavailable.
- [Codex theme tokens change] -> Own light/dark structural palettes and forced-colors fallbacks; observe only semantic document theme signals and do not consume private color variables.
- [Native dialog behavior differs across Electron builds] -> Use the current Chromium-supported API, explicit cancel/close handling, and a controlled browser smoke; mark the trigger unavailable if modal support is absent.
- [Shadow DOM is mistaken for credential isolation] -> Document and test it only as CSS/DOM encapsulation; keep all sensitive fields out of this foundation.
- [Future pages expand one central client] -> Require page-owned method-specific clients and closure composition; the shell only owns cancellable async lifecycle.
- [The active slash change touches installation and Composer behavior] -> Add settings through separate modules and cleanup handles without changing command, Agent, Model, or event interception paths.
- [Renderer bundle size grows] -> Bundle only selected icons and static CSS; inspect build output and avoid a UI framework dependency.

## Migration Plan

1. Add pure registry, navigation state, and async-scope modules with focused tests.
2. Add the Shadow DOM dialog, owned CSS, default placeholder pages, and icon-only settings trigger.
3. Install the window shell and resilient application-header trigger through the existing Renderer binding lifecycle.
4. Export the extension points, update browser build handling for CSS/icon assets, and include the pinned Lucide ISC license in release notices and package definitions.
5. Run focused typecheck, tests, lint, bundle checks, and local Playwright desktop and narrow-viewport smoke screenshots without committing generated output.

Rollback removes the settings modules and trigger integration. No persisted configuration, Host method, Native Session, or migration data requires cleanup.

## Open Questions

- The observed application-header surface and right action group are verified on Windows Codex Desktop `26.727.6591.0`; later Codex DOM changes remain subject to the fail-closed placement rule and real Desktop visual Gates.
- Secret entry inside the official Codex Renderer requires a later explicit threat-model decision; this foundation intentionally cannot collect secrets.
