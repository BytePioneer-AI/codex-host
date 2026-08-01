## Why

The product baseline requires a codexhost configuration entry inside Codex Desktop, but the current Renderer Extension only mounts Composer-scoped Agent and Model controls. A stable settings shell is needed before Model Gateway, Provider, Route, OAuth, API Key, and local-model features can add UI without each feature inventing another modal, navigation system, or unrestricted request path.

## What Changes

- Add one browser-only, icon-only codexhost settings trigger to the verified Codex application header and open one window-scoped modal settings shell.
- Add isolated, responsive settings styling and accessible dialog, navigation, focus, keyboard, and disposal behavior without depending on Codex private React components.
- Add a typed page registry and settings client port so later capabilities can contribute pages and explicit asynchronous operations without changing the shell or exposing a generic Host request method.
- Provide honest baseline Overview, Routes, Providers, Credentials, Local Models, and Gateway sections that remain unavailable until their owning Runtime capabilities are implemented.
- Keep credentials, network access, filesystem access, Harness SDKs, process control, and persistence outside Renderer Extension.
- Add focused Renderer tests and browser bundle checks for the shell lifecycle, navigation, stale async results, style isolation, and browser-only boundary.

## Capabilities

### New Capabilities

- `extensible-settings-shell`: Defines the in-Codex settings entry, window-scoped modal shell, page registration and navigation contract, explicit asynchronous client boundary, honest unavailable states, accessibility, isolation, and lifecycle behavior.

### Modified Capabilities

None.

## Impact

- `packages/renderer-extension`: new settings shell, resilient application-header trigger, page registry, controller/client port, styles, production installation, exports, and focused tests.
- Renderer browser bundle size and release notices increase by the settings shell and bundled Lucide icon assets; no new Runtime process or application UI is introduced.
- No Mapping Store, Host Runtime, Protocol Core, Harness Adapter, Model Gateway, Credential Manager, or user configuration behavior changes in this foundation.
- The active Pi slash-command change may also extend Renderer installation; both changes must retain independent cleanup and avoid a generic request bridge.
