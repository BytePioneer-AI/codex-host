## Why

Grok CLI already auto-compacts long conversations, but GrokAdapter drops those native events. Codex therefore shows context usage collapsing without a Context Compaction Item. Pi already projects the same Host item during a Turn; Grok should reuse that path for passive auto-compaction first.

## What Changes

- Map Grok auto-compaction start/complete/fail/cancel notifications onto the existing `HostContextCompactionItem` lifecycle.
- Project those Items during an active Turn and reconstruct them from Native history.
- Refresh context usage from Grok compact token counts when the compact succeeds.
- Leave manual `/compact` and `x.ai/compact_conversation` out of this change.

## Capabilities

### New Capabilities
- `grok-auto-compaction-session`: Defines live and historical projection of Grok native auto-compaction onto the standard Host Context Compaction Item.

### Modified Capabilities

None.

## Impact

- Changes `packages/adapters/grok` only, plus focused tests and Grok integration documentation.
- Host contracts, Protocol Core, Host Runtime, and Renderer already understand `contextCompaction`; they remain unchanged.
- Manual Grok compact remains a later change.
