## Why

External Harnesses such as Claude Code already publish explicit user-visible reasoning text through the Host `reasoning` Item lifecycle, but current Codex Desktop builds do not provide a reliable inspectable text surface for that projection. For complex tasks this leaves users unable to see the progress summaries that the Harness deliberately exposed.

The feature must remain opt-in. Reasoning may be noisy, and codexhost must not treat hidden, redacted, encrypted, or provider-private chain-of-thought as display content.

## What Changes

- Add a **Show reasoning summaries** switch under codexhost Settings → Model Pool. It is disabled by default and stored as a browser-local boolean preference.
- Subscribe to the existing app-server reasoning Item notifications only while the preference is enabled.
- Render explicit summary text for the active external Harness Thread in a compact panel above the Composer.
- Keep the panel expanded while summary deltas are streaming and collapse it when the reasoning Item completes.
- Confirm Thread ownership before rendering so native Codex Threads retain their stock presentation and do not receive a duplicate panel.
- Never render `content`, encrypted/redacted fields, signatures, inferred text, or arbitrary Assistant messages.
- Keep all display state in memory; do not add a second transcript or persist reasoning text.

## Capabilities

### New Capabilities

- `renderer-reasoning-summary-surface`: opt-in, browser-safe presentation of explicit external Harness reasoning summaries.

### Modified Capabilities

- `harness-reasoning-projection`: allows a bounded opt-in Renderer summary surface when a controlled Desktop has no faithful native reasoning text lane, while retaining the existing native Item projection and privacy boundary.

## Impact

- `packages/renderer-extension`: notification validation/subscription, external ownership gating, in-memory state, Composer-adjacent panel, settings toggle, localization, and tests.
- No Harness Adapter, Mapping Store, Native Session, account configuration, or provider traffic changes.
- No raw reasoning payloads or reasoning text are added to diagnostics, persistence, logs, or shared contracts.
