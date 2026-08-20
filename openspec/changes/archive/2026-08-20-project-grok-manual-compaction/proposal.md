## Why

Grok already auto-compacts and Codex now projects that as a Context Compaction Item, but users still cannot invoke Grok's native `/compact`. Sending `/compact` as a Prompt would be wrong: it is a Harness command, the same way Pi exposes `pi.compact`. Auto-compaction left this slice deferred.

## What Changes

- Register `grok.compact` (`/compact`, optional text) on the Grok Session command catalog.
- Execute it as a temporary projection Turn that reuses the existing `HostContextCompactionItem` lifecycle.
- Translate the command into Grok ACP `x.ai/compact_conversation` rather than a Prompt.
- Route compact notifications that arrive during that request onto the temporary Turn, then refresh usage on success.
- Leave Host, Protocol Core, and Renderer command routing unchanged.

## Capabilities

### New Capabilities
- `grok-manual-compaction-session`: Defines Grok `/compact` command registration, temporary Turn projection, and native `x.ai/compact_conversation` translation.

### Modified Capabilities

None.

## Impact

- Changes `packages/adapters/grok` only, plus focused tests and Grok integration documentation.
- Reuses the existing Harness command catalog, Host command RPC, Composer command popover, and `contextCompaction` projection already used by Pi.
- Does not add Host-owned compaction, Grok slash-command passthrough, or other Grok catalog commands.
