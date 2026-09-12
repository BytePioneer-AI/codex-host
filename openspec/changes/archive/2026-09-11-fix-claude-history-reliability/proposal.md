## Why

Native interruption messages are currently projected as extra human Turns. A completed native result can also precede its transcript write, allowing immediate edits to read stale history.

## What Changes

- Attribute native interruption records by prompt identity and message metadata while preserving literal user input.
- Preserve the cancellation checkpoint, including interruptions before any assistant message.
- Wait for the latest completed Turn's known user and checkpoint IDs before returning history; timeout remains retryable.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-text-session`: cancellation history attribution and persistence-aware snapshot reads.

## Impact

Claude Adapter history projection and live Session reads only. No capability, public API or stored schema changes. Native shutdown and durable empty rollback are separate changes.
