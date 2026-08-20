## Why

Grok Build already emits Tool-owned ACP Diff Content, but GrokAdapter currently ignores it and exposes successful edits only as generic Tool executions. codexhost can project reliable Grok file changes into the existing Codex Diff UI without Git inspection, filesystem comparison, or Renderer-specific code.

## What Changes

- Validate successful terminal ACP Diff Content and deterministically serialize its native before/after text as Unified Diff.
- Emit Grok File Change Items after their owning successful Tool and rebuild the same Items from Native history.
- Fail closed to Tool-only projection for provisional, failed, malformed, ambiguous, no-op, or oversized Diff data.
- Add focused parser, live lifecycle, and resume-history coverage.

## Capabilities

### New Capabilities
- `grok-acp-file-change-session`: Defines reliable Tool-owned Grok ACP Diff projection for live and restored Turns.

### Modified Capabilities

None.

## Impact

- Changes `packages/adapters/grok` only, plus focused tests and Grok integration documentation.
- Adds `diff` as a direct Grok Adapter dependency; Host contracts, Protocol Core, Host Runtime, and Renderer remain unchanged.
