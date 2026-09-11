## Why

Editing the only Claude Turn produces an identity with no native transcript. Without durable metadata, closing before resend makes that identity unrecoverable. Native Wrapper shutdown can also outlive the root process.

## What Changes

- Persist empty replacement identity, working directory and configuration in Adapter-owned metadata.
- Exclusively claim native creation and release only unused claims after confirmed shutdown.
- Validate exact native Fork prefixes, including interrupted Turns without assistant output.
- Wait for owned process groups and native background task terminals, propagating shutdown failures.
- Add optional current settings to rollback input, with Host forwarding and Broker validation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-text-session`: durable empty edit recovery and owned resource shutdown.

## Impact

Claude Adapter, rollback input type, Broker validator and Host configuration forwarding. The new fields are optional; existing Adapter declarations remain valid. No mandatory replacementFence or changes to other Harness native lifecycle are introduced.
