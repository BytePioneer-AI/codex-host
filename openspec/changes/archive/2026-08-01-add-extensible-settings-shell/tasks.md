## 1. Extensible Settings Core

- [x] 1.1 Implement bounded settings page definitions, immutable registry validation, deterministic default-page navigation state, and focused pure tests.
- [x] 1.2 Implement the page-scoped AbortSignal and latest-result generation helper with close, navigation, replacement, failure, and disposal tests.

## 2. Isolated Settings UI

- [x] 2.1 Add the window-scoped Shadow DOM dialog, responsive owned stylesheet, bundled Lucide icons, accessible open/close/focus behavior, and deterministic shell cleanup.
- [x] 2.2 Add Overview, Routes, Providers, Credentials, Local Models, and Gateway foundation pages with honest unavailable states and no editable or synthetic Runtime controls.
- [x] 2.3 Add one compact icon-only settings trigger immediately before the verified Codex application-header action group, remove Composer-scoped settings triggers, and preserve the shared shell and Agent/Model state.

## 3. Renderer Lifecycle And Public Extension Points

- [x] 3.1 Install and dispose the settings shell through the shared production/probe Renderer binding lifecycle without changing Adapter, prewarm, title, sidebar, slash, or submission behavior.
- [x] 3.2 Export only the browser-safe registry, page, async-scope, shell, and trigger extension points needed by later method-specific settings pages.
- [x] 3.3 Include the pinned Lucide ISC license in release notices, Payload validation, and Windows package definitions.

## 4. Verification And Baseline Alignment

- [x] 4.1 Add focused Renderer tests for default descriptors, navigation, lifecycle wiring, inaccessible modal handling, duplicate prevention, and cleanup.
- [x] 4.2 Run focused Renderer tests, typecheck, lint, production/probe browser builds, bundle boundary inspection, and strict OpenSpec validation.
- [x] 4.3 Run local Playwright desktop and narrow-viewport screenshots plus a real Codex Desktop header-trigger Gate for layout, scrolling, focus, navigation, close, and non-overlap.
- [x] 4.4 Update the development checklist with the implemented application-header settings boundary and remaining Model Gateway, Credential Manager, secret-entry, and real Desktop Gates.
- [x] 4.5 Align the owned dialog with the reviewed Codex settings visual baseline using screenshot and installed-bundle evidence, then repeat responsive and real Desktop visual checks.
- [x] 4.6 Move the cohesive settings implementation and focused tests into dedicated `src/settings/` and `test/settings/` directories without changing public exports, bundle behavior, or Runtime boundaries.
