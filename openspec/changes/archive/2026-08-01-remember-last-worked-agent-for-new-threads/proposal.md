## Why

Resetting every new Thread draft to Codex adds repeated Agent switching when the user is actively working with Pi or another enabled Agent. New drafts should follow the Agent used by the most recently submitted Thread without treating passive navigation as work.

## What Changes

- **BREAKING**: Change a new blank Composer's in-process default from always Codex to the Agent used by the most recently submitted Composer.
- Keep Codex as the cold-start default before any Composer has been submitted.
- Do not update the remembered Agent when a Thread is only opened or a draft Agent is switched without submission.
- Keep existing submitted Thread ownership, Fork ownership, and per-Composer Model state behavior unchanged.
- Keep the remembered default process-local; Desktop restart and another Renderer process start from Codex.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `versioned-renderer-agent-routing`: New blank Composers use the most recently submitted Agent in the current Renderer process instead of always resetting to Codex.

## Impact

- `packages/renderer-extension`: Composer Agent state and focused tests.
- `docs/产品需求文档.md`: New Thread default behavior.
- `openspec/specs/versioned-renderer-agent-routing/spec.md`: Composer lifecycle requirements.
- No Host Runtime, Mapping Store, Harness Adapter, transport, or persistence changes.
