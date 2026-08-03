## Why

Claude Code Turns currently execute ordinary Tools without projecting their lifecycle or reliable file changes into Codex Desktop, even though the existing HarnessAdapter and Protocol Core already support generic Tool, Command, File Change, and Turn Diff semantics. The pinned official Claude Agent SDK and prior live Gate provide sufficient structured Tool Use, Tool Result, and native patch evidence to close this calibration gap without adding Claude-specific behavior to Host Runtime or Renderer.

## What Changes

- Map live Claude Assistant Tool Use and matching Tool Result messages into ordered Host Command or Generic Tool Item lifecycles.
- Convert successful Claude Edit and Write native `structuredPatch` output into validated deterministic Unified Patches and Host File Change Items.
- Close active Claude Tool Items before cancelled, failed, or successful Turn completion, including when optional Tool Progress is absent.
- Add focused hermetic coverage for native event validation, Tool correlation, bounded output, reliable File Change provenance, and terminal ordering.
- Keep complete historical Tool restoration, Fork, Renderer changes, and public Claude Code product support outside this change.

## Capabilities

### New Capabilities

- `claude-code-tool-file-change-session`: Defines live Claude Code Tool, Command, reliable File Change, cancellation, and projection behavior through the existing HarnessAdapter contract.

### Modified Capabilities

None.

## Impact

- `packages/adapters/claude-code`: native SDK message interpretation, private transport events, Session Tool state, patch conversion, and tests.
- Existing `@codexhost/harness-adapter` Item contracts and `@codexhost/protocol-core` projection are reused without new public variants.
- The pinned Claude Agent SDK remains the only Claude native integration surface; no dependency or persisted-data migration is introduced.
